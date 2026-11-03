'use strict';
/* UI layer: renders the week board; blend weights are live (re-render only, no refetch).
   Injury statuses and forecasts are re-pulled every 30 minutes while the page is open. */

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f0 = v => v == null || !isFinite(v) ? '–' : String(Math.round(v));
const f1 = v => v == null || !isFinite(v) ? '–' : (Math.round(v * 10) / 10).toFixed(1);
const f2 = v => v == null || !isFinite(v) ? '–' : (Math.round(v * 100) / 100).toFixed(2);
const fmtStat = (s, v) => /td$/.test(s) ? f2(v) : s === 'rec' ? f1(v) : f0(v);
const md = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/New_York' }) : '';
const mdy = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit', timeZone: 'America/New_York' }) : '';
const nTag = (n, full) => `<span class="badge ${n < full ? 'b-warn' : 'b-n'}">n=${n}</span>`;
const MOD = '<span class="badge b-mod">MODELED</span>';
const MEAS = '<span class="badge b-n">MEASURED</span>';

const W_DEFAULT = { vt: 50, l5: 25, op: 25 };
let W = { ...W_DEFAULT };
try { const s = JSON.parse(localStorage.getItem('nfl-board-weights') || 'null'); if (s && ['vt', 'l5', 'op'].every(k => typeof s[k] === 'number')) W = s; } catch (e) { }

let BOARD = null, RAW = null, WX = {}, SEL = null, FOLLOW_CURRENT = true, BUILDING = false, LAST_BUILD = null;

function setStatus(t) { $('#status').textContent = t; }
const weekLabel = s => s ? `${s.season} ${s.stype === 3 ? 'Postseason round' : 'Week'} ${s.week}` : '';

/* ---------- build ---------- */

async function build(sel, quiet) {
  if (BUILDING) return;
  BUILDING = true;
  try {
    if (!sel) sel = await currentWeek();
    SEL = sel;
    $('#wk').textContent = weekLabel(sel);
    if (!quiet) { $('#board').innerHTML = ''; $('#nav').innerHTML = ''; }
    const raw = await loadRaw(sel, setStatus);
    if (raw.empty) {
      BOARD = null;
      $('#board').innerHTML = `<div class="quiet">No games found for ${esc(weekLabel(sel))}.</div>`;
      setStatus(`Checked ${new Date().toLocaleTimeString()} — no games.`);
      return;
    }
    setStatus('Selecting key players…');
    const { L, sel: picks } = selectAll(raw);
    const jobs = vsJobs(raw, L, picks);
    const vsLogs = await loadVsTeamLogs(jobs, sel.season, VS_NEED, VS_SEASONS_BACK, setStatus);
    setStatus('Building board…');
    RAW = raw;
    BOARD = buildBoard(raw, L, picks, vsLogs);
    setStatus('Loading venue forecasts…');
    WX = {};
    await pool(BOARD.games, 6, async g => {
      const venue = await resolveVenue(g.ev, raw.teams[g.home].abbr);
      let w = null, err = null;
      if (venue.roof === 'outdoor' && venue.lat != null) { try { w = await loadWeather(venue.lat, venue.lon, g.date); } catch (e) { err = e.message; } }
      WX[g.id] = { venue, w, err, read: weatherRead(venue, w) };
    });
    LAST_BUILD = new Date();
    render();
    setStatus(`Built ${LAST_BUILD.toLocaleString()} from ${BOARD.boxCount} completed box scores before ${new Date(raw.cutoff).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET · injuries as of ${new Date(raw.injAsOf).toLocaleTimeString()}${raw.injFeedOk ? '' : ' (league injury feed failed — roster statuses only)'}`);
  } catch (e) {
    console.error(e);
    if (!quiet || !BOARD) $('#board').innerHTML = `<div class="quiet">Could not build the board: ${esc(e.message)}<br><small>Nothing is shown rather than partial or guessed data. Try Refresh.</small></div>`;
    setStatus('Build failed: ' + e.message);
  } finally { BUILDING = false; }
}

