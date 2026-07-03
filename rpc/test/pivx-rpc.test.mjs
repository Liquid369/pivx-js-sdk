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

test('getBlockHeader verbose returns typed header; default verbose=true; absent optional is undefined', async () => {
  const node = await stubNode({
    getblockheader: () => ({
      result: {
        hash: 'h', confirmations: 5, height: 100, version: 1, merkleroot: 'm',
        time: 1, mediantime: 1, nonce: 0, bits: '1d00ffff', difficulty: 1,
        chainwork: '00', acc_checkpoint: '0',
        shield_pool_value: { chainValue: 1.5, valueDelta: 0.5 },
        previousblockhash: 'prev', chainlock: true, // nextblockhash absent (tip)
      },
    }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const h = await client.getBlockHeader('h');
    assert.equal(h.height, 100);
    assert.equal(h.shield_pool_value.chainValue, 1.5);
    assert.equal(h.previousblockhash, 'prev');   // present optional
    assert.equal(h.nextblockhash, undefined);    // absent optional
    assert.deepEqual(node.requests[0].body.params, ['h', true]); // default verbose=true
  } finally {
    node.close();
  }
});

test('getTxOut returns the typed object, or null when spent/not-found', async () => {
  const node = await stubNode({
    gettxout: (p) => (p[1] === 0
      ? ({ result: {
          bestblock: 'b', confirmations: 3, value: 1.5, coinbase: false,
          scriptPubKey: { asm: 'a', hex: 'aa', type: 'pubkeyhash', addresses: ['DAddr'] },
        } })
      : ({ result: null })),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const out = await client.getTxOut('t', 0);
    assert.ok(out);
    assert.equal(out.value, 1.5);
    assert.equal(out.scriptPubKey.type, 'pubkeyhash');
    assert.deepEqual(node.requests[0].body.params, ['t', 0, true]); // include_mempool default true
    assert.equal(await client.getTxOut('t', 9), null);
  } finally {
    node.close();
  }
});

test('getRawTransaction: hex when non-verbose, decoded object when verbose (absent optional undefined)', async () => {
  const node = await stubNode({
    getrawtransaction: (p) => (p[1] === 1
      ? ({ result: {
          txid: 't', version: 1, type: 0, size: 100, locktime: 0,
          vin: [], vout: [], hex: 'deadbeef', chainlock: false, // mempool tx: no confirmations/blockhash
        } })
      : ({ result: 'deadbeef' })),
  });
  try {
    const client = new PivxClient({ port: node.port });
    assert.equal(await client.getRawTransaction('t'), 'deadbeef');
    assert.deepEqual(node.requests[0].body.params, ['t', 0]);
    const d = await client.getRawTransaction('t', true);
    assert.equal(d.txid, 't');
    assert.equal(d.chainlock, false);
    assert.equal(d.confirmations, undefined); // absent optional (mempool)
    assert.deepEqual(node.requests[1].body.params, ['t', 1]);
  } finally {
    node.close();
  }
});

test('validateAddress typed: invalid → only isvalid; valid → address/ismine present', async () => {
  const node = await stubNode({
    validateaddress: (p) => (p[0] === 'bad'
      ? ({ result: { isvalid: false } })
      : ({ result: { isvalid: true, address: p[0], ismine: true, isstaking: false } })),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const bad = await client.validateAddress('bad');
    assert.equal(bad.isvalid, false);
    assert.equal(bad.address, undefined); // absent optional
    const good = await client.validateAddress('DGoodAddr');
    assert.equal(good.isvalid, true);
    assert.equal(good.address, 'DGoodAddr'); // present optional
    assert.equal(good.ismine, true);
  } finally {
    node.close();
  }
});

test('listTransactions injects dummy "*", sendMany injects dummy "", abandonTransaction resolves void', async () => {
  const node = await stubNode({
    listtransactions: () => ({ result: [] }),
    sendmany: () => ({ result: 'txidABC' }),
    abandontransaction: () => ({ result: null }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    await client.listTransactions();
    assert.deepEqual(node.requests[0].body.params, ['*', 10, 0, false, true, true]);

    assert.equal(await client.sendMany({ D1: 1.5 }, 2), 'txidABC');
    // comment undefined (not trailing) serializes to null; trailing subtractFeeFrom trimmed.
    assert.deepEqual(node.requests[1].body.params, ['', { D1: 1.5 }, 2, null, false]);

    assert.equal(await client.abandonTransaction('t'), undefined);
  } finally {
    node.close();
  }
});

/** Batch stub: echoes the request array, replies with a JSON array of results. */
async function batchNode(reply) {
  let received;
  const server = createServer(async (req, res) => {
    received = JSON.parse(await new Promise((r) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => r(d));
    }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply(received)));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, received: () => received, close: () => server.close() };
}

test('batch posts a JSON array and returns {result}/{error} in request order', async () => {
  const node = await batchNode((reqs) => [
    { id: reqs[0].id, result: 100, error: null },
    { id: reqs[1].id, result: null, error: { code: -5, message: 'nope' } },
  ]);
  try {
    const client = new PivxClient({ port: node.port });
    const out = await client.batch([
      { method: 'getblockcount' },
      { method: 'getblockhash', params: [999999999] },
    ]);
    const sent = node.received();
    assert.ok(Array.isArray(sent), 'server received a JSON array');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].method, 'getblockcount');
    assert.deepEqual(sent[0].params, []);           // missing params default to []
    assert.deepEqual(sent[1].params, [999999999]);
    assert.deepEqual(out, [
      { result: 100 },
      { error: { code: -5, message: 'nope' } },
    ]);
  } finally {
    node.close();
  }
});

test('batch rejects an empty array', async () => {
  const client = new PivxClient({ port: 1 });
  await assert.rejects(client.batch([]), /no calls/);
});

test('batch rejects a node result-count mismatch', async () => {
  const node = await batchNode(() => [{ result: 1, error: null }]); // 1 result for 2 calls
  try {
    const client = new PivxClient({ port: node.port });
    await assert.rejects(
      client.batch([{ method: 'getblockcount' }, { method: 'getbestblockhash' }]),
      /1 results for 2 calls/,
    );
  } finally {
    node.close();
  }
});

test('listSinceBlock() omitted sends no params; with a hash sends all three', async () => {
  // The node rejects a null blockhash, so an omitted hash must send empty params.
  const node = createServer(async (req, res) => {
    node.body = JSON.parse(await new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: node.body.id, result: { transactions: [], lastblock: 'lb' }, error: null }));
  });
  node.listen(0, '127.0.0.1');
  await once(node, 'listening');
  try {
    const client = new PivxClient({ port: node.address().port });
    await client.listSinceBlock();
    assert.deepEqual(node.body.params, [], 'no blockhash → empty params');
    await client.listSinceBlock('abcd', 6, true);
    assert.deepEqual(node.body.params, ['abcd', 6, true], 'blockhash → all three params');
  } finally {
    node.close();
  }
});
