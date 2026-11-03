#!/usr/bin/env node
'use strict';
/* Builds data/schemes.json: each team's offensive and defensive tendencies for the season, counted from
   nflverse play-by-play (pass rate over expected, shotgun, no-huddle), FTN charting (play-action, motion,
   screens, blitzers, pass rushers, box count) and nflverse participation (personnel, man/zone, coverage shells).
   Fields a source does not carry this season are written as null and shown on the board as "not in source".
   Usage: node tools/build-schemes.js [--season 2026] [--if-stale]   (Node 18+, no installs) */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'schemes.json');
const REL = 'https://github.com/nflverse/nflverse-data/releases/download';
const ABBR = { LA: 'LAR', WAS: 'WSH' }; // nflverse → ESPN

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const now = new Date();
const SEASON = +(arg('--season') || (now.getUTCMonth() >= 2 ? now.getUTCFullYear() : now.getUTCFullYear() - 1));

if (process.argv.includes('--if-stale')) {
  try {
    const j = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (j.season === SEASON && Date.now() - new Date(j.builtAt).getTime() < 6 * 864e5) { console.log('schemes.json is fresh; skipping'); process.exit(0); }
  } catch (e) { /* build */ }
}

async function download(tag, names) {
  for (const n of names) {
    const url = `${REL}/${tag}/${n}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'nfl-matchup-board' } });
      if (!r.ok) { console.log(`  ${r.status} ${url}`); continue; }
      let buf = Buffer.from(await r.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      console.log(`  ok ${url} (${(buf.length / 1e6).toFixed(1)} MB)`);
      return { url, text: buf.toString('utf8') };
    } catch (e) { console.log(`  error ${url}: ${e.message}`); }
  }
  return null;
}

// RFC-4180 CSV → array of objects holding only the wanted columns.
function parseCSV(text, wanted) {
  const rows = [];
  let i = 0, field = '', row = [], q = false;
  const n = text.length;
  let header = null, idx = null;
  const endRow = () => {
    row.push(field); field = '';
    if (!header) { header = row; idx = wanted.map(w => header.indexOf(w)); }
    else if (row.length > 1) { const o = {}; wanted.forEach((w, k) => o[w] = idx[k] >= 0 ? row[idx[k]] : undefined); rows.push(o); }
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
    i++;
  }
  if (field || row.length) endRow();
  return { rows, header: header || [] };
}

const num = v => { if (v == null || v === '' || v === 'NA') return null; const x = +v; return isFinite(x) ? x : null; };
const bool = v => v == null || v === '' || v === 'NA' ? null : (v === '1' || /^true$/i.test(v)) ? 1 : 0;
const mean = a => { const b = a.filter(v => v != null); return b.length ? b.reduce((s, v) => s + v, 0) / b.length : null; };
const share = a => mean(a);

function rankField(teams, side, key, desc = true) {
  const ids = Object.keys(teams).filter(t => teams[t][side][key] != null);
  ids.sort((a, b) => desc ? teams[b][side][key] - teams[a][side][key] : teams[a][side][key] - teams[b][side][key]);
  ids.forEach((t, i) => teams[t][side][key + 'Rank'] = i + 1);
}

const COV = { COVER_0: 'Cover 0', COVER_1: 'Cover 1', COVER_2: 'Cover 2', '2_MAN': 'Cover 2-Man', COVER_3: 'Cover 3', COVER_4: 'Quarters (Cover 4)', COVER_6: 'Cover 6', COVER_9: 'Cover 9', PREVENT: 'Prevent', COMBO: 'Combo' };

(async () => {
  console.log(`Building schemes for ${SEASON}`);
  const pbpF = await download('pbp', [`play_by_play_${SEASON}.csv.gz`, `play_by_play_${SEASON}.csv`]);
  if (!pbpF) { console.error(`No play-by-play file for ${SEASON} — nothing written (no scheme is guessed).`); process.exit(1); }
  const ftnF = await download('ftn_charting', [`ftn_charting_${SEASON}.csv.gz`, `ftn_charting_${SEASON}.csv`]);
  const partF = await download('pbp_participation', [`pbp_participation_${SEASON}.csv.gz`, `pbp_participation_${SEASON}.csv`]);

  const pbp = parseCSV(pbpF.text, ['game_id', 'play_id', 'season_type', 'week', 'posteam', 'defteam', 'play_type', 'pass', 'rush', 'qb_dropback', 'shotgun', 'no_huddle', 'pass_oe', 'qb_kneel', 'qb_spike', 'two_point_attempt']).rows
    .filter(r => (r.play_type === 'pass' || r.play_type === 'run') && r.qb_kneel !== '1' && r.qb_spike !== '1' && r.two_point_attempt !== '1' && r.posteam && r.defteam);
  console.log(`  ${pbp.length} offensive plays`);
  const key = (g, p) => `${g}:${+p}`;
  const ftn = new Map(), part = new Map();
  if (ftnF) for (const r of parseCSV(ftnF.text, ['nflverse_game_id', 'nflverse_play_id', 'is_play_action', 'is_motion', 'is_screen_pass', 'n_blitzers', 'n_pass_rushers', 'n_defense_box']).rows) ftn.set(key(r.nflverse_game_id, r.nflverse_play_id), r);
  let partCols = [];
  if (partF) {
    const P = parseCSV(partF.text, ['nflverse_game_id', 'play_id', 'offense_personnel', 'defense_personnel', 'defense_man_zone_type', 'defense_coverage_type', 'defenders_in_box', 'number_of_pass_rushers']);
    partCols = P.header;
    for (const r of P.rows) part.set(key(r.nflverse_game_id, r.play_id), r);
  }

  const T = {};
  const t = ab => { const a = ABBR[ab] || ab; return T[a] = T[a] || { n: 0, o: { pass: [], proe: [], gun: [], nh: [], pa: [], motion: [], screen: [], pers: {} }, d: { blitz: [], rushers: [], box: [], man: [], cov: {}, dl: {}, dlN: 0, covN: 0 } }; };
  let ftnHits = 0, partHits = 0, maxWeek = 0;
  for (const r of pbp) {
    const O = t(r.posteam), D = t(r.defteam);
    maxWeek = Math.max(maxWeek, (r.season_type === 'REG' ? +r.week : 18 + +r.week) || 0);
    O.n++;
    const db = r.qb_dropback === '1' || r.pass === '1';
    O.o.pass.push(db ? 1 : 0);
    O.o.proe.push(num(r.pass_oe));
    O.o.gun.push(bool(r.shotgun));
    O.o.nh.push(bool(r.no_huddle));
    const f = ftn.get(key(r.game_id, r.play_id));
    if (f) {
      ftnHits++;
      O.o.motion.push(bool(f.is_motion));
      if (db) {
        O.o.pa.push(bool(f.is_play_action));
        O.o.screen.push(bool(f.is_screen_pass));
        const nb = num(f.n_blitzers);
        D.d.blitz.push(nb == null ? null : nb > 0 ? 1 : 0);
        D.d.rushers.push(num(f.n_pass_rushers));
      }
      D.d.box.push(num(f.n_defense_box));
    }
    const p = part.get(key(r.game_id, r.play_id));
    if (p) {
      partHits++;
      const op = p.offense_personnel || '';
      const rb = +((op.match(/(\d+)\s*RB/) || [])[1] || 0), te = +((op.match(/(\d+)\s*TE/) || [])[1] || 0);
      if (op) { const g = `${rb}${te}`; O.o.pers[g] = (O.o.pers[g] || 0) + 1; }
      const dl = (p.defense_personnel || '').match(/(\d+)\s*DL/);
      if (dl) { D.d.dl[dl[1]] = (D.d.dl[dl[1]] || 0) + 1; D.d.dlN++; }
      const mz = p.defense_man_zone_type || '';
      if (/MAN/i.test(mz)) D.d.man.push(1); else if (/ZONE/i.test(mz)) D.d.man.push(0);
      const cv = p.defense_coverage_type;
      if (cv && cv !== 'NA' && db) { D.d.cov[cv] = (D.d.cov[cv] || 0) + 1; D.d.covN++; }
      if (!f) {
        if (db) D.d.rushers.push(num(p.number_of_pass_rushers));
        D.d.box.push(num(p.defenders_in_box));
      }
    }
  }

  const teams = {};
  for (const ab of Object.keys(T)) {
    const x = T[ab];
    const persN = Object.values(x.o.pers).reduce((s, v) => s + v, 0);
    const proe = mean(x.o.proe);
    teams[ab] = {
      n: x.n,
      off: {
        passRate: share(x.o.pass), proe: proe == null ? null : proe / 100, shotgun: share(x.o.gun), noHuddle: share(x.o.nh),
        pa: share(x.o.pa), motion: share(x.o.motion), screen: share(x.o.screen),
        personnel: persN ? Object.entries(x.o.pers).map(([g, v]) => ({ g, pct: v / persN })).sort((a, b) => b.pct - a.pct).slice(0, 4) : null
      },
      def: {
        blitz: share(x.d.blitz), rushers: mean(x.d.rushers), box: mean(x.d.box), man: x.d.man.length ? mean(x.d.man) : null,
        coverage: x.d.covN ? Object.entries(x.d.cov).map(([c, v]) => ({ c: COV[c] || c, pct: v / x.d.covN })).sort((a, b) => b.pct - a.pct).slice(0, 4) : null,
        dl: x.d.dlN ? Object.fromEntries(Object.entries(x.d.dl).map(([k, v]) => [k, v / x.d.dlN])) : null
      }
    };
  }
  for (const k of ['proe', 'pa', 'motion', 'screen', 'shotgun']) rankField(teams, 'off', k);
  for (const k of ['blitz', 'box', 'man']) rankField(teams, 'def', k);
  const N = Object.keys(teams).length, top = r => N >= 16 && r != null && r <= 8, bot = r => N >= 16 && r != null && r >= N - 7;
  const pc = v => Math.round(v * 100) + '%';
  for (const ab of Object.keys(teams)) {
    const o = teams[ab].off, d = teams[ab].def;
    const ob = [];
    if (o.proe != null) ob.push(o.proe >= 0.03 ? 'pass-first' : o.proe <= -0.03 ? 'run-first' : 'balanced');
    if (o.shotgun != null) ob.push(o.shotgun >= 0.75 ? 'shotgun spread' : o.shotgun <= 0.55 ? 'under-center' : 'mixed gun/under-center');
    if (top(o.paRank)) ob.push('play-action heavy');
    if (top(o.motionRank)) ob.push('motion-heavy');
    if (top(o.screenRank)) ob.push('screen-heavy');
    if (o.personnel && o.personnel[0]) ob.push(`base ${o.personnel[0].g} personnel`);
    o.identity = ob.join(', ') || null;
    const db = [];
    if (d.dl) {
      const three = d.dl['3'] || 0, four = (d.dl['4'] || 0);
      d.front = `${three >= four ? '3-down front (3-4 family)' : '4-down front (4-3 family)'} — 4 DL on ${pc(four)} of snaps, 3 DL on ${pc(three)}`;
      db.push(three >= four ? '3-down front' : '4-down front');
    } else d.front = null;
    if (top(d.blitzRank)) db.push('blitz-heavy'); else if (bot(d.blitzRank)) db.push('four-man rush'); else if (d.blitz != null) db.push('mid-pack blitz rate');
    if (d.man != null) db.push(d.man >= 0.4 ? 'man-heavy' : d.man <= 0.25 ? 'zone-heavy' : 'mixed man/zone');
    if (d.coverage && d.coverage[0] && d.coverage[0].pct >= 0.3) db.push(`${d.coverage[0].c} base`);
    if (top(d.boxRank)) db.push('loaded box');
    d.identity = db.join(', ') || null;
  }
  const out = {
    season: SEASON, builtAt: new Date().toISOString(), throughWeek: maxWeek > 18 ? `post ${maxWeek - 18}` : maxWeek, teamCount: N,
    sourceNote: ['nflverse play-by-play', ftnF ? 'FTN charting' : null, partF ? 'nflverse participation' : null].filter(Boolean).join(' + '),
    sources: {
      pbp: { url: pbpF.url, plays: pbp.length },
      ftn: ftnF ? { url: ftnF.url, matchedPlays: ftnHits } : { missing: true },
      participation: partF ? { url: partF.url, matchedPlays: partHits, columns: partCols.filter(c => /personnel|coverage|man_zone|box|rushers/.test(c)) } : { missing: true }
    },
    teams
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`Wrote ${OUT}: ${N} teams, through week ${out.throughWeek}; FTN matched ${ftnHits}, participation matched ${partHits}`);
})().catch(e => { console.error(e); process.exit(1); });