/* ---------- render ---------- */

function render() {
  if (!BOARD) return;
  const T = BOARD.teams;
  $('#nav').innerHTML = BOARD.games.map(g => `<a href="#g-${g.id}">${esc(T[g.away].abbr)} @ ${esc(T[g.home].abbr)} · ${esc(etTime(g.date).replace(' ET', ''))}</a>`).join('');
  const sch = RAW.schemes;
  const schTxt = sch ? `scheme file built ${new Date(sch.builtAt).toLocaleDateString()} from ${esc(sch.sourceNote || 'nflverse charting')} through week ${esc(sch.throughWeek)}` : '<span class="b-down badge">SCHEME FILE MISSING</span> run <code>node tools/build-schemes.js</code> (or the weekly workflow) — schemes are not shown until it exists';
  $('#board').innerHTML = `<div class="status" style="margin:-4px 0 10px">${esc(weekLabel(BOARD.sel))} · ${BOARD.games.length} games · ${schTxt}</div>` +
    renderLeagueTable() + BOARD.games.map(renderGame).join('');
}

function rk(x, lowGood) { if (!x || x.v == null) return '<span class="rk">–</span>'; const cls = x.of < 16 ? '' : x.r <= 8 ? 'top' : x.r >= x.of - 7 ? 'bot' : ''; return `<span class="rk ${cls}" title="${lowGood ? '#1 = fewest allowed' : '#1 = most'}">#${x.r}</span>`; }

function renderLeagueTable() {
  const L = BOARD.L, T = BOARD.teams;
  const ids = Object.keys(L.table).filter(t => T[t]).sort((a, b) => (L.table[a].off.pts.r || 99) - (L.table[b].off.pts.r || 99));
  const head = TEAM_CATS.map(([, l]) => `<th>${l}</th>`).join('');
  const rows = ids.map(t => {
    const x = L.table[t];
    return `<tr><td class="l"><b>${esc(T[t].abbr)}</b></td><td>${x.rec.W}-${x.rec.L}${x.rec.T ? '-' + x.rec.T : ''}</td>${TEAM_CATS.map(([k]) => `<td>${f1(x.off[k].v)} ${rk(x.off[k])}</td>`).join('')}${TEAM_CATS.map(([k]) => `<td>${f1(x.def[k].v)} ${rk(x.def[k], true)}</td>`).join('')}</tr>`;
  }).join('');
  return `<details class="method"><summary>League rankings 1–32 (per game, this season, before this week) ${MEAS}</summary>
    <div class="scroll"><table class="tvp lt"><tr><th class="l">Team</th><th>W-L</th><th colspan="4" class="grp">Offense — #1 = most</th><th colspan="4" class="grp">Defense allowed — #1 = fewest</th></tr>
    <tr><th></th><th></th>${head}${head}</tr>${rows}</table></div>
    <div class="rates">Source: ESPN box scores (team points, total yards, net passing yards, rushing yards). Teams with a bye have one fewer game; everything is per game.</div></details>`;
}

