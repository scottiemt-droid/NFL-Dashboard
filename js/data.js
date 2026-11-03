'use strict';
/* Data layer: ESPN public endpoints, Open-Meteo forecasts, the weekly scheme file, and an IndexedDB cache.
   Completed box scores, finished weeks' scoreboards and prior-season game logs never change, so they are cached
   permanently. The week's schedule, market lines, rosters, injury statuses and weather are fetched fresh on every build. */

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const ESPN_WEB = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl';
const METEO = 'https://api.open-meteo.com/v1/forecast';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const CACHE_V = 'v1';

// ESPN's NFL team ids (stable across seasons; relocated clubs kept theirs).
const TEAM_IDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20',
  '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '33', '34'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const Store = (() => {
  let dbp = null;
  const mem = new Map();
  function open() {
    if (!dbp) dbp = new Promise(res => {
      try {
        const r = indexedDB.open('nfl-matchup-board', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
    return dbp;
  }
  async function get(k) {
    if (mem.has(k)) return mem.get(k);
    const db = await open();
    if (!db) return undefined;
    return new Promise(res => {
      try {
        const q = db.transaction('kv').objectStore('kv').get(k);
        q.onsuccess = () => { if (q.result !== undefined) mem.set(k, q.result); res(q.result); };
        q.onerror = () => res(undefined);
      } catch (e) { res(undefined); }
    });
  }
  async function set(k, v) {
    mem.set(k, v);
    const db = await open();
    if (!db) return;
    return new Promise(res => {
      try {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(v, k);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      } catch (e) { res(); }
    });
  }
  return { get, set };
})();

async function fetchJSON(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) return await r.json();
      if (r.status === 404 || r.status === 400) return null;
      last = new Error('HTTP ' + r.status);
    } catch (e) { last = e; }
    await sleep(500 * (i + 1));
  }
  throw new Error('Fetch failed: ' + url + ' (' + (last && last.message) + ')');
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const num = v => { const x = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(x) ? x : 0; };
const splitPair = s => { const m = String(s || '').match(/(-?\d+)\s*[\/-]\s*(-?\d+)/); return m ? [+m[1], +m[2]] : [0, 0]; };

const etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const etDate = iso => etFmt.format(new Date(iso));
const etTime = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET';
function etNowParts() {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(new Date()).forEach(x => p[x.type] = x.value);
  return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute, wd: p.weekday };
}

/* ---------- extraction ---------- */

// The three stat categories the board uses, keyed by ESPN box-score `keys` with label fallbacks.
const BOX_MAP = {
  passing: { 'completions/passingAttempts': 'catt', 'C/ATT': 'catt', passingYards: 'pyd', YDS: 'pyd', passingTouchdowns: 'ptd', TD: 'ptd', interceptions: 'int', INT: 'int' },
  rushing: { rushingAttempts: 'ratt', CAR: 'ratt', rushingYards: 'ryd', YDS: 'ryd', rushingTouchdowns: 'rtd', TD: 'rtd' },
  receiving: { receptions: 'rec', REC: 'rec', receivingYards: 'recyd', YDS: 'recyd', receivingTouchdowns: 'rectd', TD: 'rectd', receivingTargets: 'tgt', TGTS: 'tgt' }
};
const ZERO_LINE = () => ({ cmp: 0, patt: 0, pyd: 0, ptd: 0, int: 0, ratt: 0, ryd: 0, rtd: 0, rec: 0, tgt: 0, recyd: 0, rectd: 0 });

