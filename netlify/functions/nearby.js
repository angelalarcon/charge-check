// Stations from etecnic + Electromaps inside the visible map area:
//   ?latNE=28.48&lngNE=-16.24&latSW=28.46&lngSW=-16.26&lat=28.47&lon=-16.25
// lat/lon is the reference point (the user, or the map centre) for distance and ordering.
const {
  distanceKm, overallStatus, getEtecnic, fromEtecnic, getElectromapsInBounds, getElectromapsStation, applyResearch,
  getResearchStations,
} = require('../../lib/stations');

const MAX_SPAN    = 1.5;   // degrees; the page stops asking below zoom 11
const MAX_RESULTS = 300;
// Electromaps' area query only gives an overall colour; per-station details add
// the price and connector counts ("2/4 available"). Prices barely change, so they're
// remembered on warm instances and afterwards only available stations are re-fetched.
const DETAIL_LIMIT       = 80;
const DETAIL_CONCURRENCY = 10;
const PRICE_TTL          = 6 * 3600_000;
const priceCache = new Map();   // electromaps id -> { at, price, priceText, payment, tariff, access }

// The same charger often shows up more than once: Electromaps users add the
// municipal IMESAPI chargers under their own names tens of metres off, and
// Electromaps lists every charger of a car park separately. Anything within
// SAME_SPOT_KM is folded into one pin unless the two listings contradict each other.
const SAME_SPOT_KM = 0.05;
// Listings with the same street address are one site too (a car park listed at its
// entrance by one source and at its centre by another), within a looser radius: a
// street and number pin the site down, a bare street name much less so.
const SAME_ADDRESS_KM   = 0.3;
const SAME_STREET_KM    = 0.1;

// Street and number of an address, the part every source writes alike:
// "Av. Francisco la Roche, 49A, 38001 Santa Cruz de Tenerife, España" → "francisco roche 49a";
// "C/ Castillo nº 77" and "Calle del Castillo, 77" both → "castillo 77"
const STREET_TYPES = /^(calle|c|avenida|avda|av|plaza|pza|pl|paseo|po|carretera|ctra|camino|rambla|urbanizacion|urb|poligono|parque|parking|aparcamiento|centro comercial|cc)\b\s*/;
const tidy = t => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\([^)]*\)/g, ' ').replace(/\bs\s*\/\s*n\b/g, ' ')
  .replace(/[\/.,º°ª#-]/g, ' ').replace(/\b(n|no|num|numero)\b/g, ' ').replace(/\s+/g, ' ').trim();
function addressKey(address) {
  const [first = '', second = ''] = String(address || '').split(',').map(tidy);
  if (/^\d{5}\b/.test(first)) return null;   // no street, just postcode and town
  const num = (first.match(/\b(\d+[a-z]?)$/) || second.match(/^(\d+[a-z]?)\b/) || [])[1];
  let street = first.replace(/\b\d+[a-z]?$/, '').trim();
  for (let prev; prev !== street;) { prev = street; street = street.replace(STREET_TYPES, ''); }
  street = street.replace(/\b(de|del|la|las|el|los)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/[a-z]{3}/.test(street)) return null;
  return { key: num ? `${street} ${num}` : street, numbered: !!num };
}

// Same place: within SAME_SPOT_KM, or the same address within its looser radius
function sameSpot(pin, s) {
  const km = distanceKm(pin.lat, pin.lon, s.lat, s.lon);
  if (km <= SAME_SPOT_KM) return true;
  if (km > SAME_ADDRESS_KM) return false;
  const a = addressKey(s.address);
  return !!a && pin.addressKeys.includes(a.key) && km <= (a.numbered ? SAME_ADDRESS_KM : SAME_STREET_KM);
}

const hasLive = s => s.live;

// Best data first: etecnic (live), then chargers whose price the operator itself gave us
// (research extras), then Electromaps with live connectors, then the rest; within each,
// the most complete listing leads the pin and the others only fill what it lacks
const rank = s => (s.source === 'etecnic' ? 0 : s.source === 'research' ? 0.5 : hasLive(s) ? 1 : 2);
const completeness = s =>
  (s.price !== 'unknown') + !!s.priceText + !!s.address + !!s.power + (s.sockets.length > 0) + !!s.payment + !!s.access;

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
  // The price (and where it came from) of the first listing that knows it
  if (pin.price === 'unknown') Object.assign(pin, { price: s.price, priceText: s.priceText, research: s.research });
  pin.priceText ||= s.priceText;
  pin.payment   ||= s.payment;
  // An official tariff beats Electromaps' "from" price; two official ones widen the range
  const t = pin.tariff, u = s.tariff;
  if (u && (!t || (t.kind !== 'official' && u.kind === 'official'))) pin.tariff = u;
  else if (t?.kind === 'official' && u?.kind === 'official' && t.operator === u.operator) {
    const widen = (a, b) => [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
    pin.tariff = { ...t, day: widen(t.day, u.day), night: widen(t.night, u.night) };
  }
  if (s.access) {
    // Different listings of one charger may name different cards; keep them all
    const cards = [...new Set([...(pin.access?.cards || []), ...(s.access.cards || [])])];
    pin.access = { ...(cards.length && { cards }), app: pin.access?.app || s.access.app };
    if (!pin.access.app) delete pin.access.app;
  }
  pin.address   ||= s.address;
  pin.url       ??= s.url;
  pin.power = Math.max(pin.power || 0, s.power || 0) || null;
}

function unify(stations) {
  const pins = [];
  const order = (a, b) => rank(a) - rank(b) || completeness(b) - completeness(a) || a.distance - b.distance;
  for (const s of [...stations].sort(order)) {
    const pin = pins.find(p => sameSpot(p, s) && samePin(p, s));
    const key = addressKey(s.address)?.key;
    if (pin) {
      absorb(pin, s);
      if (key && !pin.addressKeys.includes(key)) pin.addressKeys.push(key);
    } else pins.push({ ...s, sockets: [...s.sockets], addressKeys: key ? [key] : [] });
  }
  for (const p of pins) delete p.addressKeys;
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
    ...getResearchStations(),
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
    if (fresh) {
      const { price, priceText, payment, tariff, access } = cached;
      Object.assign(s, { price, priceText, payment, tariff, access });
    }
    if (!fresh || s.status === 'available') toDetail.push(s);
  }
  await mapLimit(toDetail, DETAIL_CONCURRENCY, async s => {
    try {
      const d = await getElectromapsStation(s.id);
      const { price, priceText, payment, tariff, access } = d;
      priceCache.set(s.id, { at: Date.now(), price, priceText, payment, tariff, access });
      // Keep the map's overall colour if the connector list is less informative
      Object.assign(s, d, { status: d.status === 'unknown' ? s.status : d.status, distance: s.distance });
    } catch {}
  });

  stations.forEach(applyResearch);
  // An extra already shown through its own Electromaps listing needs no second pin
  const listed = new Set(stations.map(s => s.extraOf).filter(Boolean));
  const shown = stations.filter(s => !listed.has(s.key));

  return json(200, {
    stations: unify(shown),
    sources: {
      etecnic:     etecnic.status === 'fulfilled' ? 'ok' : etecnic.reason.message,
      electromaps: electromaps.status === 'fulfilled' ? 'ok' : electromaps.reason.message,
    },
  });
};
