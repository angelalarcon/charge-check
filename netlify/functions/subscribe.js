const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };

  let sub;
  try {
    sub = JSON.parse(event.body);
    if (!sub || !sub.endpoint) throw new Error('invalid body');
  } catch {
    return { statusCode: 400, body: 'bad request' };
  }

  const store = getStore('ev-subscriptions');
  const key = Buffer.from(sub.endpoint).toString('base64url').slice(0, 128);
  await store.set(key, JSON.stringify(sub));

  return { statusCode: 201, body: 'subscribed' };
};