function extractBox(s) {
  const comp = s && s.header && s.header.competitions && s.header.competitions[0];
  if (!comp || !comp.status || !comp.status.type || !comp.status.type.completed) return null;
  const season = s.header.season || {};
  const g = { id: String(s.header.id), date: comp.date, season: season.year, stype: season.type, week: s.header.week, teams: {}, players: [] };
  for (const c of comp.competitors) g.teams[String(c.team.id)] = { id: String(c.team.id), ha: c.homeAway, pts: num(c.score) };
  for (const tb of (s.boxscore && s.boxscore.teams) || []) {
    const t = g.teams[String(tb.team.id)];
    if (!t) continue;
    const m = {};
    for (const st of tb.statistics || []) m[st.name] = st.displayValue != null ? st.displayValue : st.value;
    const [, patt] = splitPair(m.completionAttempts);
    const [sk] = splitPair(m.sacksYardsLost);
    Object.assign(t, { yds: num(m.totalYards), pyd: num(m.netPassingYards), ryd: num(m.rushingYards), ratt: num(m.rushingAttempts), patt, sk, hasStats: m.totalYards != null });
  }
  const byId = {};
  for (const pb of (s.boxscore && s.boxscore.players) || []) {
    const tid = String(pb.team.id);
    for (const cat of pb.statistics || []) {
      const map = BOX_MAP[cat.name];
      if (!map) continue;
      const cols = (cat.keys && cat.keys.length ? cat.keys : cat.labels) || [];
      for (const a of cat.athletes || []) {
        if (!a.athlete) continue;
        const id = String(a.athlete.id);
        let r = byId[id];
        if (!r) r = byId[id] = { id, n: a.athlete.displayName, t: tid, p: (a.athlete.position && a.athlete.position.abbreviation) || '', ...ZERO_LINE() };
        (a.stats || []).forEach((v, i) => {
          const k = map[cols[i]];
          if (!k) return;
          if (k === 'catt') { const [c, at] = splitPair(v); r.cmp = c; r.patt = at; } else r[k] = num(v);
        });
      }
    }
  }
  g.players = Object.values(byId);
  if (!g.players.length) return null;
  return g;
}

// ESPN v3 game log → rows in the same shape as box-score player rows (used for prior-season vs-team meetings).
const GL_NAMES = {
  passingYards: 'pyd', passingTouchdowns: 'ptd', passingAttempts: 'patt', completions: 'cmp', interceptions: 'int',
  rushingAttempts: 'ratt', rushingYards: 'ryd', rushingTouchdowns: 'rtd',
  receptions: 'rec', receivingTargets: 'tgt', receivingYards: 'recyd', receivingTouchdowns: 'rectd'
};
const GL_LABELS = { passing: { YDS: 'pyd', TD: 'ptd', ATT: 'patt', CMP: 'cmp', INT: 'int' }, rushing: { CAR: 'ratt', ATT: 'ratt', YDS: 'ryd', TD: 'rtd' }, receiving: { REC: 'rec', TGTS: 'tgt', TGT: 'tgt', YDS: 'recyd', TD: 'rectd' } };

function gamelogColumns(j) {
  const cols = [];
  if (Array.isArray(j.names) && j.names.length) { j.names.forEach((n, i) => cols[i] = GL_NAMES[n] || null); return cols; }
  // fallback: labels repeat across categories (YDS, TD), so walk them with the category sizes
  const cats = (j.categories || []).filter(c => c && c.count != null);
  if (!cats.length || !j.labels) return null;
  let i = 0;
  for (const c of cats) {
    const m = GL_LABELS[(c.name || '').toLowerCase()] || {};
    for (let k = 0; k < c.count; k++, i++) cols[i] = m[j.labels[i]] || null;
  }
  return cols;
}

function parseGamelog(j, season) {
  if (!j || !j.seasonTypes) return [];
  const cols = gamelogColumns(j);
  if (!cols) return [];
  const seen = new Set(), out = [];
  for (const st of j.seasonTypes || []) {
    const dn = st.displayName || '';
    if (/preseason|pro bowl/i.test(dn)) continue;
    const typ = /postseason/i.test(dn) ? 'PO' : 'RS';
    for (const cat of st.categories || []) {
      for (const ev of cat.events || []) {
        const meta = j.events && j.events[ev.eventId];
        if (!meta || seen.has(ev.eventId)) continue;
        seen.add(ev.eventId);
        const r = { gid: String(ev.eventId), date: meta.gameDate || '', season, typ, teamId: String((meta.team && meta.team.id) || ''), oppId: String((meta.opponent && meta.opponent.id) || ''), ...ZERO_LINE() };
        (ev.stats || []).forEach((v, i) => { const k = cols[i]; if (k) r[k] = num(v); });
        out.push(r);
      }
    }
  }
  return out;
}

