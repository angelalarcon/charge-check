const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };

  let endpoint;
  try {
    ({ endpoint } = JSON.parse(event.body));
    if (!endpoint) throw new Error();
  } catch {
    return { statusCode: 400, body: 'bad request' };
  }

  const store = getStore('ev-subscriptions');
  const key = Buffer.from(endpoint).toString('base64url').slice(0, 128);
  await store.delete(key);

  return { statusCode: 200, body: 'unsubscribed' };
};
