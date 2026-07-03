import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PivxClient, RpcError, AuthError, ShieldWatcher } from '../dist/index.js';

/** Stub pivxd: responds per-method from `handlers`, records requests. */
async function stubNode(handlers) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await new Promise((r) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => r(data));
    }));
    requests.push({ auth: req.headers.authorization, body });
    const out = handlers[body.method]?.(body.params) ?? { error: { code: -32601, message: 'Method not found' } };
    res.setHeader('content-type', 'application/json');
    if (out.error) res.statusCode = 500;
    res.end(JSON.stringify({ id: body.id, result: null, ...out }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { requests, port, close: () => server.close() };
}

test('client sends basic auth and JSON-RPC shape, trims trailing undefined', async () => {
  const node = await stubNode({
    getshieldbalance: () => ({ result: 123.45678901 }),
    getnewshieldaddress: () => ({ result: 'ps1new' }),
  });
  try {
    const client = new PivxClient({ port: node.port, user: 'u', pass: 'p' });
    const balance = await client.getShieldBalance('*', 6); // includeWatchOnly stays default=false → sent
    assert.equal(balance, 123.45678901);

    const req = node.requests[0];
    assert.equal(req.auth, 'Basic ' + Buffer.from('u:p').toString('base64'));
    assert.equal(req.body.method, 'getshieldbalance');
    assert.deepEqual(req.body.params, ['*', 6, false]);
    assert.equal(req.body.jsonrpc, '1.0');

    // trailing undefined trimmed
    await client.call('getnewshieldaddress', undefined);
    assert.deepEqual(node.requests[1].body.params, []);
  } finally {
    node.close();
  }
});

test('node errors surface as RpcError with code intact', async () => {
  const node = await stubNode({
    shieldsendmany: () => ({ error: { code: -13, message: 'Please enter the wallet passphrase' } }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    await assert.rejects(
      client.shieldSendMany('from_shield', [{ address: 'ps1x', amount: 1 }]),
      (err) => err instanceof RpcError && err.code === -13 && /passphrase/.test(err.message),
    );
  } finally {
    node.close();
  }
});

/** Stub node that 401s unless the request carries `expected()` basic auth. */
async function authNode(expected) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.headers.authorization !== expected()) {
      res.statusCode = 401;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 1, result: 42, error: null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, hits: () => hits, reset: () => (hits = 0), close: () => server.close() };
}

const basic = (creds) => 'Basic ' + Buffer.from(creds).toString('base64');

test('fromCookie parses user:pa:ss (splits on the first colon only)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pivx-cookie-'));
  const node = await authNode(() => basic('user:pa:ss'));
  try {
    const cookie = join(dir, '.cookie');
    writeFileSync(cookie, 'user:pa:ss\n'); // trailing newline must be trimmed
    const client = await PivxClient.fromCookie(cookie, { port: node.port });
    assert.equal(await client.getBlockCount(), 42);
    assert.equal(node.hits(), 1);
  } finally {
    node.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('401 with a rotated cookie file refreshes credentials and retries once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pivx-cookie-'));
  const node = await authNode(() => basic('__cookie__:new'));
  try {
    const cookie = join(dir, '.cookie');
    writeFileSync(cookie, '__cookie__:old');
    const client = await PivxClient.fromCookie(cookie, { port: node.port });

    // Cookie unchanged on disk: refresh finds the same credentials → AuthError, no retry.
    await assert.rejects(
      client.getBlockCount(),
      (err) => err instanceof AuthError && /authentication/.test(err.message),
    );
    assert.equal(node.hits(), 1, 'no retry when the cookie did not change');

    // Node restarted and rewrote the cookie: 401 → re-read → retry once → success.
    writeFileSync(cookie, '__cookie__:new');
    node.reset();
    assert.equal(await client.getBlockCount(), 42);
    assert.equal(node.hits(), 2, 'one 401 then one authenticated retry');

    // The refreshed credentials stick for subsequent calls.
    node.reset();
    assert.equal(await client.getBlockCount(), 42);
    assert.equal(node.hits(), 1);
  } finally {
    node.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plain 401 with user/pass auth throws AuthError without retrying', async () => {
  const node = await authNode(() => basic('right:creds'));
  try {
    const client = new PivxClient({ port: node.port, user: 'wrong', pass: 'creds' });
    await assert.rejects(
      client.getBlockCount(),
      (err) => err instanceof AuthError && err.name === 'AuthError' && /authentication/.test(err.message),
    );
    assert.equal(node.hits(), 1);
  } finally {
    node.close();
  }
});

