'use strict';
/* Model layer: league table and ranks, per-position allowed logs, key-player selection, injury statuses,
   the three input lines, the blend, injury volume adjustments, verdicts, scheme and weather reads.
   Pure functions over the raw data from js/data.js — no fetching here, so it also runs in Node for checks. */

const PG = { QB: 'QB', RB: 'RB', FB: 'RB', HB: 'RB', WR: 'WR', TE: 'TE' };
const posGroup = p => PG[String(p || '').toUpperCase()] || null;
const POS_STATS = { QB: ['pyd', 'ptd', 'ryd'], RB: ['ryd', 'rtd', 'rec', 'recyd'], WR: ['rec', 'recyd', 'rectd'], TE: ['rec', 'recyd', 'rectd'] };
const SL = { pyd: 'Pass Yds', ptd: 'Pass TD', ryd: 'Rush Yds', rtd: 'Rush TD', rec: 'Rec', recyd: 'Rec Yds', rectd: 'Rec TD', tgt: 'Tgt', patt: 'Att', ratt: 'Car' };
const SUM_KEYS = ['patt', 'pyd', 'ptd', 'ratt', 'ryd', 'rtd', 'tgt', 'rec', 'recyd', 'rectd'];
// TD shares are too lumpy to measure; each TD stat borrows the share of its yardage stat
const SHARE_OF = { pyd: 'pyd', ptd: 'pyd', ryd: 'ryd', rtd: 'ryd', rec: 'rec', recyd: 'recyd', rectd: 'recyd' };

const SLOTS = { QB: 1, RB: 2, WR: 3, TE: 1 };
const TE2_MIN_TGT = 15;        // a second TE is shown when he drew ≥15 targets in the team's last 5 games (3/g)
const USAGE = { QB: r => r.patt, RB: r => r.ratt + r.tgt, WR: r => r.tgt, TE: r => r.tgt };
const RANK_METRIC = { QB: ['pyd', 'pass yds/g'], RB: ['ryd', 'rush yds/g'], WR: ['recyd', 'rec yds/g'], TE: ['recyd', 'rec yds/g'] };
const ADJ_CAP = 1.5;           // injury volume multiplier cap
const ADJ_MIN_SHARE = 0.03;    // ignore absences worth <3% of the team's volume
const VS_NEED = 3, VS_SEASONS_BACK = 4, OWN_N = 5, OPP_N = 5;

const TEAM_CATS = [['pts', 'Points'], ['yds', 'Yards'], ['ryd', 'Rush yds'], ['pyd', 'Pass yds']];
const POS_ALLOWED = [['QB', 'pyd', 'QB pass yds'], ['RB', 'ryd', 'RB rush yds'], ['RB', 'recyd', 'RB rec yds'], ['WR', 'recyd', 'WR rec yds'], ['TE', 'recyd', 'TE rec yds']];

const zero = () => Object.fromEntries(SUM_KEYS.map(k => [k, 0]));
const add = (a, r) => { for (const k of SUM_KEYS) a[k] += r[k] || 0; return a; };
const avgOf = (rows, keys) => { const o = {}; for (const k of keys) o[k] = rows.length ? rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length : null; return o; };

/* ---------- statuses ---------- */

function normStatus(s) {
  const t = String(s || '').toLowerCase().trim();
  if (!t || t === 'active' || t === 'healthy') return 'CLEARED';
  if (t.startsWith('questionable')) return 'QUESTIONABLE';
  if (t.startsWith('doubtful')) return 'DOUBTFUL';
  if (t.includes('injured reserve') || /^ir\b/.test(t) || t.includes('designated to return')) return 'IR';
  if (t === 'out' || t.includes('physically unable') || t === 'pup' || t.includes('suspen') || t.includes('non-football') || t.includes('exempt') || t.includes('reserve')) return 'OUT';
  if (t.includes('probable') || t.includes('day-to-day')) return 'CLEARED';
  return 'CLEARED';
}
const isOutCode = c => c === 'OUT' || c === 'IR';

/* ---------- league context ---------- */

