import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PivxClient,
  RpcError,
  AuthError,
  MalformedResponseError,
  ResponseTooLargeError,
  TransportError,
  ShieldWatcher,
} from '../dist/index.js';

/** Stub pivxd: responds per-method from `handlers`, records requests. */
async function stubNode(handlers) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await new Promise((r) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => r(data));
    }));
    requests.push({ auth: req.headers.authorization, url: req.url, body });
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
  const server = createServer(async (req, res) => {
    hits++;
    const body = JSON.parse(await new Promise((r) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => r(data));
    }));
    if (req.headers.authorization !== expected()) {
      res.statusCode = 401;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: body.id, result: 42, error: null }));
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

/** Batch stub: echoes the request array, replies with a JSON array of results
 * at the given HTTP status (default 200). */
async function batchNode(reply, status = 200) {
  let received;
  const server = createServer(async (req, res) => {
    received = JSON.parse(await new Promise((r) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => r(d));
    }));
    res.statusCode = status;
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

test('batch attributes reordered response elements by id', async () => {
  // Node returns the two results in the opposite order; matching by id must
  // still map each result to the correct call.
  const node = await batchNode((reqs) => [
    { id: reqs[1].id, result: 'second', error: null },
    { id: reqs[0].id, result: 42, error: null },
  ]);
  try {
    const client = new PivxClient({ port: node.port });
    const out = await client.batch([
      { method: 'getblockcount' },
      { method: 'getbestblockhash' },
    ]);
    assert.deepEqual(out, [{ result: 42 }, { result: 'second' }]);
  } finally {
    node.close();
  }
});

test('batch rejects an element whose id matches no request', async () => {
  // Second element carries an id no request used → request id N has no reply,
  // so the batch cannot be attributed and fails with a labeled error.
  const node = await batchNode((reqs) => [
    { id: reqs[0].id, result: 42, error: null },
    { id: reqs[0].id + 100000, result: 7, error: null },
  ]);
  try {
    const client = new PivxClient({ port: node.port });
    await assert.rejects(
      client.batch([{ method: 'getblockcount' }, { method: 'getbestblockhash' }]),
      /batch: no response element for request id/,
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

test('getNetworkInfo typed: present optional, absent optional, extra field survives index signature', async () => {
  const node = await stubNode({
    getnetworkinfo: () => ({
      result: {
        version: 5060000, subversion: '/PIVX Core:5.6.0/', protocolversion: 70926,
        timeoffset: 0, connections: 8, // localservices/networkactive absent (optional)
        networks: [{ name: 'ipv4', limited: false, reachable: true, proxy: '', proxy_randomize_credentials: false }],
        relayfee: 0.00001, localaddresses: [], warnings: '',
        future_field: 'survives', // unknown extra: must pass through the [key]: unknown index signature
      },
    }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const info = await client.getNetworkInfo();
    assert.equal(info.version, 5060000);
    assert.equal(info.connections, 8);            // present optional
    assert.equal(info.localservices, undefined);  // absent optional
    assert.equal(info.networks[0].name, 'ipv4');  // typed nested array element
    assert.equal(info.future_field, 'survives');  // extra field survives
  } finally {
    node.close();
  }
});

test('estimateSmartFee typed: -1 feerate sentinel when there is not enough data', async () => {
  const node = await stubNode({
    estimatesmartfee: (p) => ({ result: p[0] > 100 ? { feerate: -1, blocks: p[0] } : { feerate: 0.0002, blocks: p[0] } }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const none = await client.estimateSmartFee(1000);
    assert.equal(none.feerate, -1);   // sentinel: no estimate
    assert.equal(none.blocks, 1000);
    const ok = await client.estimateSmartFee(6);
    assert.equal(ok.feerate, 0.0002);
  } finally {
    node.close();
  }
});

test('getBlockIndexStats typed: space-separated keys and string money fields', async () => {
  const node = await stubNode({
    getblockindexstats: () => ({
      result: {
        'Starting block': 100, 'Ending block': 200,
        txcount: 50, txcount_all: 60, txbytes: 12345,
        ttlfee: '0.01234567', feeperkb: '0.00010000', // money STRINGS, not numbers
        extra_metric: 7, // unknown extra survives
      },
    }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const s = await client.getBlockIndexStats(200, 100);
    assert.deepEqual(node.requests[0].body.params, [200, 100]);
    assert.equal(s['Starting block'], 100);   // quoted space-key property
    assert.equal(s['Ending block'], 200);
    assert.equal(typeof s.ttlfee, 'string');   // money is a string
    assert.equal(s.ttlfee, '0.01234567');
    assert.equal(typeof s.feeperkb, 'string');
    assert.equal(s.extra_metric, 7);           // extra field survives
  } finally {
    node.close();
  }
});

test('getRawMempool: txid array (non-verbose) and keyed MempoolEntry objects (verbose)', async () => {
  const node = await stubNode({
    getrawmempool: (p) => (p[0] === true
      ? ({
          result: {
            abc: {
              size: 200, fee: 0.0001, modifiedfee: 0.0001, time: 1700000000, height: 1000,
              descendantcount: 1, descendantsize: 200, descendantfees: 10000, depends: [],
            },
          },
        })
      : ({ result: ['abc', 'def'] })),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const ids = await client.getRawMempool();          // non-verbose overload → string[]
    assert.deepEqual(ids, ['abc', 'def']);
    const verbose = await client.getRawMempool(true);  // verbose overload → Record<string, MempoolEntry>
    assert.equal(verbose.abc.size, 200);
    assert.equal(verbose.abc.descendantfees, 10000);   // raw satoshis (integer), not PIV
    assert.equal(verbose.abc.depends.length, 0);
  } finally {
    node.close();
  }
});

/** Server that replies with a fixed raw body regardless of the request. */
async function rawNode(rawBody, status = 200) {
  const server = createServer((req, res) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(rawBody);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, close: () => server.close() };
}

test('getMasternodeCount: typed object; bare "unknown" (no chain tip) throws RpcError', async () => {
  let result = { total: 10, stable: 9, enabled: 8, inqueue: 7, ipv4: 6, ipv6: 1, onion: 3 };
  const node = await stubNode({ getmasternodecount: () => ({ result }) });
  try {
    const client = new PivxClient({ port: node.port });
    const count = await client.getMasternodeCount();
    assert.equal(count.total, 10);
    assert.equal(count.stable, 9);
    assert.equal(count.enabled, 8);
    assert.equal(count.inqueue, 7);
    assert.equal(count.ipv4, 6);
    assert.equal(count.ipv6, 1);
    assert.equal(count.onion, 3);

    // A node without a chain tip returns the bare string "unknown" — an
    // RpcError (code 0), so instanceof RpcError matches the Rust SDK's
    // Error::Rpc classification.
    result = 'unknown';
    await assert.rejects(
      client.getMasternodeCount(),
      (err) =>
        err instanceof RpcError &&
        err.code === 0 &&
        err.method === 'getmasternodecount' &&
        /node has no chain tip yet/.test(err.message),
    );

    // Only the literal "unknown" maps to the chain-tip error. Any other
    // non-object — including an array, which typeof reports as 'object' —
    // is a malformed response.
    for (const bad of [[], 7, 'banana']) {
      result = bad;
      await assert.rejects(
        client.getMasternodeCount(),
        (err) =>
          !(err instanceof RpcError) &&
          /getmasternodecount: malformed response \(expected a JSON object\)/.test(err.message),
        `result ${JSON.stringify(bad)} must be rejected as malformed`,
      );
    }
  } finally {
    node.close();
  }
});

test('viewShieldTransaction: fee is a money string; value can be the string "unknown"', async () => {
  const node = await stubNode({
    viewshieldtransaction: () => ({
      result: {
        txid: 't1',
        fee: '0.00010000', // FormatMoney STRING, exactly as the node emits it
        spends: [
          // Undecryptable spend: address/value are the string "unknown", valueSat 0.
          { spend: 0, txidPrev: 'p1', outputPrev: 0, address: 'unknown', value: 'unknown', valueSat: 0 },
        ],
        outputs: [
          { output: 0, outgoing: false, address: 'ps1x', value: 1.5, valueSat: 150000000, memo: 'f6' },
        ],
      },
    }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const view = await client.viewShieldTransaction('t1');
    assert.equal(typeof view.fee, 'string');
    assert.equal(view.fee, '0.00010000');
    assert.equal(view.spends[0].value, 'unknown');
    assert.equal(view.spends[0].valueSat, 0);       // the reliable integer field
    assert.equal(view.outputs[0].value, 1.5);
    assert.equal(view.outputs[0].valueSat, 150000000);
  } finally {
    node.close();
  }
});

test('interior optional params are substituted with node defaults, never null', async () => {
  const node = await stubNode({
    shieldsendmany: () => ({ result: 'txid1' }),
    rawshieldsendmany: () => ({ result: 'rawhex' }),
    importsaplingkey: () => ({ result: { address: 'ps1' } }),
    importsaplingviewingkey: () => ({ result: { address: 'ps1' } }),
    protx_list: () => ({ result: [] }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const recip = [{ address: 'ps1x', amount: 1 }];
    const params = (i) => node.requests[i].body.params;

    // shieldsendmany: minconf defaults to 1; fee 0 = "node computes the fee".
    await client.shieldSendMany('from_shield', recip);
    assert.deepEqual(params(0), ['from_shield', recip, 1, 0]);
    await client.shieldSendMany('from_shield', recip, undefined, 0.001);
    assert.deepEqual(params(1), ['from_shield', recip, 1, 0.001]);
    await client.shieldSendMany('from_shield', recip, 5, undefined, ['ps1x']);
    assert.deepEqual(params(2), ['from_shield', recip, 5, 0, ['ps1x']]);

    await client.rawShieldSendMany('from_shield', recip);
    assert.deepEqual(params(3), ['from_shield', recip, 1, 0]);
    await client.rawShieldSendMany('from_shield', recip, undefined, 0.5);
    assert.deepEqual(params(4), ['from_shield', recip, 1, 0.5]);

    // import keys: rescan default "whenkeyisnew" is substituted only when a
    // later param (height) would otherwise leave an interior null.
    await client.importSaplingKey('KEY');
    assert.deepEqual(params(5), ['KEY']);
    await client.importSaplingKey('KEY', undefined, 100);
    assert.deepEqual(params(6), ['KEY', 'whenkeyisnew', 100]);
    await client.importSaplingKey('KEY', 'yes');
    assert.deepEqual(params(7), ['KEY', 'yes']);
    await client.importSaplingViewingKey('VKEY', undefined, 200);
    assert.deepEqual(params(8), ['VKEY', 'whenkeyisnew', 200]);

    // protx_list: node defaults detailed=true, wallet_only=false, valid_only=false.
    await client.protxList();
    assert.deepEqual(params(9), [true, false, false]);
    await client.protxList(undefined, undefined, undefined, 500);
    assert.deepEqual(params(10), [true, false, false, 500]);
    await client.protxList(false, true);
    assert.deepEqual(params(11), [false, true, false]);
  } finally {
    node.close();
  }
});

test('hostile top-level JSON bodies (null / primitive / array) fail with labeled errors', async () => {
  for (const raw of ['null', '5', '"str"', '[]']) {
    const node = await rawNode(raw);
    try {
      const client = new PivxClient({ port: node.port });
      await assert.rejects(
        client.call('getblockcount'),
        /getblockcount: malformed response/,
        `body ${raw} must be rejected with a labeled error`,
      );
    } finally {
      node.close();
    }
  }
});

test('batch: null/primitive elements fail with a labeled error', async () => {
  const node = await batchNode(() => [null]);
  try {
    const client = new PivxClient({ port: node.port });
    await assert.rejects(
      client.batch([{ method: 'getblockcount' }]),
      /batch: malformed response element/,
    );
  } finally {
    node.close();
  }
});

test('batch: whole-request error object surfaces the node code/message as RpcError', async () => {
  const node = await batchNode(() => ({ error: { code: -32600, message: 'Invalid Request' } }));
  try {
    const client = new PivxClient({ port: node.port });
    await assert.rejects(
      client.batch([{ method: 'getblockcount' }]),
      (err) => err instanceof RpcError && err.code === -32600 && /Invalid Request/.test(err.message),
    );
  } finally {
    node.close();
  }
});

test('batch: a valid array body on a non-2xx status is rejected (parity with single-call/Rust)', async () => {
  // Hostile/broken endpoint: correct per-call array but HTTP 500. Without the
  // status check this was accepted as a normal batch; now it is rejected, like
  // the single-call `if (!res.ok)` and Rust batch's Error::Http.
  const node = await batchNode((reqs) => [{ id: reqs[0].id, result: 100, error: null }], 500);
  try {
    const client = new PivxClient({ port: node.port });
    await assert.rejects(client.batch([{ method: 'getblockcount' }]), /batch: HTTP 500/);
  } finally {
    node.close();
  }
});

test('response id mismatch throws a labeled error', async () => {
  const node = await rawNode(JSON.stringify({ id: 424242, result: 1, error: null }));
  try {
    const client = new PivxClient({ port: node.port });
    await assert.rejects(client.call('getblockcount'), /getblockcount: response id mismatch/);
  } finally {
    node.close();
  }
});

test('money-bearing methods reject mistyped results with labeled errors', async () => {
  const node = await stubNode({
    getbalance: () => ({ result: '1.5' }),
    getshieldbalance: () => ({ result: null }),
    getcoldstakingbalance: () => ({ result: {} }),
    sendtoaddress: () => ({ result: 42 }),
    getblockcount: () => ({ result: '100' }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    await assert.rejects(client.getBalance(), /getbalance: expected a number result/);
    await assert.rejects(client.getShieldBalance(), /getshieldbalance: expected a number result/);
    await assert.rejects(
      client.getColdStakingBalance(),
      /getcoldstakingbalance: expected a number result/,
    );
    await assert.rejects(client.sendToAddress('D1', 1), /sendtoaddress: expected a string result/);
    await assert.rejects(client.getBlockCount(), /getblockcount: expected a number result/);
  } finally {
    node.close();
  }
});

test('transport failures carry the method name', async () => {
  // Grab a port that nothing listens on.
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  probe.close();
  await once(probe, 'close');

  const client = new PivxClient({ port, timeoutMs: 2000 });
  await assert.rejects(client.getBlockCount(), /getblockcount: transport failure/);
});

test('B1: typed rpc error classes (parity with Rust Error::{Json,ResponseTooLarge,Transport})', async () => {
  // Malformed envelope: a null/primitive/array body → MalformedResponseError.
  for (const raw of ['null', '5', '"str"', '[]']) {
    const node = await rawNode(raw);
    try {
      const client = new PivxClient({ port: node.port });
      await assert.rejects(
        client.call('getblockcount'),
        (err) => err instanceof MalformedResponseError && err instanceof Error,
        `body ${raw} must be a MalformedResponseError`,
      );
    } finally {
      node.close();
    }
  }

  // Over-cap body → ResponseTooLargeError (content-length exceeds the cap).
  {
    const node = await rawNode(JSON.stringify({ id: 0, result: 'x'.repeat(1000), error: null }));
    try {
      const client = new PivxClient({ port: node.port, maxResponseBytes: 16 });
      await assert.rejects(
        client.call('getblockcount'),
        (err) => err instanceof ResponseTooLargeError && err instanceof Error,
      );
    } finally {
      node.close();
    }
  }

  // Fetch failure (nothing listening) → TransportError, original kept as cause.
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  probe.close();
  await once(probe, 'close');
  const client = new PivxClient({ port, timeoutMs: 2000 });
  await assert.rejects(
    client.getBlockCount(),
    (err) => err instanceof TransportError && err instanceof Error && err.cause !== undefined,
  );
});

test('wallet name is URL-encoded in the endpoint path', async () => {
  const node = await stubNode({ getblockcount: () => ({ result: 1 }) });
  try {
    const client = new PivxClient({ port: node.port, wallet: 'my wallet#1' });
    await client.getBlockCount();
    assert.equal(node.requests[0].url, '/wallet/my%20wallet%231');
  } finally {
    node.close();
  }
});

test('constructor rejects credentials embedded in the URL', () => {
  assert.throws(
    () => new PivxClient({ url: 'http://user:pass@127.0.0.1:51473' }),
    /credentials in the URL are not supported/,
  );
});

test('importSaplingKey with a rescan outlives the default request timeout', async () => {
  // The stub answers after 150ms; the client timeout is 50ms. Only the
  // import calls (rescan not "no") get the raised per-call timeout.
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await new Promise((r) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => r(d));
    }));
    await delay(150);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      id: body.id,
      result: body.method.startsWith('importsapling') ? { address: 'ps1' } : 1,
      error: null,
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = new PivxClient({ port: server.address().port, timeoutMs: 50 });
    await assert.rejects(client.getBlockCount(), /transport failure/, 'default timeout applies');
    assert.deepEqual(await client.importSaplingKey('KEY'), { address: 'ps1' });
    assert.deepEqual(await client.importSaplingViewingKey('VKEY', 'yes'), { address: 'ps1' });
    // rescan="no" keeps the default (short) timeout.
    await assert.rejects(client.importSaplingKey('KEY', 'no'), /transport failure/);
  } finally {
    server.close();
  }
});

test('ShieldWatcher commits state before emitting: a throwing listener cannot cause re-emission', async () => {
  const note = (txid, outindex, amount) => ({
    txid, outindex, confirmations: 2, spendable: false,
    address: 'ps1watch', amount, memo: '',
  });
  let tip = 'aaa';
  let notes = [];
  const node = await stubNode({
    getbestblockhash: () => ({ result: tip }),
    listshieldunspent: () => ({ result: notes }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const watcher = new ShieldWatcher(client, { addresses: ['ps1watch'] });
    const seen = [];
    const errors = [];
    let boom = true;
    watcher.on('note', (n) => {
      seen.push(n.txid);
      if (boom) {
        boom = false;
        throw new Error('listener boom');
      }
    });
    watcher.on('error', (e) => errors.push(e));

    await watcher.poll(); // prime (empty)
    tip = 'bbb';
    notes = [note('t1', 0, 5)];
    await watcher.poll(); // emits t1; the listener throws
    assert.deepEqual(seen, ['t1']);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /listener boom/);

    await watcher.poll(); // same tip: state was committed, nothing re-emitted
    assert.deepEqual(seen, ['t1'], 'no re-emission after a throwing listener');
    assert.equal(watcher.balance, 5, 'balance state was committed despite the throw');
  } finally {
    node.close();
  }
});

test('ShieldWatcher stop() during an in-flight poll suppresses emits but state still commits', async () => {
  const note = (txid, outindex, amount) => ({
    txid, outindex, confirmations: 2, spendable: false,
    address: 'ps1watch', amount, memo: '',
  });
  let tip = 'aaa';
  let notes = [];
  const node = await stubNode({
    getbestblockhash: () => ({ result: tip }),
    listshieldunspent: () => ({ result: notes }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const watcher = new ShieldWatcher(client, { addresses: ['ps1watch'] });
    const events = [];
    watcher.on('note', (n) => events.push(['note', n.txid]));
    watcher.on('block', (h) => events.push(['block', h]));
    watcher.on('error', (e) => events.push(['error', e.message]));

    // Manual poll without start(): emits normally (not treated as stopped).
    await watcher.poll(); // prime
    assert.deepEqual(events, [['block', 'aaa']]);

    tip = 'bbb';
    notes = [note('t1', 0, 5)];
    const inflight = watcher.poll(); // suspends at the first RPC await
    watcher.stop(); // stop before the poll completes
    await inflight;

    assert.deepEqual(events, [['block', 'aaa']], 'nothing may be emitted after stop()');
    assert.equal(watcher.balance, 5, 'the in-flight poll still committed state');
    assert.equal(watcher.unspent.length, 1);
  } finally {
    node.close();
  }
});

test('getBudgetInfo typed: PascalCase keys, absent optional IsInvalidReason, extra field survives', async () => {
  const node = await stubNode({
    getbudgetinfo: () => ({
      result: [{
        Name: 'proposal1', URL: 'https://x', Hash: 'h', FeeHash: 'fh',
        BlockStart: 100, BlockEnd: 200, TotalPaymentCount: 3, RemainingPaymentCount: 2,
        PaymentAddress: 'DAddr', Ratio: 1, Yeas: 10, Nays: 1, Abstains: 0,
        TotalPayment: 300, MonthlyPayment: 100, IsEstablished: true, IsValid: true,
        Allotted: 100, ExtraKey: 'kept', // IsInvalidReason absent (optional)
      }],
    }),
  });
  try {
    const client = new PivxClient({ port: node.port });
    const budgets = await client.getBudgetInfo();
    assert.equal(budgets.length, 1);
    assert.equal(budgets[0].Name, 'proposal1');          // PascalCase key
    assert.equal(budgets[0].MonthlyPayment, 100);
    assert.equal(budgets[0].IsInvalidReason, undefined); // absent optional
    assert.equal(budgets[0].ExtraKey, 'kept');           // extra field survives
  } finally {
    node.close();
  }
});