test('403 does not trigger a cookie refresh (ACL denial a cookie cannot fix)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pivx-cookie-'));
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    res.statusCode = 403;
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const cookie = join(dir, '.cookie');
    writeFileSync(cookie, '__cookie__:old');
    const client = await PivxClient.fromCookie(cookie, { port: server.address().port });
    // Even though the cookie changes on disk, a 403 must not re-read/retry.
    writeFileSync(cookie, '__cookie__:new');
    await assert.rejects(client.getBlockCount(), (err) => err instanceof AuthError && err.status === 403);
    assert.equal(hits, 1, '403 is not retried');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fromCookie rejects an oversized cookie file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pivx-cookie-'));
  try {
    const cookie = join(dir, '.cookie');
    writeFileSync(cookie, 'user:' + 'x'.repeat(5000));
    await assert.rejects(PivxClient.fromCookie(cookie, {}), /too large/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ShieldWatcher emits note/spent/balance from diffs, primes silently', async () => {
  const note = (txid, outindex, amount) => ({
    txid, outindex, confirmations: 2, spendable: false,
    address: 'ps1watch', amount, memo: '',
  });
  let tip = 'aaa';
  let notes = [note('t1', 0, 5)];
  const node = await stubNode({
    getbestblockhash: () => ({ result: tip }),
    listshieldunspent: () => ({ result: notes }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const watcher = new ShieldWatcher(client, { addresses: ['ps1watch'] });
    const events = [];
    watcher.on('note', (n) => events.push(['note', n.txid]));
    watcher.on('spent', (n) => events.push(['spent', n.txid]));
    watcher.on('balance', (b, prev) => events.push(['balance', b, prev]));

    await watcher.poll(); // prime: no events
    assert.deepEqual(events, []);
    assert.equal(watcher.balance, 5);

    // same tip → no re-fetch, no events
    await watcher.poll();
    assert.deepEqual(events, []);

    // new block: t1 spent, t2+t3 arrive
    tip = 'bbb';
    notes = [note('t2', 0, 3), note('t3', 1, 4)];
    await watcher.poll();

    assert.deepEqual(events.sort(), [
      ['balance', 7, 5],
      ['note', 't2'],
      ['note', 't3'],
      ['spent', 't1'],
    ].sort());
    assert.equal(watcher.balance, 7);
    assert.equal(watcher.unspent.length, 2);
  } finally {
    node.close();
  }
});

test('balance change detection is integer-sat: FP noise fires no spurious event', async () => {
  const note = (txid, outindex, amount) => ({
    txid, outindex, confirmations: 2, spendable: false,
    address: 'ps1watch', amount, memo: '',
  });
  let tip = 'aaa';
  let notes = [note('t1', 0, 0.3)];
  const node = await stubNode({
    getbestblockhash: () => ({ result: tip }),
    listshieldunspent: () => ({ result: notes }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const watcher = new ShieldWatcher(client, { addresses: ['ps1watch'] });
    const balances = [];
    watcher.on('balance', (b, prev) => balances.push([b, prev]));

    await watcher.poll(); // prime at 0.3 PIV

    // Same true sat sum (30000000) but 0.1 + 0.2 !== 0.3 as floats.
    tip = 'bbb';
    notes = [note('t2', 0, 0.1), note('t3', 1, 0.2)];
    await watcher.poll();
    assert.deepEqual(balances, [], 'no spurious balance event from float noise');

    // A real 1-sat change still fires, with PIV-float payload values.
    tip = 'ccc';
    notes = [note('t2', 0, 0.1), note('t3', 1, 0.2), note('t4', 0, 0.00000001)];
    await watcher.poll();
    assert.equal(balances.length, 1);
    assert.equal(Math.round(balances[0][0] * 1e8), 30000001);
  } finally {
    node.close();
  }
});