function prepareLeague(raw) {
  const boxes = Object.values(raw.boxes).sort((a, b) => a.date < b.date ? 1 : -1); // newest first
  const rosterTeam = {}, rosterPos = {}, rosterName = {};
  for (const tid of Object.keys(raw.rosters)) for (const a of raw.rosters[tid]) { rosterTeam[a.id] = tid; rosterPos[a.id] = a.pos; rosterName[a.id] = a.name; }
  const posOf = (id, fallback) => rosterPos[id] || raw.posMap[id] || fallback || '';

  const teamGames = {}, playerRows = {}, names = {};
  for (const b of boxes) {
    const tids = Object.keys(b.teams);
    if (tids.length !== 2) continue;
    const byTeam = {};
    for (const tid of tids) byTeam[tid] = { pos: { QB: zero(), RB: zero(), WR: zero(), TE: zero() }, unknown: zero(), unknownN: 0, rows: [] };
    for (const p of b.players) {
      const P = posGroup(posOf(p.id, p.p));
      const side = byTeam[p.t];
      if (!side) continue;
      side.rows.push(p);
      if (P) add(side.pos[P], p); else if (SUM_KEYS.some(k => p[k])) { add(side.unknown, p); side.unknownN++; }
      names[p.id] = p.n;
    }
    for (const tid of tids) {
      const oid = tids.find(x => x !== tid);
      const T = b.teams[tid], O = b.teams[oid];
      const f = { pts: T.pts, yds: T.yds, pyd: T.pyd, ryd: T.ryd, patt: T.patt, ratt: T.ratt, sk: T.sk };
      const a = { pts: O.pts, yds: O.yds, pyd: O.pyd, ryd: O.ryd, patt: O.patt, ratt: O.ratt, sk: O.sk };
      (teamGames[tid] = teamGames[tid] || []).push({
        gid: b.id, date: b.date, week: b.week, stype: b.stype, oppId: oid, ha: T.ha, f, a, hasStats: T.hasStats && O.hasStats,
        own: byTeam[tid].pos, allowed: byTeam[oid].pos, allowedUnknown: byTeam[oid].unknown, allowedUnknownN: byTeam[oid].unknownN,
        result: T.pts > O.pts ? 'W' : T.pts < O.pts ? 'L' : 'T'
      });
      for (const p of byTeam[tid].rows) (playerRows[p.id] = playerRows[p.id] || []).push({ ...p, gid: b.id, date: b.date, week: b.week, teamId: tid, oppId: oid, season: b.season, typ: b.stype === 3 ? 'PO' : 'RS' });
    }
  }

  // team table: per-game averages, ranked 1–32 (offense: most = #1; defense: fewest allowed = #1)
  const table = {};
  for (const tid of Object.keys(teamGames)) {
    const g = teamGames[tid], gs = g.filter(x => x.hasStats);
    const per = (rows, side, k) => rows.length ? rows.reduce((s, x) => s + (x[side][k] || 0), 0) / rows.length : null;
    const rec = { W: g.filter(x => x.result === 'W').length, L: g.filter(x => x.result === 'L').length, T: g.filter(x => x.result === 'T').length };
    const t = { gp: g.length, rec, off: {}, def: {}, posAllowed: {} };
    for (const [k] of TEAM_CATS) { const rows = k === 'pts' ? g : gs; t.off[k] = { v: per(rows, 'f', k) }; t.def[k] = { v: per(rows, 'a', k) }; }
    for (const [P, k] of POS_ALLOWED) t.posAllowed[P + ':' + k] = { v: g.length ? g.reduce((s, x) => s + x.allowed[P][k], 0) / g.length : null };
    table[tid] = t;
  }
  const rankBy = (get, asc) => {
    const ids = Object.keys(table).filter(t => get(table[t]).v != null);
    const sorted = [...ids].sort((a, b) => asc ? get(table[a]).v - get(table[b]).v : get(table[b]).v - get(table[a]).v);
    sorted.forEach((t, i) => { const v = get(table[t]).v; const first = sorted.findIndex(x => get(table[x]).v === v); get(table[t]).r = first + 1; get(table[t]).of = sorted.length; });
  };
  for (const [k] of TEAM_CATS) { rankBy(t => t.off[k], false); rankBy(t => t.def[k], true); }
  for (const [P, k] of POS_ALLOWED) rankBy(t => t.posAllowed[P + ':' + k], true);

  // positional player ranks (per game, minimum games = half the most games any team has played)
  const maxGp = Math.max(0, ...Object.values(teamGames).map(g => g.length));
  const minGp = Math.max(1, Math.ceil(maxGp / 2));
  const posRank = { QB: [], RB: [], WR: [], TE: [] };
  for (const pid of Object.keys(playerRows)) {
    const rows = playerRows[pid];
    const P = posGroup(posOf(pid, rows[0].p));
    if (!P) continue;
    const played = rows.filter(r => USAGE[P](r) > 0 || r.rec > 0);
    if (played.length < minGp) continue;
    const [k] = RANK_METRIC[P];
    posRank[P].push({ pid, v: played.reduce((s, r) => s + r[k], 0) / played.length, gp: played.length });
  }
  const posRankIx = {};
  for (const P of Object.keys(posRank)) {
    posRank[P].sort((a, b) => b.v - a.v);
    posRank[P].forEach((x, i) => posRankIx[x.pid] = { rank: i + 1, of: posRank[P].length, v: x.v, gp: x.gp });
  }

  return { boxes, teamGames, playerRows, names, table, rosterTeam, rosterPos, rosterName, posOf, posRankIx, minGp, maxGp };
}

