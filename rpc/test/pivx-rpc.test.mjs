import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PivxClient, RpcError, ShieldWatcher } from '../dist/index.js';

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
