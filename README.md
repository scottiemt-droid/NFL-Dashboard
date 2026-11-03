# NFL Matchup Board

Full-week matchup board: every game of the current NFL week on one page, each team's 1–32 rankings, the key skill players (QB, top 2 RBs, top 3 WRs, top TE) with single-value projections, and all three input lines shown next to each projection. Each game also gets a scheme-matchup line and a weather panel. **It shows matchups and projections only. It does not make picks.**

Built the same way as the NBA board: a static page that pulls real data in your browser on every load, with no hand-typed numbers.

## Run it

Double-click `start-board.cmd`. It starts a tiny local server (`serve.ps1`, PowerShell only) and opens http://localhost:8078/. If Node is installed, it first rebuilds the scheme file when that file is missing or more than 6 days old.

- The board opens on the current week. It rolls to next week once every game of the current week is final, so it's on the new week by Tuesday/Wednesday.
- `‹` / `›` step weeks; `?season=2026&week=9` opens a specific week.
- **Refresh:** the board rebuilds on every load. **Injury statuses and weather forecasts re-pull every 30 minutes** while the tab is open, and the Refresh button re-pulls on demand.
- The first load downloads every completed box score of the season, plus prior-season game logs for this week's key players (for the vs-team line). These are cached in the browser (IndexedDB), so later loads take seconds.

## On your phone

The board is a static page, so GitHub Pages hosts it the same way as the NBA board: https://scottiemt-droid.github.io/NFL-Dashboard/ (once Pages is on: repo **Settings → Pages → Deploy from a branch → `main` / root → Save**). The weekly scheme workflow commits to `main`, so the phone copy picks up each new scheme file automatically.

To get an app icon: open that link in **Safari (iPhone) → Share → Add to Home Screen**, or **Chrome (Android) → ⋮ → Add to Home screen / Install app**. It opens full-screen with its own icon (`manifest.webmanifest`, `icons/`; redraw the icons with `node tools/make-icons.js`). Data still loads live on every open.

## Scheme file (weekly, Wednesday)

`data/schemes.json` holds each team's offensive and defensive tendencies. It's built from nflverse play-by-play, FTN charting and nflverse participation data by `tools/build-schemes.js` (Node 18+, no installs):

```
node tools/build-schemes.js
```

`.github/workflows/weekly-schemes.yml` runs it every Wednesday (plus Friday, for late charting uploads) and commits the file. You can also run it any time from **Actions → Weekly scheme build → Run workflow**. Scheduled runs only start once the workflow is on the default branch. Until the file exists, the board says so and shows no schemes. Nothing is guessed.

## Sources

| Data | Source |
|---|---|
| Schedule, kickoff, market line, venue | ESPN scoreboard (line from ESPN's listed provider, shown only when posted) |
| Team rankings, player game lines, allowed-by-position logs | ESPN box scores, this season |
| Last 3 vs this opponent (prior seasons) | ESPN player game logs |
| Positions, injury designations | ESPN rosters + ESPN injury feed (the NFL's official game statuses) |
| Weather | Open-Meteo hourly forecast at the stadium; stadium coordinates and roof type in `js/venues.js` |
| Schemes | nflverse play-by-play (pass rate over expected, shotgun), FTN charting (play-action, motion, screens, blitzers, rushers, box), nflverse participation (personnel, man/zone, coverage shells) |

Hosts the page calls: `site.api.espn.com`, `site.web.api.espn.com`, `api.open-meteo.com`, `geocoding-api.open-meteo.com`. The scheme build calls `github.com` (nflverse release downloads).

## Files

| File | Role |
|---|---|
| `js/data.js` | ESPN + Open-Meteo fetches, IndexedDB cache, box-score and game-log extraction |
| `js/venues.js` | Stadium table (location, dome / retractable / outdoor), neutral-site table, venue resolution |
| `js/model.js` | League table and ranks, allowed-by-position logs, key players, statuses, the three lines, blend, injury volume adjustment, verdicts, scheme and weather reads |
| `js/ui.js` | Rendering, live weight sliders, week controls, 30-minute injury/forecast refresh |
| `tools/build-schemes.js` | Weekly scheme file build |
| `tools/selftest.js` | Code-path test on a **synthetic** fixture (made-up players; never shown on the board): `node tools/selftest.js` |

Tunable constants live at the top of `js/model.js` (`SLOTS`, `TE2_MIN_TGT`, `ADJ_CAP`, `ADJ_MIN_SHARE`, `VS_NEED`, `VS_SEASONS_BACK`).

## What is measured vs modeled

**Measured:** every game row in the three lines, team per-game averages and 1–32 ranks, the allowed-by-position sums (box-score totals bucketed by ESPN's listed position), injury designations, forecast numbers, and charted scheme rates.

**Modeled (labelled on the board):**
- Line 2 on the player's scale: opponent's per-game allowed to the position × the player's share of his team's output at that position (TDs borrow the yardage share).
- Injury volume adjustment: an OUT/IR player's share of RB carries or team targets over the last 5 games is redistributed proportionally (×1/(1−share), capped ×1.5). A fill-in starting QB's opponent line uses full starter volume. Receivers are not adjusted for a QB change. The card says so.
- Projected score: average of a team's points/g and its opponent's points allowed/g.
- Scheme identity labels and front calls (3- vs 4-down, from DL counts in personnel), the per-game scheme matchup line, each card's defensive read, and the weather read (rule-based thresholds listed on the board).

**Not available, so not shown:** practice participation (DNP/limited) before game designations are issued; snap-level CB/WR matchups; any field the scheme sources don't carry in a given season (shown as "not in source").

## Known limits

- A player only appears in a box score when he records a stat, so "own last 5" means his last 5 games with a dropback, carry or target.
- Positions come from current ESPN rosters. Box-score players no longer on any roster are looked up individually. Any that still can't be placed are counted as "unplaced" and left out of the positional log, not guessed.
- The vs-team window is this season plus up to four prior seasons. It stops early once 3 meetings are found.
- Retractable-roof stadiums are treated as weather-proof. Roof decisions are made on game day.
