import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnrampProxy } from '../src/server/onramp-proxy.ts';

const apiKey = 'fnp_test_fixture';
const fullKey = 'fn_test_fixture';
const orderId = 'ord_00000000-0000-0000-0000-000000000001';
const otherId = 'ord_00000000-0000-0000-0000-000000000002';
const readToken = 'signed.test.token';
const estimate = '/v1/orchestration/estimate?sourceChain=lightning&sourceAsset=BTC&destinationChain=solana&destinationAsset=USDC&amount=1000000';
const onramp = { destinationChain: 'solana', destinationAsset: 'USDC', recipientAddress: '11111111111111111111111111111111', amount: '1000000', amountMode: 'exact_out' };
function request(path, method = 'GET', body, headers = {}) {
  return new Request('https://demo.example/api/proxy' + path, { method, headers: { 'content-type': 'application/json', 'x-idempotency-key': 'test-1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function setup(response = () => Response.json({ estimatedOut: '1000000' }), key = apiKey, baseUrl = 'https://orchestration.flashnet.xyz') {
  const calls = [];
  return { calls, proxy: createOnrampProxy({ apiKey: key, baseUrl }, async (...args) => { calls.push(args); return response(...args); }) };
}
for (const [method, path] of [
  ['GET', '/v1/partner/dashboard/operations'], ['GET', '/v1/partner/dashboard/whoami'],
  ['POST', '/v1/partner/dashboard/api-keys'], ['POST', '/v1/partner/dashboard/api-keys/key_test/disable'],
  ['GET', '/v1/orchestration/history'], ['POST', '/v1/accumulation-addresses/refund'],
  ['GET', '/v1/webhooks'], ['POST', '/v1/webhooks'], ['POST', '/v1/orchestration/submit'],
  ['POST', '/v1/orchestration/status'], ['GET', '/v1/orchestration/onramp'], ['POST', estimate],
  ['GET', '//attacker.example/v1/orchestration/estimate'],
  ['GET', '/v1/orchestration/estimate/../../partner/dashboard/api-keys'],
  ['GET', '/v1/orchestration/%65stimate'], ['GET', '/v1/orchestration/estimate%2f..%2f..%2fpartner/dashboard'],
  ['GET', '/v1/orchestration/estimate/'], ['GET', '/v1/orchestration/status;anything'],
  ['GET', '/v1/sse/operations/' + orderId + '/extra'], ['DELETE', '/v1/orchestration/status'],
]) test(`blocks ${method} ${path} without an upstream call`, async () => {
  const { proxy, calls } = setup();
  assert.equal((await proxy(request(path, method))).status, 404);
  assert.equal(calls.length, 0);
});
for (const key of ['', fullKey, 'ds_fixture']) test(`rejects unsafe configuration ${key || 'empty'}`, async () => {
  const { proxy, calls } = setup(undefined, key);
  assert.equal((await proxy(request(estimate))).status, 503);
  assert.equal(calls.length, 0);
});
for (const base of ['http://api.example', 'https://user:pass@api.example', 'https://api.example/path', 'https://api.example/?redirect=x']) test(`rejects unsafe base ${base}`, async () => {
  const { proxy, calls } = setup(undefined, apiKey, base);
  assert.equal((await proxy(request(estimate))).status, 503);
  assert.equal(calls.length, 0);
});
test('estimate uses only configured credentials and disables cache and redirects', async () => {
  const { proxy, calls } = setup(() => Response.json({ estimatedOut: '100', privateMetadata: 'hidden' }, { headers: { 'Set-Cookie': 'secret=value', 'X-Api-Key': apiKey } }));
  const response = await proxy(request(estimate, 'GET', undefined, { Authorization: 'Bearer attacker', Cookie: 'session=attacker', 'X-Forwarded-Host': 'attacker.example' }));
  assert.deepEqual(await response.json(), { estimatedOut: '100' });
  assert.equal(calls[0][0].origin, 'https://orchestration.flashnet.xyz');
  const opts = calls[0][1];
  assert.equal(opts.headers.get('authorization'), 'Bearer ' + apiKey);
  assert.equal(opts.headers.has('cookie'), false);
  assert.equal(opts.headers.has('x-forwarded-host'), false);
  assert.equal(opts.redirect, 'manual'); assert.equal(opts.cache, 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});
for (const suffix of ['&token=attacker', '&amount=1', '&feeBps=0', '&redirect=https://attacker.example']) test('rejects extra/duplicate estimate query ' + suffix, async () => {
  const { proxy, calls } = setup(); assert.equal((await proxy(request(estimate + suffix))).status, 400); assert.equal(calls.length, 0);
});
for (const path of ['/v1/orchestration/status?id=' + orderId, '/v1/sse/operations/' + orderId]) test('requires read token for ' + path, async () => {
  const { proxy, calls } = setup(); assert.equal((await proxy(request(path))).status, 403); assert.equal(calls.length, 0);
});
test('status forwards token for verification and returns status only', async () => {
  const { proxy, calls } = setup(() => Response.json({ order: { status: 'completed', recipientAddress: 'private', metadata: {} }, stages: ['private'] }));
  const response = await proxy(request(`/v1/orchestration/status?id=${orderId}&readToken=${readToken}`));
  assert.deepEqual(await response.json(), { order: { status: 'completed' } });
  assert.equal(calls[0][1].headers.get('x-read-token'), readToken);
  assert.equal(calls[0][1].headers.get('x-flashnet-proxy-read'), '1');
  assert.equal(calls[0][0].searchParams.get('id'), orderId);
});
test('forged or other-order read tokens remain denied by the upstream verifier', async () => {
  const { proxy } = setup((url, opts) => opts.headers.get('x-read-token') === readToken && url.searchParams.get('id') === orderId
    ? Response.json({ order: { status: 'processing' } }) : Response.json({ error: 'invalid_read_token' }, { status: 403 }));
  for (const [id, token] of [[otherId, readToken], [orderId, 'forged'], [orderId, 'expired']]) {
    assert.equal((await proxy(request(`/v1/orchestration/status?id=${id}&readToken=${token}`))).status, 403);
  }
});
test('SSE forwards server credential and order token only to upstream', async () => {
  const { proxy, calls } = setup(() => new Response('event: status\ndata: {"status":"completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const response = await proxy(request(`/v1/sse/operations/${orderId}?readToken=${readToken}`));
  assert.equal(calls[0][0].searchParams.get('token'), apiKey);
  assert.equal(calls[0][0].searchParams.get('readToken'), readToken);
  assert.equal(response.headers.get('location'), null);
  assert.equal((await response.text()).includes(apiKey), false);
});
for (const path of [`/v1/orchestration/status?id=${orderId}&id=${otherId}&readToken=${readToken}`, `/v1/sse/operations/${orderId}?readToken=${readToken}&token=attacker`, `/v1/orchestration/status?id=${orderId}&readToken=${readToken}&txHash=private`]) test('rejects ambiguous read ' + path, async () => {
  const { proxy, calls } = setup(); assert.equal((await proxy(request(path))).status, 400); assert.equal(calls.length, 0);
});
test('onramp returns read token and retains idempotency', async () => {
  const { proxy, calls } = setup(() => Response.json({ orderId, readToken, amountIn: '1000', adminKey: 'must not be returned' }));
  const response = await proxy(request('/v1/orchestration/onramp', 'POST', onramp));
  assert.deepEqual(await response.json(), { orderId, readToken, amountIn: '1000' });
  assert.equal(calls[0][1].headers.get('x-idempotency-key'), 'test-1');
  assert.deepEqual(JSON.parse(calls[0][1].body), onramp);
});
for (const body of [{ ...onramp, feeBps: 0 }, { ...onramp, destinationChain: 'ethereum' }, { ...onramp, refundAddress: 'attacker' }, { ...onramp, amount: '1.5' }, { ...onramp, amountMode: 'exact_in' }, { ...onramp, recipientAddress: 'x'.repeat(5000) }, null]) test('rejects unsupported onramp input ' + JSON.stringify(body).slice(0,80), async () => {
  const { proxy, calls } = setup(); assert.equal((await proxy(request('/v1/orchestration/onramp', 'POST', body))).status, 400); assert.equal(calls.length, 0);
});
test('onramp fails closed if upstream does not provide a read token', async () => {
  const { proxy } = setup(() => Response.json({ orderId }));
  assert.equal((await proxy(request('/v1/orchestration/onramp', 'POST', onramp))).status, 502);
});
test('upstream redirects, errors, and exception URLs cannot disclose credentials', async () => {
  for (const response of [() => new Response(null, { status: 307, headers: { Location: 'https://attacker.example/?token=' + apiKey } }), () => new Response(apiKey, { status: 500 }), () => { throw new Error('https://api.example/?token=' + apiKey); }]) {
    const { proxy, calls } = setup(response); const res = await proxy(request(estimate));
    assert.equal(res.status, 502); assert.equal(res.headers.get('location'), null); assert.equal((await res.text()).includes(apiKey), false); assert.equal(calls.length, 1);
  }
});
test('screened onramp preserves 202 and its order read capability without payment details', async () => {
  const { proxy } = setup(() => Response.json({ orderId, readToken, status: 'paused', privateMetadata: 'hidden' }, { status: 202 }));
  const response = await proxy(request('/v1/orchestration/onramp', 'POST', onramp));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { orderId, readToken, status: 'paused' });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});
test('does not forward caller method/path override headers', async () => {
  const { proxy, calls } = setup();
  assert.equal((await proxy(request(estimate, 'GET', undefined, {
    'X-HTTP-Method-Override': 'POST', 'X-Original-URL': '/v1/partner/dashboard/api-keys',
    'X-Rewrite-URL': '/v1/partner/dashboard/api-keys', 'X-Forwarded-For': 'attacker',
  }))).status, 200);
  for (const header of ['x-http-method-override', 'x-original-url', 'x-rewrite-url', 'x-forwarded-for']) {
    assert.equal(calls[0][1].headers.has(header), false);
  }
});
