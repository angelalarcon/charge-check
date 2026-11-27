// Live status for a list of stations: ?ids=etecnic:23967,electromaps:8017
// Defaults to the original two IMESAPI stations when no ids are given.
const {
  DEFAULT_FAVORITES, getEtecnic, fromEtecnic, getElectromapsStation, applyResearch, fromResearch,
} = require('../../lib/stations');

const MAX_IDS = 20;

exports.handler = async function (event) {
  const raw = event.queryStringParameters?.ids;
  const keys = (raw ? raw.split(',').map(k => k.trim()).filter(Boolean) : DEFAULT_FAVORITES)
    .slice(0, MAX_IDS);

  try {
    const etecnicIds = new Set(keys.filter(k => k.startsWith('etecnic:')).map(k => k.slice(8)));
    const etecnic = etecnicIds.size
      ? new Map((await getEtecnic())
          .filter(s => etecnicIds.has(String(s.id)))
          .map(s => [`etecnic:${s.id}`, fromEtecnic(s)]))
      : new Map();

    const stations = await Promise.all(keys.map(async key => {
      if (etecnic.has(key)) return etecnic.get(key);
      if (key.startsWith('research:')) return fromResearch(key) || { key, error: 'not found' };
      if (key.startsWith('electromaps:')) {
        try { return await getElectromapsStation(key.slice(12)); }
        catch (e) { console.error('chargers:', key, e); return { key, error: 'unavailable' }; }
      }
      return { key, error: 'not found' };
    }));
    stations.filter(s => !s.error).forEach(applyResearch);

    return {
      statusCode: 200,
      // Shared by everyone with the same favourites for 15 s on Netlify's CDN (they refresh
      // every 30 s), so repeated calls don't each reach the sources
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=15',
      },
      body: JSON.stringify(stations),
    };
  } catch (e) {
    console.error('chargers:', e);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Sources unavailable' }),
    };
  }
};