function renderGame(g) {
  const T = BOARD.teams, A = T[g.away], H = T[g.home], ev = g.ev;
  const p = g.proj;
  const projHtml = p ? `<div class="blk"><span class="lbl">Projected score ${MOD}</span><b>${esc(A.abbr)} ${f1(p.away)} – ${esc(H.abbr)} ${f1(p.home)}</b> · total ${f1(p.total)}
      <div class="rates">each side = average of its points/g and the opponent's points allowed/g; no home-field or injury adjustment</div></div>` :
    `<div class="blk"><span class="lbl">Projected score</span>Not enough completed games to model.</div>`;
  const o = ev.odds;
  const mkt = o && (o.details || o.total != null) ? `<div class="blk"><span class="lbl">Market · ${esc(o.provider)} (via ESPN)</span><b>${esc(o.details || '—')}</b>${o.total != null ? ` · O/U ${o.total}` : ''}
      ${g.implied ? `<div class="rates">implied: ${esc(A.abbr)} ${f1(g.implied[g.away])} – ${esc(H.abbr)} ${f1(g.implied[g.home])}</div>` : ''}</div>` :
    `<div class="blk"><span class="lbl">Market line</span>Not posted at source — none shown.</div>`;
  const live = ev.state && ev.state !== 'pre' ? `<span class="badge b-warn">${esc(ev.statusText || ev.state)}</span>` : '';
  const scheme = g.scheme ? `<div class="script"><b>Scheme matchup</b> ${MOD} ${g.scheme.map(esc).join(' &nbsp;·&nbsp; ')}</div>` :
    `<div class="script"><b>Scheme matchup:</b> not shown — scheme file not built yet (nothing is guessed).</div>`;
  return `<section class="game" id="g-${g.id}">
    <div class="ghead">
      <div class="matchup">${esc(A.short || A.name)}<span class="at">@</span>${esc(H.short || H.name)}<span class="tip">${esc(etTime(g.date))}</span> ${live}</div>
      <div class="score">${projHtml}${mkt}</div>
      ${scheme}
    </div>
    <div class="gmid">${renderWeather(g)}${renderH2H(g)}</div>
    <div class="teams">${[g.away, g.home].map(t => renderTeamSide(g, t)).join('')}</div>
    <div class="cols">${[g.away, g.home].map(t => renderCol(g, t)).join('')}</div>
  </section>`;
}

function renderWeather(g) {
  const x = WX[g.id];
  if (!x) return '<div class="wx"><div class="wxh">Weather</div><div class="empty">not loaded</div></div>';
  const v = x.venue, w = x.w;
  const roof = { outdoor: 'Outdoor', dome: 'Dome', retractable: 'Retractable roof', canopy: 'Fixed roof (open sides)', unknown: 'Roof unknown' }[v.roof] || v.roof;
  const nums = !x.read.na && w ? `<div class="wxn"><span><b>${f0(w.temp)}°F</b> (feels ${f0(w.feels)}°)</span><span>Wind <b>${f0(Math.max(w.wind, w.windMax || 0))}</b> mph, gusts ${f0(w.gust)}</span><span>Precip chance <b>${f0(w.pop)}%</b>${w.snow > 0 ? ` · snow ${f1(w.snow)} in` : ''}</span></div>
      <div class="rates">Open-Meteo hourly forecast for the ${w.hours}-hour window from kickoff, pulled ${new Date(w.asOf).toLocaleTimeString()}</div>` : '';
  return `<div class="wx ${x.read.tilt ? 'tilt' : ''}"><div class="wxh">Weather · ${esc(v.name)}${v.city ? ', ' + esc(v.city) : ''} · ${esc(roof)}</div>
    ${nums}<div class="wxr">${x.read.na ? `<b>${esc(x.read.text)}</b>` : `<b>Read:</b> ${esc(x.read.text)} <span class="badge b-mod">RULE-BASED</span>`}</div>
    ${x.err ? `<div class="rates">Forecast fetch failed: ${esc(x.err)}</div>` : ''}</div>`;
}

function renderH2H(g) {
  const L = BOARD.L, T = BOARD.teams;
  const row = (o, d, k, lab) => {
    const O = L.table[o], D = L.table[d];
    const a = O && O.off[k], b = D && D.def[k];
    const gap = a && b && a.r && b.r ? (b.r - a.r) : null; // positive: offense ranks better than the defense
    const cls = gap != null && gap >= 15 ? 'up' : gap != null && gap <= -15 ? 'down' : '';
    return `<td class="${cls}">Off #${a && a.r || '–'} vs Def #${b && b.r || '–'}</td>`;
  };
  return `<div class="h2h"><table class="tvp"><caption>Ranks head to head (1–32, per game) ${MEAS} <span class="sub">green = offense ≥15 spots better than the defense it faces</span></caption>
    <tr><th class="l"></th><th>${esc(T[g.away].abbr)} O vs ${esc(T[g.home].abbr)} D</th><th>${esc(T[g.home].abbr)} O vs ${esc(T[g.away].abbr)} D</th></tr>
    ${TEAM_CATS.map(([k, lab]) => `<tr><td class="l">${lab}</td>${row(g.away, g.home, k, lab)}${row(g.home, g.away, k, lab)}</tr>`).join('')}</table></div>`;
}