function statusOf(raw, pid) {
  const f = raw.injFeed[pid];
  let rawS = f && f.status, detail = f ? f.short : '';
  if (!rawS) {
    for (const tid of Object.keys(raw.rosters)) {
      const a = raw.rosters[tid].find(x => x.id === pid);
      if (a && a.inj) { rawS = a.inj.status; detail = a.inj.detail || ''; break; }
    }
  }
  return { code: normStatus(rawS), raw: rawS || '', detail: detail || '' };
}

/* ---------- key players ---------- */

function teamWindow(L, tid, n = 5) { return (L.teamGames[tid] || []).slice(0, n); }

function selectKeyPlayers(raw, L, tid) {
  const win = teamWindow(L, tid);
  const winIds = new Set(win.map(g => g.gid));
  const winStart = win.length ? win[win.length - 1].date : null;
  const rosterKnown = (raw.rosters[tid] || []).length > 0;
  const cand = {};
  const consider = (pid, name, pos) => {
    const P = posGroup(pos);
    if (!P) return;
    const rows = (L.playerRows[pid] || []);
    const recent = winStart ? rows.filter(r => r.date >= winStart) : [];
    const used = recent.reduce((s, r) => s + USAGE[P](r), 0);
    const played = rows.filter(r => USAGE[P](r) > 0 || r.rec > 0);
    const seasonPer = played.length ? played.reduce((s, r) => s + USAGE[P](r), 0) / played.length : 0;
    const st = statusOf(raw, pid);
    // a starter back from injury has no recent usage; his season rate (×0.8) keeps him in line for a slot
    const ret = !isOutCode(st.code) && played.length >= 2 && recent.length <= Math.max(0, win.length - 3) ? seasonPer * win.length * 0.8 : 0;
    cand[pid] = { pid, name, P, used, score: Math.max(used, ret), returning: ret > used && ret > 0, st, gp: played.length, inWindow: rows.filter(r => winIds.has(r.gid) && r.teamId === tid).length };
  };
  if (rosterKnown) for (const a of raw.rosters[tid]) consider(a.id, a.name, a.pos);
  else for (const pid of Object.keys(L.playerRows)) { const r = L.playerRows[pid][0]; if (r.teamId === tid) consider(pid, r.n, L.posOf(pid, r.p)); }

  const picks = [], outs = [];
  for (const P of ['QB', 'RB', 'WR', 'TE']) {
    const list = Object.values(cand).filter(c => c.P === P && c.score > 0).sort((a, b) => b.score - a.score);
    let need = SLOTS[P];
    if (P === 'TE') { const healthy = list.filter(c => !isOutCode(c.st.code)); if (healthy[1] && healthy[1].used >= TE2_MIN_TGT) need = 2; }
    let k = 0;
    for (const c of list) {
      if (k >= need) break;
      if (isOutCode(c.st.code)) { outs.push({ ...c, slotLost: `${P}${k + 1 + outs.filter(o => o.P === P).length}` }); continue; }
      picks.push({ ...c, slot: `${P}${++k}` });
    }
    // a team with no QB usage on record still gets its rostered, healthy QB (no lines to show, n=0 everywhere)
    if (P === 'QB' && k === 0) {
      const q = (raw.rosters[tid] || []).find(a => posGroup(a.pos) === 'QB' && !isOutCode(statusOf(raw, a.id).code));
      if (q) picks.push({ pid: q.id, name: q.name, P, used: 0, score: 0, st: statusOf(raw, q.id), gp: 0, slot: 'QB1', noUsage: true });
    }
  }
  // the QB who took most of the team's dropbacks in the window, so a fill-in starter can be detected
  const qbWin = Object.values(cand).filter(c => c.P === 'QB').sort((a, b) => b.used - a.used);
  const starter = qbWin[0] && qbWin[0].used > 0 ? qbWin[0] : null;
  // other skill-position players ruled out (not key by usage), listed compactly on the Out line
  const otherOut = (raw.rosters[tid] || []).filter(a => posGroup(a.pos) && !picks.some(p => p.pid === a.id) && !outs.some(o => o.pid === a.id))
    .map(a => ({ pid: a.id, name: a.name, pos: a.pos, st: statusOf(raw, a.id) })).filter(a => isOutCode(a.st.code));
  return { picks, outs, otherOut, starter, win };
}

