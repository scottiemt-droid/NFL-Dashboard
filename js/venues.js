'use strict';
/* Stadium reference: location and roof type, keyed by ESPN team abbreviation for home stadiums.
   roof: 'outdoor' | 'dome' (fixed roof) | 'retractable' | 'canopy' (fixed translucent roof, open sides — SoFi).
   Anything with a roof is treated as weather-proof: the board says "Weather N/A (dome)" instead of showing numbers.
   Neutral-site games (international, etc.) are matched by name below; otherwise the city is geocoded and the roof
   comes from ESPN's own venue "indoor" flag. */

const HOME_VENUES = {
  ARI: { name: 'State Farm Stadium', city: 'Glendale, AZ', lat: 33.5276, lon: -112.2626, roof: 'retractable' },
  ATL: { name: 'Mercedes-Benz Stadium', city: 'Atlanta, GA', lat: 33.7554, lon: -84.4008, roof: 'retractable' },
  BAL: { name: 'M&T Bank Stadium', city: 'Baltimore, MD', lat: 39.2780, lon: -76.6227, roof: 'outdoor' },
  BUF: { name: 'Highmark Stadium', city: 'Orchard Park, NY', lat: 42.7738, lon: -78.7870, roof: 'outdoor' },
  CAR: { name: 'Bank of America Stadium', city: 'Charlotte, NC', lat: 35.2258, lon: -80.8528, roof: 'outdoor' },
  CHI: { name: 'Soldier Field', city: 'Chicago, IL', lat: 41.8623, lon: -87.6167, roof: 'outdoor' },
  CIN: { name: 'Paycor Stadium', city: 'Cincinnati, OH', lat: 39.0955, lon: -84.5161, roof: 'outdoor' },
  CLE: { name: 'Huntington Bank Field', city: 'Cleveland, OH', lat: 41.5061, lon: -81.6995, roof: 'outdoor' },
  DAL: { name: 'AT&T Stadium', city: 'Arlington, TX', lat: 32.7473, lon: -97.0945, roof: 'retractable' },
  DEN: { name: 'Empower Field at Mile High', city: 'Denver, CO', lat: 39.7439, lon: -105.0201, roof: 'outdoor' },
  DET: { name: 'Ford Field', city: 'Detroit, MI', lat: 42.3400, lon: -83.0456, roof: 'dome' },
  GB: { name: 'Lambeau Field', city: 'Green Bay, WI', lat: 44.5013, lon: -88.0622, roof: 'outdoor' },
  HOU: { name: 'NRG Stadium', city: 'Houston, TX', lat: 29.6847, lon: -95.4107, roof: 'retractable' },
  IND: { name: 'Lucas Oil Stadium', city: 'Indianapolis, IN', lat: 39.7601, lon: -86.1639, roof: 'retractable' },
  JAX: { name: 'EverBank Stadium', city: 'Jacksonville, FL', lat: 30.3239, lon: -81.6373, roof: 'outdoor' },
  KC: { name: 'GEHA Field at Arrowhead Stadium', city: 'Kansas City, MO', lat: 39.0489, lon: -94.4839, roof: 'outdoor' },
  LV: { name: 'Allegiant Stadium', city: 'Las Vegas, NV', lat: 36.0909, lon: -115.1833, roof: 'dome' },
  LAC: { name: 'SoFi Stadium', city: 'Inglewood, CA', lat: 33.9535, lon: -118.3392, roof: 'canopy' },
  LAR: { name: 'SoFi Stadium', city: 'Inglewood, CA', lat: 33.9535, lon: -118.3392, roof: 'canopy' },
  MIA: { name: 'Hard Rock Stadium', city: 'Miami Gardens, FL', lat: 25.9580, lon: -80.2389, roof: 'outdoor' },
  MIN: { name: 'U.S. Bank Stadium', city: 'Minneapolis, MN', lat: 44.9737, lon: -93.2577, roof: 'dome' },
  NE: { name: 'Gillette Stadium', city: 'Foxborough, MA', lat: 42.0909, lon: -71.2643, roof: 'outdoor' },
  NO: { name: 'Caesars Superdome', city: 'New Orleans, LA', lat: 29.9511, lon: -90.0812, roof: 'dome' },
  NYG: { name: 'MetLife Stadium', city: 'East Rutherford, NJ', lat: 40.8135, lon: -74.0745, roof: 'outdoor' },
  NYJ: { name: 'MetLife Stadium', city: 'East Rutherford, NJ', lat: 40.8135, lon: -74.0745, roof: 'outdoor' },
  PHI: { name: 'Lincoln Financial Field', city: 'Philadelphia, PA', lat: 39.9008, lon: -75.1675, roof: 'outdoor' },
  PIT: { name: 'Acrisure Stadium', city: 'Pittsburgh, PA', lat: 40.4468, lon: -80.0158, roof: 'outdoor' },
  SF: { name: "Levi's Stadium", city: 'Santa Clara, CA', lat: 37.4030, lon: -121.9700, roof: 'outdoor' },
  SEA: { name: 'Lumen Field', city: 'Seattle, WA', lat: 47.5952, lon: -122.3316, roof: 'outdoor' },
  TB: { name: 'Raymond James Stadium', city: 'Tampa, FL', lat: 27.9759, lon: -82.5033, roof: 'outdoor' },
  TEN: { name: 'Nissan Stadium', city: 'Nashville, TN', lat: 36.1665, lon: -86.7713, roof: 'outdoor' },
  WSH: { name: 'Northwest Stadium', city: 'Landover, MD', lat: 38.9078, lon: -76.8645, roof: 'outdoor' }
};

