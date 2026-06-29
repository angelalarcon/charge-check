const TARGETS = new Set(['IMESAPI - SELBA EdRSR 12', 'IMESAPI - SELBA EdRSR 16']);

exports.handler = async function () {
  try {
    const res = await fetch('https://etecnic.net/api/v1/chargers/index.json', {
      headers: {
        Origin: 'https://etecnic.es',
        Referer: 'https://etecnic.es/mapa-de-recarga/',
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    const all = await res.json();
    const filtered = all.filter(s => TARGETS.has(s.name));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(filtered),
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