/* ---------- injury volume adjustment ---------- */

function volumeContext(raw, L, tid, win) {
  const winIds = new Set(win.map(g => g.gid));
  const per = {};
  let rbRush = 0, tgt = 0, qbAtt = 0;
  for (const pid of Object.keys(L.playerRows)) {
    for (const r of L.playerRows[pid]) {
      if (!winIds.has(r.gid) || r.teamId !== tid) continue;
      const P = posGroup(L.posOf(pid, r.p));
      const x = per[pid] = per[pid] || { pid, name: r.n, P, ratt: 0, tgt: 0, patt: 0 };
      x.ratt += r.ratt; x.tgt += r.tgt; x.patt += r.patt;
      if (P === 'RB') rbRush += r.ratt;
      tgt += r.tgt;
      if (P === 'QB') qbAtt += r.patt;
    }
  }
  const out = Object.values(per).filter(x => isOutCode(statusOf(raw, x.pid).code));
  const rbOut = out.filter(x => x.P === 'RB' && x.ratt > 0).map(x => ({ ...x, share: rbRush ? x.ratt / rbRush : 0 }));
  const tgtOut = out.filter(x => x.tgt > 0).map(x => ({ ...x, share: tgt ? x.tgt / tgt : 0 }));
  const qbOut = out.filter(x => x.P === 'QB' && x.patt > 0).map(x => ({ ...x, share: qbAtt ? x.patt / qbAtt : 0 }));
  const sum = a => a.reduce((s, x) => s + x.share, 0);
  const mult = s => s >= ADJ_MIN_SHARE ? Math.min(ADJ_CAP, 1 / Math.max(0.01, 1 - s)) : 1;
  return { rbOut, tgtOut, qbOut, rushMult: mult(sum(rbOut)), tgtMult: mult(sum(tgtOut)), rbShareOut: sum(rbOut), tgtShareOut: sum(tgtOut), games: win.length };
}

/* ---------- the three lines ---------- */