function renderSchemeTeam(abbr) {
  const S = RAW.schemes && RAW.schemes.teams && RAW.schemes.teams[abbr];
  if (!S) return `<div class="tagbox"><div class="tagd"><b>Schemes:</b> ${RAW.schemes ? 'no charting rows for this team in the scheme file' : 'scheme file not built'} — not shown.</div></div>`;
  const pc = v => v == null ? 'n/a' : Math.round(v * 100) + '%';
  const r = x => x != null ? ` <span class="rk">#${x}</span>` : '';
  const o = S.off || {}, d = S.def || {};
  const pers = (o.personnel || []).slice(0, 3).map(x => `${x.g} ${pc(x.pct)}`).join(', ');
  const cov = (d.coverage || []).slice(0, 3).map(x => `${x.c} ${pc(x.pct)}`).join(', ');
  return `<div class="tagbox">
    <div class="tagd"><b>Offense: ${esc(o.identity || '—')}</b> ${MOD} — pass rate ${pc(o.passRate)}${o.proe != null ? `, pass rate over expected ${o.proe >= 0 ? '+' : ''}${(o.proe * 100).toFixed(1)}%` : ''}${r(o.proeRank)} · shotgun ${pc(o.shotgun)} · play-action ${pc(o.pa)}${r(o.paRank)} · motion ${pc(o.motion)}${r(o.motionRank)} · screens ${pc(o.screen)}${r(o.screenRank)}${pers ? ` · personnel ${esc(pers)}` : ' · personnel: not in source'}</div>
    <div class="tagd"><b>Defense: ${esc(d.identity || '—')}</b> ${MOD} — front: ${esc(d.front || 'not determinable from source')} · blitz ${pc(d.blitz)}${r(d.blitzRank)} · avg rushers ${d.rushers != null ? d.rushers.toFixed(2) : 'n/a'} · avg box ${d.box != null ? d.box.toFixed(2) : 'n/a'}${r(d.boxRank)} · ${d.man != null ? `man ${pc(d.man)} / zone ${pc(1 - d.man)}` : 'man/zone: not in source'}${cov ? ` · shells ${esc(cov)}` : ' · coverage shells: not in source'}</div>
    <div class="tagd sub">Rates are charted play counts (${esc(S.n ? S.n + ' plays' : 'n/a')}); identity labels are tendency-based reads, not published playbooks.</div></div>`;
}

function stChip(st) {
  const c = st.code;
  const cls = c === 'CLEARED' ? 'b-up' : c === 'QUESTIONABLE' ? 'b-warn' : 'b-down';
  const t = c === 'CLEARED' && st.raw ? `${c} (${st.raw})` : c;
  return `<span class="badge ${cls}" title="${esc(st.raw)}${st.detail ? ' — ' + esc(st.detail) : ''}">${esc(t)}</span>`;
}

