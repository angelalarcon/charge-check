// Stations from etecnic + Electromaps inside the visible map area:
//   ?latNE=28.48&lngNE=-16.24&latSW=28.46&lngSW=-16.26&lat=28.47&lon=-16.25
// lat/lon is the reference point (the user, or the map centre) for distance and ordering.
const {
  distanceKm, overallStatus, getEtecnic, fromEtecnic, getElectromapsInBounds, getElectromapsStation,
} = require('../../lib/stations');

const MAX_SPAN    = 1.5;   // degrees; the page stops asking below zoom 11
const MAX_RESULTS = 300;
// Electromaps' area query only gives an overall colour; per-station details add
// the price and connector counts ("2/4 available"). Prices barely change, so they're
// remembered on warm instances and afterwards only available stations are re-fetched.
const DETAIL_LIMIT       = 80;
const DETAIL_CONCURRENCY = 10;
const PRICE_TTL          = 6 * 3600_000;
const priceCache = new Map();   // electromaps id -> { at, price, priceText }

// The same charger often shows up more than once: Electromaps users add the
// municipal IMESAPI chargers under their own names a few metres off, and
// Electromaps lists every charger of a car park separately at the same spot.
// Fold them into one pin. etecnic wins over Electromaps since it has live status.
const SAME_AS_ETECNIC_KM     = 0.03;
const SAME_AS_ELECTROMAPS_KM = 0.01;

function absorb(host, dup, { combineSockets }) {
  host.aliases = [...(host.aliases || []), dup.key];
  host.url ??= dup.url;
  if (combineSockets) {
    host.sockets = [...host.sockets, ...dup.sockets].map((sk, i) => ({ ...sk, n: i + 1 }));
    host.status  = overallStatus([{ status: host.status }, { status: dup.status }]);
    host.power   = Math.max(host.power || 0, dup.power || 0) || null;
    host.count   = (host.count || 1) + 1;
  }
  if (host.price === 'unknown' || (combineSockets && dup.price === 'paid')) {
    host.price = dup.price;
    host.priceText = host.priceText || dup.priceText;
  }
}

function unify(stations) {
  const etecnic = stations.filter(s => s.source === 'etecnic');
  const electromaps = [];
  for (const s of stations) {
    if (s.source !== 'electromaps') continue;
    const near = (list, km) => list.find(o => distanceKm(o.lat, o.lon, s.lat, s.lon) <= km);
    const host = near(etecnic, SAME_AS_ETECNIC_KM);
    if (host) { absorb(host, s, { combineSockets: false }); continue; }
    const twin = near(electromaps, SAME_AS_ELECTROMAPS_KM);
    if (twin) { absorb(twin, s, { combineSockets: true }); continue; }
    electromaps.push(s);
  }
  // A car park's chargers are numbered ("…PILAR02", "…PILAR06"); name the group without it
  for (const g of electromaps) if (g.count > 1) g.name = g.name.replace(/[\s_-]*\d+$/, '') || g.name;
  return [...etecnic, ...electromaps].sort((a, b) => a.distance - b.distance);
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async function (event) {
  const q = event.queryStringParameters || {};
  const [latNE, lngNE, latSW, lngSW, lat, lon] =
    ['latNE', 'lngNE', 'latSW', 'lngSW', 'lat', 'lon'].map(k => Number(q[k]));
  if (![latNE, lngNE, latSW, lngSW, lat, lon].every(Number.isFinite) ||
      latNE <= latSW || lngNE <= lngSW) {
    return json(400, { error: 'latNE, lngNE, latSW, lngSW, lat and lon are required' });
  }
  if (latNE - latSW > MAX_SPAN || lngNE - lngSW > MAX_SPAN) {
    return json(400, { error: 'Area too large, zoom in' });
  }
  const inBounds = s => s.lat >= latSW && s.lat <= latNE && s.lon >= lngSW && s.lon <= lngNE;

  const [etecnic, electromaps] = await Promise.allSettled([
    getEtecnic().then(all => all
      .filter(s => s.show_map !== false)
      .map(fromEtecnic)
      .filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon))),
    getElectromapsInBounds({ latNE, lngNE, latSW, lngSW }),
  ]);

  if (etecnic.status === 'rejected' && electromaps.status === 'rejected') {
    return json(502, { error: `${etecnic.reason.message}; ${electromaps.reason.message}` });
  }

  const stations = [
    ...(etecnic.status === 'fulfilled' ? etecnic.value : []),
    ...(electromaps.status === 'fulfilled' ? electromaps.value : []),
  ]
    .filter(inBounds)
    .map(s => ({ ...s, distance: distanceKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_RESULTS);

  const now = Date.now();
  if (priceCache.size > 5000) priceCache.clear();
  const toDetail = [];
  for (const s of stations.filter(s => s.source === 'electromaps').slice(0, DETAIL_LIMIT)) {
    const cached = priceCache.get(s.id);
    const fresh = cached && now - cached.at < PRICE_TTL;
    if (fresh) Object.assign(s, { price: cached.price, priceText: cached.priceText });
    if (!fresh || s.status === 'available') toDetail.push(s);
  }
  await mapLimit(toDetail, DETAIL_CONCURRENCY, async s => {
    try {
      const d = await getElectromapsStation(s.id);
      priceCache.set(s.id, { at: Date.now(), price: d.price, priceText: d.priceText });
      // Keep the map's overall colour if the connector list is less informative
      Object.assign(s, d, { status: d.status === 'unknown' ? s.status : d.status, distance: s.distance });
    } catch {}
  });

  return json(200, {
    stations: unify(stations),
    sources: {
      etecnic:     etecnic.status === 'fulfilled' ? 'ok' : etecnic.reason.message,
      electromaps: electromaps.status === 'fulfilled' ? 'ok' : electromaps.reason.message,
    },
  });
};