function buildCard(raw, L, pick, tid, oid, vol, starter, vsLogs) {
  const P = pick.P, stats = POS_STATS[P];
  const rows = (L.playerRows[pick.pid] || []);
  const played = rows.filter(r => USAGE[P](r) > 0 || r.rec > 0);

  // line 1: own last 5 (this season, games with a recorded touch/target/dropback)
  const own5 = played.slice(0, OWN_N);
  const own = { rows: own5, n: own5.length, avg: avgOf(own5, stats) };

  // line 2: opponent's last 5 games, totals allowed to this position, scaled by his share
  const og = (L.teamGames[oid] || []).slice(0, OPP_N);
  const oppRows = og.map(g => {
    const v = {};
    for (const k of SUM_KEYS) v[k] = g.allowed[P][k];
    return { gid: g.gid, date: g.date, week: g.week, vsId: g.oppId, unknownN: g.allowedUnknownN, unknownYds: g.allowedUnknown.pyd + g.allowedUnknown.ryd + g.allowedUnknown.recyd, ...v };
  });
  const oppAvg = avgOf(oppRows, SUM_KEYS);
  // his share of his team's production at his position, in the games he played this season (current club only)
  const share = {}, shareN = {};
  const club = played.filter(r => r.teamId === tid);
  for (const s of stats) {
    const k = SHARE_OF[s];
    let mine = 0, team = 0;
    for (const r of club) {
      const g = (L.teamGames[tid] || []).find(x => x.gid === r.gid);
      if (!g) continue;
      mine += r[k]; team += g.own[P][k];
    }
    share[s] = team > 0 ? Math.min(1, mine / team) : null;
    shareN[s] = club.length;
  }
  // QB rushing: a QB's share of team QB rushing can be 0/0; fall back to his passing share
  if (P === 'QB' && share.ryd == null) share.ryd = share.pyd;
  const fillIn = P === 'QB' && starter && starter.pid !== pick.pid && isOutCode(starter.st.code);
  const shareAdj = { ...share };
  if (fillIn) for (const s of stats) shareAdj[s] = 1; // the fill-in starter takes the full QB volume
  const scaled = {}, scaledAdj = {};
  for (const s of stats) {
    scaled[s] = oppRows.length && share[s] != null ? oppAvg[s] * share[s] : null;
    scaledAdj[s] = oppRows.length && shareAdj[s] != null ? oppAvg[s] * shareAdj[s] : null;
  }
  const opp = { rows: oppRows, n: oppRows.length, avg: oppAvg, share, shareN, scaled, scaledAdj, noShare: !club.length };

  // line 3: last 3 vs this opponent — this season's box scores, then prior seasons' game logs (any club, incl. playoffs)
  const cur = rows.filter(r => r.oppId === oid).map(r => ({ ...r, src: 'box' }));
  const prior = ((vsLogs && vsLogs[pick.pid]) || []).filter(r => r.oppId === oid && (USAGE[P](r) > 0 || r.rec > 0)).map(r => ({ ...r, src: 'log' }));
  const vsAll = [...cur, ...prior].sort((a, b) => a.date < b.date ? 1 : -1);
  const vsRows = vsAll.slice(0, VS_NEED);
  const vt = { rows: vsRows, n: vsRows.length, avg: avgOf(vsRows, stats), err: !!(vsLogs && vsLogs[pick.pid + ':err']), seasonsBack: VS_SEASONS_BACK };

  // volume adjustments from teammates ruled out
  const mult = {}, reasons = [];
  for (const s of stats) mult[s] = 1;
  if ((P === 'RB') && vol.rushMult > 1) {
    mult.ryd = mult.rtd = vol.rushMult;
    reasons.push(`RB carries vacated: ${vol.rbOut.map(x => `${x.name} ${Math.round(x.share * 100)}%`).join(', ')} of RB carries in the last ${vol.games} games → rushing ×${vol.rushMult.toFixed(2)}`);
  }
  if (P !== 'QB' && vol.tgtMult > 1) {
    for (const s of ['rec', 'recyd', 'rectd']) if (s in mult) mult[s] = vol.tgtMult;
    reasons.push(`Targets vacated: ${vol.tgtOut.map(x => `${x.name} ${Math.round(x.share * 100)}%`).join(', ')} of team targets in the last ${vol.games} games → receiving ×${vol.tgtMult.toFixed(2)}`);
  }
  if (fillIn) reasons.push(`${starter.name} (${starter.st.code}) took most dropbacks in the last ${vol.games} games → opponent line uses full starter volume (share 100%) instead of his own ${share.pyd != null ? Math.round(share.pyd * 100) + '%' : 'n/a'}`);
  const qbChange = P !== 'QB' && starter && isOutCode(starter.st.code);

  // positional rank and the defense he faces
  const pr = L.posRankIx[pick.pid] || null;
  const defKey = P === 'RB' ? 'ryd' : 'pyd';
  const T = L.table[oid] || null;
  const defRank = T ? T.def[defKey] : null;
  const posAllowedKey = P === 'QB' ? 'QB:pyd' : P === 'RB' ? 'RB:ryd' : `${P}:recyd`;
  const posAllowed = T ? T.posAllowed[posAllowedKey] : null;

  return {
    pid: pick.pid, name: pick.name || L.names[pick.pid], P, pos: L.posOf(pick.pid), slot: pick.slot, tid, oid, stats,
    st: pick.st, returning: pick.returning, noUsage: pick.noUsage, gp: played.length,
    own, opp, vt, mult, reasons, fillIn, qbChange: qbChange ? starter : null,
    rank: pr, defKey, defRank, posAllowedKey, posAllowed
  };
}

/* ---------- blend ---------- */