/* ---------- loaders ---------- */

async function scoreboard(season, stype, week) {
  const key = `sb:${CACHE_V}:${season}:${stype}:${week}`;
  const c = await Store.get(key);
  if (c) return c;
  const j = await fetchJSON(`${ESPN}/scoreboard?seasontype=${stype}&week=${week}&dates=${season}`);
  const events = ((j && j.events) || []).map(slimEvent);
  const out = { season, stype, week, events };
  if (events.length && events.every(e => e.completed)) await Store.set(key, out); // finished weeks never change
  return out;
}

function slimEvent(e) {
  const c = e.competitions[0];
  const home = c.competitors.find(x => x.homeAway === 'home'), away = c.competitors.find(x => x.homeAway === 'away');
  const o = (c.odds || [])[0];
  const team = x => ({ id: String(x.team.id), abbr: x.team.abbreviation, name: x.team.displayName, short: x.team.shortDisplayName || x.team.name, score: x.score != null ? num(x.score) : null });
  return {
    id: String(e.id), date: e.date, completed: !!(e.status && e.status.type && e.status.type.completed),
    state: e.status && e.status.type && e.status.type.state, statusText: e.status && e.status.type && e.status.type.shortDetail,
    home: team(home), away: team(away), neutral: !!c.neutralSite,
    venue: c.venue ? { name: c.venue.fullName, city: c.venue.address && c.venue.address.city, state: c.venue.address && c.venue.address.state, country: c.venue.address && c.venue.address.country, indoor: c.venue.indoor } : null,
    odds: o ? { provider: (o.provider && (o.provider.displayName || o.provider.name)) || 'Market', details: o.details || null, total: o.overUnder != null ? +o.overUnder : null, spread: o.spread != null ? +o.spread : null } : null
  };
}

// Which week to show: ESPN's current week, rolled forward once every game of it is final.
async function currentWeek() {
  const j = await fetchJSON(`${ESPN}/scoreboard`);
  if (!j || !j.season || !j.week) throw new Error('ESPN scoreboard returned no season/week');
  let season = j.season.year, stype = j.season.type, week = j.week.number;
  if (stype === 1) { stype = 2; week = 1; }
  const evs = (j.events || []);
  if (evs.length && evs.every(e => e.status && e.status.type && e.status.type.completed)) {
    if (stype === 2 && week < 18) week++;
    else if (stype === 2 && week === 18) { stype = 3; week = 1; }
    else if (stype === 3 && week < 5) week++;
  }
  return { season, stype, week };
}

function rosterItems(r) {
  const a = (r && r.athletes) || [];
  return a.some(x => x && Array.isArray(x.items)) ? a.flatMap(x => x.items || []) : a;
}