function renderTeamSide(g, tid) {
  const s = g.sides[tid], T = BOARD.teams, team = T[tid], x = s.table;
  const ranks = x ? `<table class="tvp"><caption>${esc(team.abbr)} rankings (1–32, per game) ${MEAS}</caption>
      <tr><th class="l"></th>${TEAM_CATS.map(([, l]) => `<th>${l}</th>`).join('')}</tr>
      <tr><td class="l">Offense</td>${TEAM_CATS.map(([k]) => `<td>${f1(x.off[k].v)} ${rk(x.off[k])}</td>`).join('')}</tr>
      <tr><td class="l">Defense allowed</td>${TEAM_CATS.map(([k]) => `<td>${f1(x.def[k].v)} ${rk(x.def[k], true)}</td>`).join('')}</tr></table>
      <div class="rates">Allowed to positions (per game, #1 = fewest): ${POS_ALLOWED.map(([P, k, lab]) => { const v = x.posAllowed[P + ':' + k]; return `${lab} ${f1(v.v)} ${rk(v, true)}`; }).join(' · ')}</div>` : '<div class="empty">No completed games yet (n=0).</div>';
  const outs = s.outs.length ? s.outs.map(o => `${esc(o.name)} (${esc(o.P)}, ${esc(o.st.raw || o.st.code)}${o.st.detail ? ' — ' + esc(o.st.detail) : ''})`).join('; ') : 'no key players';
  const other = s.otherOut.length ? `<div class="recon">Also out at QB/RB/WR/TE: ${s.otherOut.map(o => `${esc(o.name)} (${esc(o.pos)}, ${esc(o.st.raw || o.st.code)})`).join(', ')}</div>` : '';
  const flagged = s.cards.filter(c => c.st.code !== 'CLEARED');
  return `<div class="tside">
    <div class="tname">${esc(team.name)} <span class="tmeta">${x ? `${x.rec.W}-${x.rec.L}${x.rec.T ? '-' + x.rec.T : ''} · ${x.gp} GP` : ''}</span></div>
    <div class="outline"><b>Out:</b> ${outs} <span class="sub">(no projection)</span></div>${other}
    ${flagged.length ? `<div class="recon">Projected but flagged: ${flagged.map(c => `${esc(c.name)} ${stChip(c.st)}`).join(' ')}</div>` : ''}
    ${ranks}
    ${renderSchemeTeam(team.abbr)}
  </div>`;
}

function renderCol(g, tid) {
  const s = g.sides[tid];
  return `<div class="col">
    <div class="colhead">${esc(BOARD.teams[tid].name)} <span>key skill players: QB, RB×2, WR×3, TE (TE2 at ≥3 tgt/g)</span></div>
    ${s.cards.map(c => renderCard(c, g)).join('') || '<div class="empty">No projectable players.</div>'}
  </div>`;
}

const thStats = c => c.stats.map(s => `<th>${SL[s]}</th>`).join('');
const tdStats = (c, r, cls = '') => c.stats.map(s => `<td class="${cls}">${r && r[s] != null ? (Number.isInteger(r[s]) ? r[s] : fmtStat(s, r[s])) : '–'}</td>`).join('');