function blendCard(c, W) {
  const has = o => !!o && c.stats.some(s => o[s] != null && isFinite(o[s]));
  const lines = useAdj => ({
    vt: c.vt.n ? c.vt.avg : null,
    l5: c.own.n ? c.own.avg : null,
    op: c.opp.n ? (useAdj ? c.opp.scaledAdj : c.opp.scaled) : null
  });
  const run = useAdj => {
    const L = lines(useAdj);
    const avail = ['vt', 'l5', 'op'].filter(k => has(L[k]) && W[k] > 0);
    const tot = avail.reduce((s, k) => s + W[k], 0);
    const used = {};
    avail.forEach(k => used[k] = Math.round(100 * W[k] / tot));
    if (!avail.length) return { val: null, used, avail };
    const val = {};
    for (const s of c.stats) {
      let num = 0, den = 0;
      for (const k of avail) { const v = L[k][s]; if (v != null && isFinite(v)) { num += W[k] * v; den += W[k]; } }
      val[s] = den ? num / den : null;
    }
    return { val, used, avail };
  };
  const b = run(false), a = run(true);
  const adjVal = a.val ? Object.fromEntries(c.stats.map(s => [s, a.val[s] == null ? null : a.val[s] * (c.mult[s] || 1)])) : null;
  const adjusted = !!adjVal && (!b.val || c.stats.some(s => Math.abs((adjVal[s] || 0) - (b.val[s] || 0)) > 1e-9));
  const full = ['vt', 'l5', 'op'].filter(k => W[k] > 0);
  return { base: b.val, adj: adjVal, used: a.used, avail: a.avail, adjusted, renormalized: a.avail.length < full.length };
}

/* ---------- verdicts and reads ---------- */

const tierTxt = r => !r ? 'Unranked' : r.rank <= 5 ? 'Top-5' : r.rank <= 12 ? 'Top-12' : r.rank <= 24 ? 'Top-24' : `#${r.rank}`;
function verdict(c, teams) {
  const P = c.P, r = c.rank, d = c.defRank;
  const dName = c.defKey === 'ryd' ? 'rush' : 'pass';
  if (!d || d.r == null) return { cls: 'neu', text: `${tierTxt(r)} ${P} — opponent defense not ranked yet (n=0 games)` };
  const big = d.of >= 16; // top-8 / bottom-8 only mean something once most of the league is ranked
  const elite = r && r.rank <= 12, soft = big && d.r >= d.of - 7, tough = big && d.r <= 8;
  let read, cls;
  if (elite && soft) { read = 'mismatch in his favor'; cls = 'up'; }
  else if (elite && tough) { read = 'strength vs strength'; cls = 'neu'; }
  else if (!elite && soft) { read = 'soft matchup'; cls = 'up'; }
  else if (!elite && tough) { read = 'tough draw'; cls = 'down'; }
  else { read = 'neutral matchup'; cls = 'neu'; }
  return { cls, text: `${tierTxt(r)} ${P}${r ? '' : ' (below min games)'} vs the #${d.r} ${dName} defense — ${read}` };
}

const pct = v => v == null ? 'n/a' : Math.round(v * 100) + '%';

function defenseRead(c, L, schemes, teams) {
  const oid = c.oid, T = L.table[oid], S = schemes && schemes.teams && schemes.teams[teams[oid] && teams[oid].abbr];
  const D = S && S.def, bits = [];
  const pa = c.posAllowed;
  const paTxt = pa && pa.v != null ? `allows ${Math.round(pa.v)} ${c.posAllowedKey.replace(':', ' ').replace('pyd', 'pass yds').replace('ryd', 'rush yds').replace('recyd', 'rec yds')}/g (#${pa.r} of ${pa.of}, 1 = fewest)` : 'no positional sample';
  if (c.P === 'QB') {
    if (D && D.blitz != null) bits.push(D.blitzRank <= 8 ? `blitzes a lot (${pct(D.blitz)} of dropbacks, #${D.blitzRank} most) — pressure speeds up his clock; sack/turnover risk, short-area volume up` :
      D.blitzRank >= 25 ? `rarely blitzes (${pct(D.blitz)}, #${D.blitzRank}) — rushes four and drops seven; time to throw but tighter windows` : `blitzes at a middling rate (${pct(D.blitz)}, #${D.blitzRank})`);
    if (D && D.man != null) bits.push(D.man >= 0.4 ? `man-heavy (${pct(D.man)} man)` : D.man <= 0.25 ? `zone-heavy (${pct(1 - D.man)} zone)` : `mixed man/zone (${pct(D.man)} man)`);
  } else if (c.P === 'RB') {
    if (D && D.box != null) bits.push(D.boxRank <= 8 ? `loads the box (${D.box.toFixed(2)} avg defenders, #${D.boxRank} most) — lanes tight, check-downs available` : D.boxRank >= 25 ? `light boxes (${D.box.toFixed(2)} avg, #${D.boxRank}) — numbers favor the run` : `average box count (${D.box.toFixed(2)})`);
  } else {
    if (D && D.man != null) bits.push(D.man >= 0.4 ? `man-heavy (${pct(D.man)}) — ${c.P === 'WR' ? 'outside WRs face isolation on their corner' : 'TE likely matched by a LB/S'}` : D.man <= 0.25 ? `zone-heavy (${pct(1 - D.man)} zone) — volume flows to the soft spots underneath and the slot` : `mixed man/zone (${pct(D.man)} man)`);
    if (D && D.blitz != null && D.blitzRank <= 8) bits.push(`blitzes ${pct(D.blitz)} (#${D.blitzRank}) — hot/quick routes come open, ${c.P === 'TE' ? 'TE may be kept in to block' : 'fewer deep shots'}`);
  }
  if (!D) bits.push('scheme file not loaded — tendencies not shown');
  return { paTxt, line: bits.join('; ') };
}