async function loadRosters(progress) {
  progress('Loading rosters & injury statuses (32 teams)…');
  const teams = {}, rosters = {};
  await pool(TEAM_IDS, 8, async tid => {
    const r = await fetchJSON(`${ESPN}/teams/${tid}/roster`);
    if (r && r.team) teams[tid] = { id: tid, abbr: r.team.abbreviation, name: r.team.displayName, short: r.team.shortDisplayName || r.team.name };
    rosters[tid] = rosterItems(r).map(a => ({
      id: String(a.id), name: a.displayName || a.fullName, pos: (a.position && a.position.abbreviation) || '',
      inj: (a.injuries && a.injuries[0]) ? { status: a.injuries[0].status, date: a.injuries[0].date, detail: a.injuries[0].details ? [a.injuries[0].details.type, a.injuries[0].details.location].filter(Boolean).join(' ') : '' } : null
    }));
  });
  const injFeed = {};
  let injFeedOk = false;
  try {
    const ij = await fetchJSON(`${ESPN}/injuries`);
    for (const tb of (ij && ij.injuries) || []) {
      for (const x of tb.injuries || []) {
        const id = x.athlete && (x.athlete.id || (((x.athlete.links || []).map(l => l.href).join(' ').match(/\/id\/(\d+)/) || [])[1]));
        if (id) injFeed[String(id)] = { status: x.status || (x.type && x.type.description) || '', short: x.shortComment || '', date: x.date };
      }
    }
    injFeedOk = true;
  } catch (e) { /* roster statuses still apply */ }
  return { teams, rosters, injFeed, injFeedOk, injAsOf: new Date().toISOString() };
}

async function loadRaw(sel, progress) {
  const { season, stype, week } = sel;
  progress(`Loading ${season} ${stype === 3 ? 'postseason' : 'week'} ${week}…`);
  const wk = await scoreboard(season, stype, week);
  if (!wk.events.length) return { empty: true, sel };
  const cutoff = wk.events.map(e => e.date).sort()[0]; // every line uses games completed before the week's first kickoff

  // completed games this season before the cutoff
  progress('Loading this season\'s weekly results…');
  const weeks = [];
  if (stype === 2) for (let w = 1; w < week; w++) weeks.push([2, w]);
  else { for (let w = 1; w <= 18; w++) weeks.push([2, w]); for (let w = 1; w < week; w++) weeks.push([3, w]); }
  const sbs = await pool(weeks, 6, ([t, w]) => scoreboard(season, t, w));
  const done = sbs.flatMap(s => s.events).filter(e => e.completed && e.date < cutoff);

  let n = 0;
  const boxes = {};
  await pool(done, 10, async ev => {
    const key = `box:${CACHE_V}:${ev.id}`;
    let b = await Store.get(key);
    if (!b) {
      const s = await fetchJSON(`${ESPN}/summary?event=${ev.id}`);
      b = extractBox(s);
      if (b) await Store.set(key, b);
    }
    if (b) boxes[ev.id] = b;
    n++;
    if (n % 8 === 0 || n === done.length) progress(`Box scores ${n}/${done.length} (cached after first load)…`);
  });

  const R = await loadRosters(progress);
  for (const e of wk.events) for (const t of [e.home, e.away]) if (!R.teams[t.id]) R.teams[t.id] = { id: t.id, abbr: t.abbr, name: t.name, short: t.short };
  for (const b of Object.values(boxes)) for (const tid of Object.keys(b.teams)) if (!R.teams[tid]) R.teams[tid] = { id: tid, abbr: tid, name: tid, short: tid };

  // positions for box-score players not on any current roster (released, retired)
  const posMap = {};
  for (const tid of Object.keys(R.rosters)) for (const a of R.rosters[tid]) posMap[a.id] = a.pos;
  const unknown = [...new Set(Object.values(boxes).flatMap(b => b.players.filter(p => !posMap[p.id] && !p.p && (p.patt || p.ratt || p.tgt || p.rec)).map(p => p.id)))];
  if (unknown.length) progress(`Resolving ${unknown.length} positions for players no longer on a roster…`);
  await pool(unknown, 8, async id => {
    const key = `pos:${CACHE_V}:${id}`;
    let p = await Store.get(key);
    if (p === undefined) {
      let j = null;
      try { j = await fetchJSON(`${ESPN_WEB}/athletes/${id}`); } catch (e) { j = undefined; }
      if (j === undefined) return;
      const a = j && (j.athlete || j);
      p = (a && a.position && a.position.abbreviation) || '';
      await Store.set(key, p);
    }
    if (p) posMap[id] = p;
  });

  let schemes = null;
  try { schemes = await fetchJSON(`data/schemes.json?ts=${Date.now()}`, 1); } catch (e) { schemes = null; }

  return { sel, week: wk, cutoff, boxes, ...R, posMap, schemes, fetchedAt: new Date().toISOString() };
}

