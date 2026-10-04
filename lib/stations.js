// Shared data access for the Netlify functions.
// Both upstream sources are normalised to one station shape:
//   { key, source, id, name, address, lat, lon, power, status, live, price, priceText?, payment?, access?, sockets: [{ n, status, kw? }], url? }
// access = { cards?: ['Canarias te Recarga', …], app?: 'Iberdrola' | … } when activating it needs one
// live = the status comes from the charger itself, not from user reports
// where every status is one of: available | busy | unavailable | unknown
// and price is one of: free | paid | unknown

const ETECNIC_URL     = 'https://etecnic.net/api/v1/chargers/index.json';
const ELECTROMAPS_API = 'https://www.electromaps.com/mapi/v2';
const ELECTROMAPS_WEB = 'https://map.electromaps.com/es/p/';

const DEFAULT_FAVORITES = ['etecnic:23967', 'etecnic:30514'];

const ETECNIC_STATUS = { 0: 'available', 1: 'busy', 2: 'busy', 3: 'unavailable', 9: 'unavailable' };
const EM_CONNECTOR_STATUS = {
  AVAILABLE: 'available',
  OCCUPIED: 'busy', CHARGING: 'busy', RESERVED: 'busy', BLOCKED: 'busy',
  OUT_OF_SERVICE: 'unavailable', INOPERATIVE: 'unavailable',
};
// Electromaps map markers are "a.b.c" = power class . pin colour . user rating;
// the pin colour is 0 green (available), 1 red (out of service), 2 blue (occupied), 3 grey (unknown)
const EM_MARKER_STATUS = { 0: 'available', 1: 'unavailable', 2: 'busy', 3: 'unknown' };

// etecnic's public API has no tariff data; Santa Cruz's municipal IMESAPI chargers are free
const ETECNIC_FREE = /^IMESAPI\b/;

// Electromaps has no single price field: operator-run connectors say cost "PAYMENT",
// community-added stations carry free text in charge_price ("GRATUITO", "0,21€/kWh", "Por ver"…)
function electromapsPrice(d) {
  const costs = (d.connectors || []).map(c => c.cost);
  if (costs.includes('PAYMENT')) return 'paid';
  if (costs.length && costs.every(c => c === 'FREE')) return 'free';
  const text = String(d.charge_price ?? '').trim().toLowerCase();
  if (/gratu|gratis|free/.test(text) || /^0+([.,]0+)?\s*€?$/.test(text)) return 'free';
  if (/\d/.test(text)) return 'paid';
  return 'unknown';
}

// Who you pay at a paid station. Recognised apps are returned by id (the page
// knows how to open them); otherwise just the operator / site name.
const PAY_APPS = [
  ['iberdrola', /iberdrola/i],
  ['endesa',    /endesa|enel/i],
  ['wenea',     /wenea/i],
  ['waylet',    /waylet|repsol/i],
  ['electromaps', /electromaps|electropass/i],
];
const NO_CONTACT = /^(pendiente|desconocido)?$/i;
// Operator ids that need a readable name ("P-APP & WEB SERVICIOS DIGITALES | ES*IPK")
const OPERATOR_NAMES = [[/ES\*IPK|interparking/i, 'Interparking']];

function electromapsPayment(d) {
  const operator = d.cpo?.name?.trim();
  const contact  = (d.contact || '').trim();
  // Operator first, then instructions ("App Iberdrola", "apps Iberdrola/ Waylet"), then contact
  for (const text of [operator, d.instructions, contact].filter(Boolean)) {
    for (const [app, re] of PAY_APPS) if (re.test(text)) return { app };
  }
  let name = operator || (NO_CONTACT.test(contact) ? null : contact);
  for (const [re, nice] of OPERATOR_NAMES) if (name && re.test(name)) name = nice;
  return name ? { name } : null;
}

// What you need to start a charge, read from the community notes ("Solo con tarjeta
// Canarias te Recarga", "App Iberdrola", "Enchufar y listo") and, for operator-run
// chargers with live status, from remote activation (= the operator's app).
const CARD_NAMES = [
  [/canarias\s*te\s*recarga/i,             'Canarias te Recarga'],
  [/\bCTR\b/,                               'Canarias te Recarga'],   // its usual abbreviation
  [/circutor/i,                             'Circutor'],
  [/muvisa/i,                               'Muvisa'],
  [/fen[ií]e/i,                             'Feníe'],
  [/universidad|\bull\b/i,                  'Universidad de La Laguna'],
  [/ayuntamiento de la laguna/i,            'Ayto. de La Laguna'],
  [/(llavero|rfid)[^|]*electromaps/i,       'Llavero Electromaps'],
  [/cualquier/i,                            'Cualquier tarjeta de recarga'],
  [/tarjeta\s+(del\s+)?(ayto|ayuntamiento)/i, 'Tarjeta del Ayuntamiento'],
];
const APP_NAMES = [
  [/iberdrola/i, 'Iberdrola'], [/waylet|repsol/i, 'Waylet'], [/endesa|enel|juicepass/i, 'Endesa'],
  [/wenea/i, 'Wenea'], [/electromaps/i, 'Electromaps'], [/cepsa/i, 'CEPSA GO'],
  [/eranovum/i, 'Eranovum'], [/ev\s*charge/i, 'EVCharge'], [/ES\*IPK|interparking/i, 'Interparking'],
  [/disa|prio recharge/i, 'DISA'],
];
// Bank cards at a payment terminal are not a membership card
const NO_CARD = /sin tarjeta|no (es )?necesari[ao] tarjeta|no necesita tarjeta|pago con tarjeta|\btpv\b/i;