/* ---------- schemes ---------- */

function schemeMatchupLine(offAbbr, defAbbr, schemes, L, oid, did) {
  const S = schemes && schemes.teams;
  const O = S && S[offAbbr] && S[offAbbr].off, D = S && S[defAbbr] && S[defAbbr].def;
  if (!O || !D) return null;
  const clashes = [];
  const n = (schemes.teamCount || 32), top = r => r != null && r <= 8, bot = r => r != null && r >= n - 7;
  if (top(D.blitzRank) && top(O.screenRank)) clashes.push(`blitz-heavy D (${pct(D.blitz)}) vs a screen-heavy O (${pct(O.screen)} screens) — screens and quick game punish extra rushers`);
  else if (top(D.blitzRank) && top(O.paRank)) clashes.push(`blitz-heavy D (${pct(D.blitz)}) vs a play-action O (${pct(O.pa)} PA) — big-play variance both ways`);
  else if (top(D.blitzRank)) clashes.push(`blitz-heavy D (${pct(D.blitz)}, #${D.blitzRank}) vs a ${O.identity || 'balanced'} O — hot reads and protection decide it`);
  if (bot(D.blitzRank) && D.man != null && D.man <= 0.25 && O.proe != null && O.proe > 0.02) clashes.push(`four-man rush + zone vs a pass-first O — must sustain drives underneath`);
  if (O.proe != null && O.proe < -0.02) {
    const rr = L.table[did] && L.table[did].def.ryd;
    if (D.boxRank != null && top(D.boxRank)) clashes.push(`run-leaning O into a loaded box (${D.box.toFixed(2)} avg)`);
    else if (rr && rr.r >= rr.of - 7) clashes.push(`run-leaning O vs a bottom-8 rush D (#${rr.r})`);
  }
  if (D.man != null && D.man >= 0.4 && top(O.motionRank)) clashes.push(`heavy motion (${pct(O.motion)}) vs a man-heavy D (${pct(D.man)} man) — motion reveals coverage and creates rubs`);
  if (!clashes.length) clashes.push('no strong tendency clash');
  return `${offAbbr} O (${O.identity || '?'}) vs ${defAbbr} D (${D.identity || '?'}): ${clashes.slice(0, 2).join('; ')}`;
}

/* ---------- weather read ---------- */