// Prior-season game logs, newest season first, stopping once enough meetings with the opponent are found.
async function loadVsTeamLogs(jobs, seasonYear, need, maxBack, progress) {
  const out = {};
  let done = 0;
  await pool(jobs, 8, async ({ pid, oid, have }) => {
    const rows = [];
    let found = have;
    for (let s = seasonYear - 1; s >= seasonYear - maxBack && found < need; s--) {
      const key = `gl:${CACHE_V}:${pid}:${s}`;
      let r = await Store.get(key);
      if (!r) {
        let j = null;
        try { j = await fetchJSON(`${ESPN_WEB}/athletes/${pid}/gamelog?season=${s}`); } catch (e) { j = undefined; }
        if (j === undefined) { out[pid + ':err'] = true; break; }
        r = parseGamelog(j, s);
        await Store.set(key, r);
      }
      rows.push(...r);
      found += r.filter(x => x.oppId === oid).length;
    }
    out[pid] = rows;
    done++;
    if (done % 10 === 0 || done === jobs.length) progress(`Prior-season game logs for vs-team meetings ${done}/${jobs.length} (cached after first load)…`);
  });
  return out;
}

/* ---------- weather ---------- */

async function geocode(city, country) {
  const key = `geo:${CACHE_V}:${city}:${country || ''}`;
  const c = await Store.get(key);
  if (c) return c;
  const j = await fetchJSON(`${GEO}?name=${encodeURIComponent(city)}&count=5&language=en&format=json`);
  const hits = (j && j.results) || [];
  const h = hits.find(x => country && x.country && x.country.toLowerCase() === String(country).toLowerCase()) || hits[0];
  if (!h) return null;
  const out = { lat: h.latitude, lon: h.longitude, label: `${h.name}${h.admin1 ? ', ' + h.admin1 : ''}, ${h.country_code || ''}` };
  await Store.set(key, out);
  return out;
}

// Open-Meteo hourly forecast for the kickoff hour and the ~3.5-hour game window.
async function loadWeather(lat, lon, kickoffIso) {
  const k = new Date(kickoffIso);
  const d0 = k.toISOString().slice(0, 10), d1 = new Date(k.getTime() + 5 * 3600e3).toISOString().slice(0, 10);
  const url = `${METEO}?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,rain,snowfall,wind_speed_10m,wind_gusts_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=UTC&start_date=${d0}&end_date=${d1}`;
  const j = await fetchJSON(url, 2);
  const h = j && j.hourly;
  if (!h || !h.time) return null;
  const t0 = new Date(Math.floor(k.getTime() / 3600e3) * 3600e3);
  const idx = [];
  h.time.forEach((t, i) => { const d = new Date(t + 'Z'); if (d >= t0 && d < new Date(t0.getTime() + 4 * 3600e3)) idx.push(i); });
  if (!idx.length || h.temperature_2m[idx[0]] == null) return null;
  const vals = key => idx.map(i => h[key] && h[key][i]).filter(v => v != null);
  const max = key => { const v = vals(key); return v.length ? Math.max(...v) : null; };
  const sum = key => { const v = vals(key); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  return {
    temp: h.temperature_2m[idx[0]], feels: h.apparent_temperature ? h.apparent_temperature[idx[0]] : null,
    wind: h.wind_speed_10m[idx[0]], windMax: max('wind_speed_10m'), gust: max('wind_gusts_10m'),
    pop: max('precipitation_probability'), precip: sum('precipitation'), snow: sum('snowfall'), code: h.weather_code ? h.weather_code[idx[0]] : null,
    hours: idx.length, asOf: new Date().toISOString()
  };
}
