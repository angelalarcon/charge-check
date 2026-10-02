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
// municipal IMESAPI chargers under their own names tens of metres off, and
// Electromaps lists every charger of a car park separately. Anything within
// SAME_SPOT_KM is folded into one pin unless the two listings contradict each other.
const SAME_SPOT_KM = 0.05;

const hasLive = s => s.live;

// Best data first: etecnic (live), then Electromaps with live connectors, then the rest
const rank = s => (s.source === 'etecnic' ? 0 : hasLive(s) ? 1 : 2);

function samePin(pin, s) {
  if (pin.price !== 'unknown' && s.price !== 'unknown' && pin.price !== s.price) return false;
  // Two live feeds from different networks are two different chargers
  if (pin.source !== s.source && hasLive(pin) && hasLive(s)) return false;
  return true;
}

function absorb(pin, s) {
  pin.aliases = [...(pin.aliases || []), s.key];
  if (pin.source === s.source && hasLive(pin) && hasLive(s)) {
    // Neighbouring chargers of one site (car park, etc.): one pin with all their connectors
    pin.sockets = [...pin.sockets, ...s.sockets].map((sk, i) => ({ ...sk, n: i + 1 }));
    pin.status  = overallStatus([{ status: pin.status }, { status: s.status }]);
    pin.count   = (pin.count || 1) + 1;
  } else if (!hasLive(pin) && hasLive(s)) {
    Object.assign(pin, { sockets: s.sockets, status: s.status, live: true });
  } else if (pin.status === 'unknown' && s.status !== 'unknown') {
    pin.status = s.status;   // e.g. the map colour of an Electromaps listing without details
  }
  if (pin.price === 'unknown') Object.assign(pin, { price: s.price, priceText: s.priceText });
  pin.priceText ||= s.priceText;
  pin.address   ||= s.address;
  pin.url       ??= s.url;
  pin.power = Math.max(pin.power || 0, s.power || 0) || null;
}

function unify(stations) {
  const pins = [];
  for (const s of [...stations].sort((a, b) => rank(a) - rank(b) || a.distance - b.distance)) {
    const pin = pins.find(p => distanceKm(p.lat, p.lon, s.lat, s.lon) <= SAME_SPOT_KM && samePin(p, s));
    if (pin) absorb(pin, s);
    else pins.push({ ...s, sockets: [...s.sockets] });
  }
  // A car park's chargers are numbered ("…PILAR02", "…PILAR06"); name the group without it
  for (const p of pins) if (p.count > 1) p.name = p.name.replace(/[\s_-]*\d+$/, '') || p.name;
  return pins.sort((a, b) => a.distance - b.distance);
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