const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
function weatherRead(venue, w) {
  if (!venue) return { na: true, text: 'Venue unknown — weather not placed' };
  if (['dome', 'retractable', 'canopy'].includes(venue.roof)) return { na: true, text: `Weather N/A (dome${venue.roof !== 'dome' ? ' — ' + ROOF_TXT[venue.roof] : ''})` };
  if (venue.lat == null) return { na: true, text: 'Venue could not be located — no forecast shown' };
  if (!w) return { na: true, text: 'Forecast not available yet for kickoff (Open-Meteo covers ~16 days ahead)' };
  const tilts = [];
  const wm = Math.max(w.wind || 0, w.windMax || 0), g = w.gust || 0;
  if (wm >= 20 || g >= 35) tilts.push(`High wind (${Math.round(wm)} mph, gusts ${Math.round(g)}) — hurts the deep passing game and kicking; expect more runs and short throws`);
  else if (wm >= 15 || g >= 25) tilts.push(`Breezy (${Math.round(wm)} mph, gusts ${Math.round(g)}) — some drag on deep balls and long field goals`);
  const snowy = (w.snow || 0) >= 0.1 || (SNOW_CODES.has(w.code) && (w.pop || 0) >= 40);
  if (snowy) tilts.push(`Snow expected — favors the run game and ball security; footing slows routes and shortens passes`);
  else if ((w.pop || 0) >= 60 || (w.precip || 0) >= 0.1) tilts.push(`Rain likely (${Math.round(w.pop || 0)}%) — favors the run game, ball security and shorter passes; fumble/drop risk up`);
  else if ((w.pop || 0) >= 40) tilts.push(`Rain possible (${Math.round(w.pop)}%) — watch for a wet ball`);
  const feels = w.feels != null ? w.feels : w.temp;
  if (w.temp <= 20 || feels <= 10) tilts.push(`Extreme cold (${Math.round(w.temp)}°F, feels ${Math.round(feels)}°F) — tends to suppress scoring; harder to grip and kick`);
  else if (w.temp <= 32) tilts.push(`Freezing (${Math.round(w.temp)}°F) — mild drag on passing efficiency and kicking`);
  if (w.temp >= 88) tilts.push(`Heat (${Math.round(w.temp)}°F) — fatigue late; depth matters`);
  return { na: false, text: tilts.length ? tilts.join(' · ') : 'Conditions neutral — no weather tilt expected', tilt: tilts.length > 0 };
}

/* ---------- projected score ---------- */

function projectScore(L, home, away) {
  const H = L.table[home], A = L.table[away];
  if (!H || !A || !H.gp || !A.gp) return null;
  const h = (H.off.pts.v + A.def.pts.v) / 2, a = (A.off.pts.v + H.def.pts.v) / 2;
  return { home: h, away: a, total: h + a, margin: h - a };
}

function marketImplied(odds, teams, home, away) {
  if (!odds || odds.total == null || !odds.details) return null;
  const d = odds.details.trim();
  if (/^(even|pk|pick)/i.test(d)) return { [home]: odds.total / 2, [away]: odds.total / 2 };
  const m = d.match(/^([A-Z]{2,4})\s+(-?\d+(\.\d+)?)$/);
  if (!m) return null;
  const fav = [home, away].find(t => teams[t] && teams[t].abbr === m[1]);
  if (!fav) return null;
  const s = Math.abs(+m[2]), dog = fav === home ? away : home;
  return { [fav]: (odds.total + s) / 2, [dog]: (odds.total - s) / 2 };
}

/* ---------- board ---------- */

function selectAll(raw) {
  const L = prepareLeague(raw);
  const sel = {};
  for (const ev of raw.week.events) for (const t of [ev.home.id, ev.away.id]) sel[t] = selectKeyPlayers(raw, L, t);
  return { L, sel };
}

// Jobs for prior-season game logs: each key player vs this week's opponent, skipping players already at 3 meetings.
function vsJobs(raw, L, sel) {
  const jobs = [];
  for (const ev of raw.week.events) {
    for (const [tid, oid] of [[ev.home.id, ev.away.id], [ev.away.id, ev.home.id]]) {
      for (const p of sel[tid].picks) {
        const have = (L.playerRows[p.pid] || []).filter(r => r.oppId === oid).length;
        if (have < VS_NEED) jobs.push({ pid: p.pid, oid, have });
      }
    }
  }
  return jobs;
}

function buildBoard(raw, L, sel, vsLogs) {
  const T = raw.teams;
  const games = raw.week.events.slice().sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0).map(ev => {
    const home = ev.home.id, away = ev.away.id;
    const sides = {};
    for (const [tid, oid] of [[away, home], [home, away]]) {
      const S = sel[tid];
      const vol = volumeContext(raw, L, tid, S.win);
      const cards = S.picks.map(p => buildCard(raw, L, p, tid, oid, vol, S.starter, vsLogs));
      sides[tid] = { tid, oid, cards, outs: S.outs, otherOut: S.otherOut, starter: S.starter, vol, table: L.table[tid] || null };
    }
    const sch = raw.schemes;
    return {
      id: ev.id, date: ev.date, ev, home, away, sides,
      proj: projectScore(L, home, away), implied: marketImplied(ev.odds, T, home, away),
      scheme: sch ? [schemeMatchupLine(T[away].abbr, T[home].abbr, sch, L, away, home), schemeMatchupLine(T[home].abbr, T[away].abbr, sch, L, home, away)] : null
    };
  });
  return { games, L, teams: T, sel: raw.sel, cutoff: raw.cutoff, boxCount: L.boxes.length };
}