function electromapsAccess(d) {
  const notes = [d.instructions, d.contact, d.charge_price].filter(Boolean).join(' | ');
  const operator = d.cpo?.name || '';
  const access = {};
  if (!NO_CARD.test(notes) && /tarjeta|rfid|llavero|canarias\s*te\s*recarga/i.test(notes)) {
    const cards = [...new Set(CARD_NAMES.filter(([re]) => re.test(notes)).map(([, name]) => name))];
    access.cards = cards.length ? cards : ['Tarjeta del operador'];
  }
  const remote = d.realtime && (d.connectors || []).some(c => c.authenticationRemote);
  const appNotes = /\bapps?\b|aplicaci[oó]n/i.test(notes);
  if (remote || appNotes || /\bqr\b/i.test(notes)) {
    // A QR code alone leads to a web form, not an app
    access.app = APP_NAMES.find(([re]) => re.test(notes) || re.test(operator))?.[1] || operator ||
                 (remote || appNotes ? 'App' : 'Código QR');
  }
  return access.cards || access.app ? access : null;
}

function overallStatus(sockets) {
  const s = sockets.map(x => x.status);
  if (s.includes('available')) return 'available';
  if (s.includes('busy')) return 'busy';
  if (s.length && s.every(x => x === 'unavailable')) return 'unavailable';
  return 'unknown';
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = d => d * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// ── etecnic ─────────────────────────────────────────────────────────
// The whole network (~7k stations, 2.5 MB) comes in one file; keep it
// briefly on warm instances so favourites + nearby don't both download it
let etecnicCache = null;

async function getEtecnic() {
  if (etecnicCache && Date.now() - etecnicCache.at < 20_000) return etecnicCache.data;
  const r = await fetch(ETECNIC_URL, {
    headers: {
      Origin: 'https://etecnic.es',
      Referer: 'https://etecnic.es/mapa-de-recarga/',
      'User-Agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`etecnic ${r.status}`);
  const data = await r.json();
  etecnicCache = { at: Date.now(), data };
  return data;
}

function fromEtecnic(s) {
  const sockets = [...s.charger_sockets]
    .sort((a, b) => a.socket_number - b.socket_number)
    .map(sk => ({ n: sk.socket_number, status: ETECNIC_STATUS[sk.status] ?? 'unknown' }));
  return {
    key: `etecnic:${s.id}`, source: 'etecnic', id: s.id,
    name: s.name, address: s.address || '',
    lat: Number(s.lat), lon: Number(s.lon),
    power: s.power, sockets, status: overallStatus(sockets), live: true,
    price: ETECNIC_FREE.test(s.name) ? 'free' : 'unknown',
  };
}

// ── Electromaps ─────────────────────────────────────────────────────
async function electromaps(path, params) {
  const url = `${ELECTROMAPS_API}/${path}` + (params ? '?' + new URLSearchParams(params) : '');
  const r = await fetch(url, {
    headers: { 'App-platform': 'web', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`electromaps ${r.status}`);
  return r.json();
}

function fromElectromapsMarker(m) {
  return {
    key: `electromaps:${m.id}`, source: 'electromaps', id: m.id,
    name: m.name, address: '',
    lat: m.latitude, lon: m.longitude,
    power: null, sockets: [],
    status: EM_MARKER_STATUS[String(m.marker).split('.')[1]] ?? 'unknown',
    live: false,
    price: 'unknown',
    url: ELECTROMAPS_WEB + m.id,
  };
}

function fromElectromapsDetail(d) {
  const sockets = (d.connectors || []).map((c, i) => ({
    n: i + 1, status: EM_CONNECTOR_STATUS[c.status] ?? 'unknown', kw: c.kw,
  }));
  const kws = sockets.map(s => s.kw).filter(Boolean);
  const price = electromapsPrice(d);
  return {
    key: `electromaps:${d.id}`, source: 'electromaps', id: d.id,
    name: d.name, address: d.address?.address || '',
    lat: d.latitude, lon: d.longitude,
    power: kws.length ? Math.max(...kws) : null,
    sockets, status: overallStatus(sockets), live: !!d.realtime,
    price,
    priceText: price === 'paid' && /\d/.test(d.charge_price ?? '') ? d.charge_price.trim() : null,
    payment: price === 'paid' ? electromapsPayment(d) : null,
    access: electromapsAccess(d),
    url: ELECTROMAPS_WEB + d.id,
  };
}

async function getElectromapsStation(id) {
  return fromElectromapsDetail(await electromaps(`locations/${encodeURIComponent(id)}`));
}

async function getElectromapsInBounds({ latNE, lngNE, latSW, lngSW }) {
  const list = await electromaps('locations', { latNE, lngNE, latSW, lngSW, realtime: false });
  return list.map(fromElectromapsMarker);
}

module.exports = {
  DEFAULT_FAVORITES,
  overallStatus,
  distanceKm,
  getEtecnic,
  fromEtecnic,
  getElectromapsStation,
  getElectromapsInBounds,
};
