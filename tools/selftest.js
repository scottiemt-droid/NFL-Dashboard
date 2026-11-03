#!/usr/bin/env node
'use strict';
/* Code-path self-test. Runs the board's own js/data.js + js/venues.js + js/model.js + js/ui.js inside a Node VM
   against a SYNTHETIC fixture (made-up teams "AAA"/"BBB"/..., players "Synthetic WR 2" etc., random stats).
   It checks that selection, the three lines, the blend, injury adjustments, verdicts, weather reads and the
   renderer all run and obey the rules. The fixture is never written to data/ and never shown on the board.
   Usage: node tools/selftest.js [--html out.html]   */

const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const ROOT = path.resolve(__dirname, '..');

const ctx = { console, setTimeout, clearTimeout, setInterval, Intl, Date, Math, JSON, fetch: () => { throw new Error('no network in selftest'); } };
vm.createContext(ctx);
const src = ['js/data.js', 'js/venues.js', 'js/model.js', 'js/ui.js'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
vm.runInContext(src + `
;globalThis.API = { extractBox, parseGamelog, prepareLeague, selectAll, vsJobs, buildBoard, blendCard, verdict, weatherRead, normStatus,
  marketImplied, renderGame, HOME_VENUES, setState: (b, r, w) => { BOARD = b; RAW = r; WX = w; }, W_DEFAULT };`, ctx);
const A = ctx.API;

/* ---- synthetic fixture ---- */
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const ri = (a, b) => Math.floor(a + rnd() * (b - a + 1));
const TEAMS = { 1: 'ATL', 2: 'BUF', 27: 'TB', 12: 'KC' }; // real abbreviations only so venue lookups run; names are synthetic
const tids = Object.keys(TEAMS);
const roster = {}, teams = {};
for (const t of tids) {
  teams[t] = { id: t, abbr: TEAMS[t], name: `Synthetic ${TEAMS[t]}`, short: `Syn ${TEAMS[t]}` };
  roster[t] = [['QB', 2], ['RB', 3], ['WR', 5], ['TE', 2]].flatMap(([p, n]) => Array.from({ length: n }, (_, i) => ({ id: `${t}${p}${i + 1}`, name: `Synthetic ${p} ${i + 1} (${TEAMS[t]})`, pos: p, inj: null })));
}
const boxes = {};
const sched = [];
for (let w = 1; w <= 6; w++) {
  const pairs = w % 3 === 1 ? [['1', '2'], ['27', '12']] : w % 3 === 2 ? [['1', '27'], ['2', '12']] : [['1', '12'], ['2', '27']];
  for (const [h, a] of pairs) sched.push({ w, h, a });
}
let gid = 1000;
for (const { w, h, a } of sched) {
  const id = String(gid++);
  const date = new Date(Date.UTC(2026, 8, 13 + 7 * (w - 1), 17)).toISOString();
  const g = { id, date, season: 2026, stype: 2, week: w, teams: {}, players: [] };
  for (const t of [h, a]) {
    const pl = [];
    const r = roster[t];
    const qb = r.find(x => x.id === `${t}QB1`);
    const pyd = ri(150, 330), ptd = ri(0, 3);
    pl.push({ id: qb.id, n: qb.name, t, p: '', cmp: 20, patt: ri(25, 40), pyd, ptd, int: 0, ratt: ri(1, 6), ryd: ri(0, 40), rtd: 0, rec: 0, tgt: 0, recyd: 0, rectd: 0 });
    const catchers = r.filter(x => x.pos !== 'QB');
    let left = pyd;
    catchers.forEach((c, i) => {
      const yd = i === catchers.length - 1 ? left : Math.min(left, ri(0, Math.round(pyd / 3)));
      left -= yd;
      const isRB = c.pos === 'RB';
      pl.push({ id: c.id, n: c.name, t, p: '', cmp: 0, patt: 0, pyd: 0, ptd: 0, int: 0, ratt: isRB ? ri(i === 0 ? 10 : 2, 20) : 0, ryd: isRB ? ri(10, 110) : 0, rtd: isRB ? ri(0, 1) : 0, rec: ri(0, 8), tgt: ri(1, 10), recyd: yd, rectd: i < 3 ? ri(0, 1) : 0 });
    });
    g.players.push(...pl);
    g.teams[t] = { id: t, ha: t === h ? 'home' : 'away', pts: ri(10, 38), yds: ri(250, 450), pyd: pyd - ri(0, 20), ryd: ri(60, 160), ratt: 25, patt: 33, sk: 2, hasStats: true };
  }
  boxes[id] = g;
}
// statuses: BUF RB1 out (volume redistribution), TB QB1 out (fill-in QB), KC WR2 questionable
roster['2'].find(x => x.id === '2RB1').inj = { status: 'Out', detail: 'Ankle' };
roster['27'].find(x => x.id === '27QB1').inj = { status: 'Injured Reserve', detail: 'Knee' };
roster['12'].find(x => x.id === '12WR2').inj = { status: 'Questionable', detail: 'Hamstring' };
// TB backup QB gets one relief appearance so he has a line 1
boxes['1002'].players.push({ id: '27QB2', n: 'Synthetic QB 2 (TB)', t: '27', p: '', cmp: 4, patt: 7, pyd: 51, ptd: 0, int: 0, ratt: 1, ryd: 3, rtd: 0, rec: 0, tgt: 0, recyd: 0, rectd: 0 });

const week = {
  season: 2026, stype: 2, week: 7, events: [
    { id: 'G1', date: '2026-10-25T17:00:00Z', completed: false, state: 'pre', home: { id: '27', abbr: 'TB' }, away: { id: '2', abbr: 'BUF' }, neutral: false, venue: { name: 'Raymond James Stadium', city: 'Tampa', state: 'FL', indoor: false }, odds: { provider: 'SyntheticBook', details: 'BUF -3.5', total: 47.5 } },
    { id: 'G2', date: '2026-10-25T20:25:00Z', completed: false, state: 'pre', home: { id: '1', abbr: 'ATL' }, away: { id: '12', abbr: 'KC' }, neutral: false, venue: { name: 'Mercedes-Benz Stadium', city: 'Atlanta', state: 'GA', indoor: true }, odds: null }
  ]
};
const raw = { sel: { season: 2026, stype: 2, week: 7 }, week, cutoff: '2026-10-25T17:00:00Z', boxes, teams, rosters: roster, injFeed: {}, injFeedOk: true, injAsOf: new Date().toISOString(), posMap: {}, schemes: null };
// prior-season log: BUF WR1 has two meetings with TB in 2025 and one in 2024 (vs-team n should be 3, newest first)
const vsLogs = { '2WR1': [
  { gid: 'p1', date: '2025-11-02T18:00Z', season: 2025, typ: 'RS', teamId: '2', oppId: '27', pyd: 0, ptd: 0, patt: 0, ratt: 0, ryd: 0, rtd: 0, rec: 6, tgt: 9, recyd: 88, rectd: 1 },
  { gid: 'p2', date: '2025-01-12T18:00Z', season: 2024, typ: 'PO', teamId: '2', oppId: '27', pyd: 0, ptd: 0, patt: 0, ratt: 0, ryd: 0, rtd: 0, rec: 4, tgt: 6, recyd: 41, rectd: 0 },
  { gid: 'p3', date: '2024-10-01T18:00Z', season: 2024, typ: 'RS', teamId: '2', oppId: '27', pyd: 0, ptd: 0, patt: 0, ratt: 0, ryd: 0, rtd: 0, rec: 3, tgt: 5, recyd: 30, rectd: 0 },
  { gid: 'p4', date: '2023-10-01T18:00Z', season: 2023, typ: 'RS', teamId: '2', oppId: '27', pyd: 0, ptd: 0, patt: 0, ratt: 0, ryd: 0, rtd: 0, rec: 9, tgt: 12, recyd: 140, rectd: 2 }
] };

/* ---- run ---- */
const { L, sel } = A.selectAll(raw);
const board = A.buildBoard(raw, L, sel, vsLogs);
const g1 = board.games[0];
const buf = g1.sides['2'], tb = g1.sides['27'];

// ranks 1..4 and per-game values
for (const t of tids) for (const k of ['pts', 'yds', 'ryd', 'pyd']) { assert(L.table[t].off[k].r >= 1 && L.table[t].off[k].r <= 4); assert(L.table[t].def[k].r >= 1); }
// key players: QB1, RB×2, WR×3, TE×1 (or 2), OUT players not projected and on Out line
const slots = s => s.cards.map(c => c.slot).join(',');
assert(/QB1/.test(slots(buf)) && (slots(buf).match(/WR/g) || []).length === 3, 'slots ' + slots(buf));
assert(!buf.cards.some(c => c.pid === '2RB1'), 'OUT RB must not be projected');
assert(buf.outs.some(o => o.pid === '2RB1'), 'OUT RB must be on the Out line');
const bufRB = buf.cards.find(c => c.P === 'RB');
assert(bufRB.mult.ryd > 1 && bufRB.reasons.length, 'RB1 out → remaining RB rushing adjusted');
const bRB = A.blendCard(bufRB, { vt: 50, l5: 25, op: 25 });
assert(bRB.adjusted && bRB.adj.ryd > bRB.base.ryd, 'base vs adjusted shown');
// fill-in QB
const tbQB = tb.cards.find(c => c.P === 'QB');
assert(tbQB.pid === '27QB2' && tbQB.fillIn, 'fill-in QB detected');
assert(tbQB.own.n === 1, 'n=1 own line, never padded');
assert(tb.cards.filter(c => c.P !== 'QB').every(c => c.qbChange), 'receivers carry QB-change note');
// vs-team: last 3 only, newest first, prior seasons included
const bufWR1 = buf.cards.find(c => c.pid === '2WR1');
assert(bufWR1, 'BUF WR1 selected');
assert(bufWR1.vt.n === 3 && bufWR1.vt.rows.every((r, i, a) => !i || a[i - 1].date >= r.date), 'vs-team is last 3, newest first');
assert(!bufWR1.vt.rows.some(r => r.gid === 'p4'), '4th meeting excluded');
// blend default 50/25/25 on a card with all three lines
const b = A.blendCard(bufWR1, { vt: 50, l5: 25, op: 25 });
const exp = 0.5 * bufWR1.vt.avg.recyd + 0.25 * bufWR1.own.avg.recyd + 0.25 * bufWR1.opp.scaled.recyd;
assert(Math.abs(b.base.recyd - exp) < 1e-9, 'blend math');
// n=0 vs-team → renormalized to 50/50
const noVt = buf.cards.find(c => c.vt.n === 0);
if (noVt) { const bb = A.blendCard(noVt, { vt: 50, l5: 25, op: 25 }); assert(bb.renormalized && bb.used.l5 === 50 && bb.used.op === 50); }
// questionable stays projected and flagged
const kc = board.games[1].sides['12'];
const q = kc.cards.find(c => c.pid === '12WR2');
assert(!q || q.st.code === 'QUESTIONABLE', 'questionable flagged');
// statuses
assert(A.normStatus('Injured Reserve') === 'IR' && A.normStatus('Out') === 'OUT' && A.normStatus('Doubtful') === 'DOUBTFUL' && A.normStatus('') === 'CLEARED');
// weather: Atlanta dome is N/A; Tampa outdoor with wind+rain gets a specific read
const atl = A.weatherRead({ ...A.HOME_VENUES.ATL }, null);
assert(/^Weather N\/A \(dome/.test(atl.text), atl.text);
const tpa = A.weatherRead({ ...A.HOME_VENUES.TB }, { temp: 78, feels: 80, wind: 21, windMax: 23, gust: 33, pop: 70, precip: 0.2, snow: 0, code: 63, hours: 4 });
assert(/High wind/.test(tpa.text) && /Rain likely/.test(tpa.text), tpa.text);
assert(/Extreme cold/.test(A.weatherRead({ ...A.HOME_VENUES.GB }, { temp: 8, feels: -5, wind: 5, gust: 9, pop: 0, precip: 0, snow: 0 }).text));
// market implied
const imp = A.marketImplied({ details: 'BUF -3.5', total: 47.5 }, teams, '27', '2');
assert(Math.abs(imp['2'] - 25.5) < 1e-9 && Math.abs(imp['27'] - 22) < 1e-9);
// verdict text format
assert(/vs the #\d+ (pass|rush) defense — /.test(A.verdict(bufWR1, teams).text));
// renderer runs end to end
A.setState(board, raw, { G1: { venue: { ...A.HOME_VENUES.TB }, w: { temp: 78, feels: 80, wind: 21, windMax: 23, gust: 33, pop: 70, precip: 0.2, snow: 0, hours: 4, asOf: new Date().toISOString() }, read: tpa }, G2: { venue: { ...A.HOME_VENUES.ATL }, w: null, read: atl } });
const html = board.games.map(g => A.renderGame(g)).join('');
assert(/Weather N\/A \(dome/.test(html) && /Last 3 vs/.test(html) && /Own last 5/.test(html) && /allowed to WRs/.test(html));
assert(!/NaN|undefined/.test(html), 'no NaN/undefined in render');
console.log(`selftest ok — ${board.games.length} synthetic games, ${board.games.reduce((s, g) => s + Object.values(g.sides).reduce((a, x) => a + x.cards.length, 0), 0)} cards`);

const out = process.argv.indexOf('--html');
if (out > 0) {
  const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*<\/script>/, '')
    .replace('<div id="board"></div>', `<div id="board"><div class="quiet" style="padding:8px">SYNTHETIC SELFTEST FIXTURE — not real data</div>${html}</div>`);
  fs.writeFileSync(process.argv[out + 1], page);
}