function renderCard(c, g) {
  const T = BOARD.teams, opp = T[c.oid].abbr;
  const bl = blendCard(c, W);
  const vd = verdict(c, T);
  const dr = defenseRead(c, BOARD.L, RAW.schemes, T);

  // header
  const posTxt = `${c.slot}${c.pos && c.pos !== c.P ? ' (' + esc(c.pos) + ')' : ''}`;
  const rank = c.rank ? `${c.P} #${c.rank.rank} of ${c.rank.of} (${RANK_METRIC[c.P][1]} ${f1(c.rank.v)}, ${c.rank.gp} GP)` : `${c.P} unranked (${c.gp} GP < ${BOARD.L.minGp} min)`;
  const extra = [c.returning ? '<span class="badge b-warn">RETURNING — slot from season usage</span>' : '', c.fillIn ? '<span class="badge b-warn">FILL-IN STARTER</span>' : '', c.noUsage ? '<span class="badge b-warn">NO USAGE ON RECORD</span>' : ''].join('');

  // projection strip
  const proj = bl.adj ? c.stats.map(s => `<div><div class="k">${SL[s]}</div><div class="v">${fmtStat(s, bl.adj[s])}</div><div class="b">${bl.adjusted && bl.base ? `base ${fmtStat(s, bl.base[s])}` : '&nbsp;'}</div></div>`).join('') :
    `<div class="none">No projection — all three lines are n=0.</div>`;

  // blend table
  const usedTxt = (k, n) => bl.used[k] != null ? bl.used[k] + '%' : n ? '0%' : '0% (n=0)';
  const opRow = c.opp.n ? (bl.adjusted && c.fillIn ? c.opp.scaledAdj : c.opp.scaled) : null;
  const blend = `<table class="t blend">
    <tr><th class="l">Line</th><th>wt</th>${thStats(c)}</tr>
    <tr><td class="l">3 · Last 3 vs ${esc(opp)} ${nTag(c.vt.n, 3)}</td><td>${usedTxt('vt', c.vt.n)}</td>${tdStats(c, c.vt.n ? c.vt.avg : null)}</tr>
    <tr><td class="l">1 · Own last 5 ${nTag(c.own.n, 5)}</td><td>${usedTxt('l5', c.own.n)}</td>${tdStats(c, c.own.n ? c.own.avg : null)}</tr>
    <tr><td class="l">2 · ${esc(opp)} vs ${c.P}s, scaled ${nTag(c.opp.n, 5)}</td><td>${usedTxt('op', c.opp.n)}</td>${tdStats(c, opRow)}</tr>
    ${bl.adjusted && bl.base ? `<tr class="sum2"><td class="l">Blend (base, no injury adj.)</td><td></td>${tdStats(c, bl.base)}</tr>` : ''}
    <tr class="fin"><td class="l">Projection${bl.adjusted ? ' (adjusted)' : ''}</td><td></td>${tdStats(c, bl.adj)}</tr>
  </table>${bl.renormalized && bl.adj ? `<div class="rates">A line with n=0 is dropped; weights renormalized to ${Object.entries(bl.used).map(([k, v]) => ({ vt: 'vs-team', l5: 'own L5', op: 'opp log' })[k] + ' ' + v + '%').join(' / ')}.</div>` : ''}`;

  // defense panel
  const DR = c.defRank, opT = BOARD.L.table[c.oid];
  const S = RAW.schemes && RAW.schemes.teams && RAW.schemes.teams[opp];
  const defp = `<div class="defp"><div class="sech">Defense he faces · ${esc(opp)}</div>
    <div class="rates">Pass yds allowed ${opT ? `${f1(opT.def.pyd.v)}/g ${rk(opT.def.pyd, true)}` : '–'} · Rush yds allowed ${opT ? `${f1(opT.def.ryd.v)}/g ${rk(opT.def.ryd, true)}` : '–'} · Blitz rate ${S && S.def && S.def.blitz != null ? `${Math.round(S.def.blitz * 100)}% <span class="rk">#${S.def.blitzRank}</span>` : 'n/a (scheme file)'} · ${esc(dr.paTxt)}</div>
    <div class="rates"><b>Read:</b> ${esc(dr.line || '—')} ${MOD}</div></div>`;

  // notes
  const notes = [];
  c.reasons.forEach(r => notes.push(`<li class="n-div">${esc(r)} ${MOD} <span class="sig">— base vs adjusted shown above</span></li>`));
  if (c.qbChange) notes.push(`<li class="n-cau">QB change: ${esc(c.qbChange.name)} (${esc(c.qbChange.st.code)}) threw most of the team's passes in its last 5 games. His lines here come from those games — not adjusted for the backup (no measured basis).</li>`);
  if (c.st.code === 'QUESTIONABLE' || c.st.code === 'DOUBTFUL') notes.push(`<li class="n-div">Listed ${esc(c.st.raw || c.st.code)}${c.st.detail ? ': ' + esc(c.st.detail) : ''} — projected as if he plays.</li>`);
  if (c.opp.noShare && c.opp.n) notes.push(`<li class="n-split">No games for ${esc(T[c.tid].abbr)} this season, so his share of its ${c.P} production is unknown — line 2 is shown raw but not blended.</li>`);

  // line 1
  const l1 = c.own.rows.map(r => `<tr><td class="l">Wk ${r.week || ''} ${md(r.date)}</td><td class="l">${r.oppId === c.oid ? '<b>' : ''}${esc(T[r.oppId] ? T[r.oppId].abbr : '?')}${r.oppId === c.oid ? '</b>' : ''}${r.teamId !== c.tid ? '*' : ''}</td><td>${usage(c, r)}</td>${tdStats(c, r)}</tr>`).join('');
  const line1 = `<div class="sec"><div class="sech">1 · Own last 5 (this season) ${nTag(c.own.n, 5)} ${MEAS}${c.own.rows.some(r => r.teamId !== c.tid) ? '<span class="sub">* = with prior club</span>' : ''}</div>
    ${c.own.n ? `<table class="t"><tr><th class="l">Game</th><th class="l">Opp</th><th>${c.P === 'QB' ? 'Att' : c.P === 'RB' ? 'Car/Tgt' : 'Tgt'}</th>${thStats(c)}</tr>${l1}
      <tr class="sum"><td class="l" colspan="3">Average</td>${tdStats(c, c.own.avg)}</tr></table>` : '<div class="empty">n=0 — no games with a recorded touch/target this season.</div>'}</div>`;

  // line 2
  const ok = c.opp;
  const l2 = ok.rows.map(r => `<tr><td class="l">Wk ${r.week || ''} ${md(r.date)}</td><td class="l">vs ${esc(T[r.vsId] ? T[r.vsId].abbr : '?')}</td>${c.stats.map(s => `<td>${fmtStat(s, r[s])}</td>`).join('')}<td class="l">${r.unknownN ? `${r.unknownN} unplaced` : ''}</td></tr>`).join('');
  const shareRow = c.stats.map(s => `<td>${ok.share[s] != null ? Math.round(ok.share[s] * 100) + '%' : '–'}${c.fillIn ? '→100%' : ''}</td>`).join('');
  const posTxtAllowed = c.P === 'QB' ? 'passing yds/TDs and rushing yds allowed to QBs' : c.P === 'RB' ? 'rushing yds/TDs and receptions/receiving yds allowed to RBs' : `receptions, receiving yds/TDs allowed to ${c.P}s`;
  const line2 = `<div class="sec"><div class="sech">2 · ${esc(opp)} allowed to ${c.P}s, last 5 games ${nTag(ok.n, 5)} ${MEAS}<span class="sub">${posTxtAllowed}, all opposing ${c.P}s combined, by ESPN-listed position</span></div>
    ${ok.n ? `<table class="t"><tr><th class="l">Game</th><th class="l">${esc(opp)} vs</th>${thStats(c)}<th></th></tr>${l2}
      <tr class="sum"><td class="l" colspan="2">Avg allowed (team total)</td>${tdStats(c, ok.avg)}<td></td></tr>
      <tr class="sum2"><td class="l" colspan="2">His share of ${esc(T[c.tid].abbr)} ${c.P} output ${MOD}</td>${shareRow}<td></td></tr>
      <tr class="sum"><td class="l" colspan="2">Scaled to him ${MOD}</td>${tdStats(c, opRow)}<td></td></tr></table>
      <div class="rates">Share = his yards (or receptions) ÷ all ${esc(T[c.tid].abbr)} ${c.P}s' in the ${ok.shareN[c.stats[0]] || 0} games he played for them; TD lines borrow the yardage share. "unplaced" = opposing players whose position could not be resolved, left out rather than guessed.</div>` :
      `<div class="empty">n=0 — ${esc(opp)} has no completed games this season.</div>`}</div>`;

  // line 3
  const l3 = c.vt.rows.map(r => `<tr><td class="l">${mdy(r.date)}${r.typ === 'PO' ? ' PO' : ''}</td><td class="l">${esc(T[r.teamId] ? T[r.teamId].abbr : '?')}${r.teamId !== c.tid ? '*' : ''}</td>${tdStats(c, r)}</tr>`).join('');
  const line3 = `<div class="sec"><div class="sech">3 · Last 3 vs ${esc(opp)} ${nTag(c.vt.n, 3)} ${MEAS}<span class="sub">this season + up to ${c.vt.seasonsBack} prior seasons, incl. playoffs and prior clubs (*)</span></div>
    ${c.vt.n ? `<table class="t"><tr><th class="l">Date</th><th class="l">For</th>${thStats(c)}</tr>${l3}<tr class="sum"><td class="l" colspan="2">Average</td>${tdStats(c, c.vt.avg)}</tr></table>` :
      `<div class="empty">n=0 — no meetings found in that window${c.vt.err ? ' (a prior-season log failed to load; Refresh to retry)' : ''}.</div>`}</div>`;

  return `<article class="card">
    <div class="chead"><span class="pname">${esc(c.name)}</span><span class="ppos">${posTxt}</span>${stChip(c.st)}${extra}
      <span class="pmin">${esc(rank)}</span></div>
    <div class="verdict v-${vd.cls}">${esc(vd.text)}</div>
    <div class="proj p${c.stats.length}">${proj}</div>
    <div class="cbody">
      ${blend}
      ${defp}
      ${notes.length ? `<ul class="notes">${notes.join('')}</ul>` : ''}
      ${line1}${line2}${line3}
    </div>
  </article>`;
}

function usage(c, r) { return c.P === 'QB' ? r.patt : c.P === 'RB' ? `${r.ratt}/${r.tgt}` : r.tgt; }

/* ---------- controls ---------- */

function syncWeights() {
  for (const k of ['vt', 'l5', 'op']) $('#w-' + k).value = W[k];
  const tot = W.vt + W.l5 + W.op || 1;
  for (const k of ['vt', 'l5', 'op']) $('#wv-' + k).textContent = Math.round(100 * W[k] / tot) + '%';
}
let rT = null;
function onWeights() {
  for (const k of ['vt', 'l5', 'op']) W[k] = +$('#w-' + k).value;
  syncWeights();
  try { localStorage.setItem('nfl-board-weights', JSON.stringify(W)); } catch (e) { }
  clearTimeout(rT);
  rT = setTimeout(() => { const y = window.scrollY; render(); window.scrollTo(0, y); }, 120);
}
function stepWeek(d) {
  if (!SEL) return;
  let { season, stype, week } = SEL;
  week += d;
  if (stype === 2 && week > 18) { stype = 3; week = 1; }
  else if (stype === 3 && week < 1) { stype = 2; week = 18; }
  else if (week < 1) return;
  FOLLOW_CURRENT = false;
  history.replaceState(null, '', `?season=${season}&week=${week}${stype === 3 ? '&post=1' : ''}`);
  build({ season, stype, week });
}

if (typeof document !== 'undefined' && document.getElementById('board')) {
  ['vt', 'l5', 'op'].forEach(k => $('#w-' + k).addEventListener('input', onWeights));
  $('#wreset').onclick = () => { W = { ...W_DEFAULT }; syncWeights(); onWeights(); };
  $('#prev').onclick = () => stepWeek(-1);
  $('#next').onclick = () => stepWeek(1);
  $('#cur').onclick = () => { FOLLOW_CURRENT = true; history.replaceState(null, '', location.pathname); build(null); };
  $('#refresh').onclick = () => build(SEL, true);

  // injuries and forecasts change through the week: rebuild (from cache) every 30 minutes while open
  setInterval(() => { if (!document.hidden) build(FOLLOW_CURRENT ? null : SEL, true); }, 30 * 60000);

  (function init() {
    syncWeights();
    const q = new URLSearchParams(location.search);
    const season = +q.get('season'), week = +q.get('week');
    if (season && week) { FOLLOW_CURRENT = false; build({ season, stype: q.get('post') ? 3 : 2, week }); }
    else build(null);
  })();
}