// Neutral sites seen in recent seasons, matched on a fragment of ESPN's venue name.
const NEUTRAL_VENUES = [
  { match: /tottenham/i, name: 'Tottenham Hotspur Stadium', city: 'London, UK', lat: 51.6043, lon: -0.0664, roof: 'outdoor' },
  { match: /wembley/i, name: 'Wembley Stadium', city: 'London, UK', lat: 51.5560, lon: -0.2796, roof: 'outdoor' },
  { match: /allianz arena/i, name: 'Allianz Arena', city: 'Munich, Germany', lat: 48.2188, lon: 11.6247, roof: 'outdoor' },
  { match: /deutsche bank park|frankfurt/i, name: 'Deutsche Bank Park', city: 'Frankfurt, Germany', lat: 50.0686, lon: 8.6455, roof: 'retractable' },
  { match: /olympiastadion/i, name: 'Olympiastadion', city: 'Berlin, Germany', lat: 52.5147, lon: 13.2395, roof: 'outdoor' },
  { match: /bernab/i, name: 'Santiago Bernabéu', city: 'Madrid, Spain', lat: 40.4531, lon: -3.6883, roof: 'retractable' },
  { match: /azteca|banorte/i, name: 'Estadio Banorte (Azteca)', city: 'Mexico City, Mexico', lat: 19.3029, lon: -99.1505, roof: 'outdoor' },
  { match: /neo qu[ií]mica|corinthians/i, name: 'Neo Química Arena', city: 'São Paulo, Brazil', lat: -23.5453, lon: -46.4742, roof: 'outdoor' },
  { match: /maracan/i, name: 'Maracanã', city: 'Rio de Janeiro, Brazil', lat: -22.9121, lon: -43.2302, roof: 'outdoor' },
  { match: /melbourne cricket|\bmcg\b/i, name: 'Melbourne Cricket Ground', city: 'Melbourne, Australia', lat: -37.8200, lon: 144.9834, roof: 'outdoor' },
  { match: /croke park/i, name: 'Croke Park', city: 'Dublin, Ireland', lat: 53.3607, lon: -6.2511, roof: 'outdoor' },
  { match: /stade de france/i, name: 'Stade de France', city: 'Paris, France', lat: 48.9245, lon: 2.3602, roof: 'outdoor' }
];

const ROOF_TXT = { dome: 'dome', retractable: 'retractable roof', canopy: 'fixed roof' };

// Resolves the game's venue → { name, city, lat, lon, roof, source }. Returns lat/lon null when it can't be placed.
async function resolveVenue(ev, homeAbbr) {
  const v = ev.venue || {};
  const norm = s => String(s || '').split(',')[0].toLowerCase().replace(/[^a-z]/g, '');
  const h = HOME_VENUES[homeAbbr];
  // home game at the home stadium (ESPN's city agrees with the table, or ESPN gave no city)
  if (!ev.neutral && h && (!v.city || norm(v.city) === norm(h.city))) {
    return { ...h, name: v.name || h.name, source: 'home stadium table' };
  }
  const n = NEUTRAL_VENUES.find(x => x.match.test(v.name || ''));
  if (n) return { ...n, source: 'neutral-site table' };
  // a home team's game moved to an unlisted site, or a new neutral site: geocode the city, roof from ESPN's indoor flag
  if (v.city) {
    try {
      const g = await geocode(v.city, v.country);
      if (g) return { name: v.name || '?', city: [v.city, v.state || v.country].filter(Boolean).join(', '), lat: g.lat, lon: g.lon, roof: v.indoor ? 'dome' : 'outdoor', source: 'geocoded city; roof from ESPN indoor flag' };
    } catch (e) { /* fall through */ }
  }
  return { name: v.name || 'Unknown venue', city: v.city || '', lat: null, lon: null, roof: v.indoor ? 'dome' : 'unknown', source: 'venue not placed' };
}
