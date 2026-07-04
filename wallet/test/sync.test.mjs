import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PivxClient } from 'pivx-rpc';
import { PivxWallet, ScanDivergedError } from '../dist/index.js';
import { EXTSK, TX_HEX } from './fixtures.mjs';

const BIRTH = 100;
const reverseHex = (hex) => hex.match(/../g).reverse().join('');

async function stubNode(handlers) {
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await new Promise((r) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => r(data));
    }));
    const result = handlers[body.method](...body.params);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: body.id, result, error: null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, close: () => server.close() };
}

// Learn the correct post-scan sapling root by scanning a reference wallet.
async function expectedRootAfterFixture() {
  const ref = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  ref.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  const state = JSON.parse(ref.save());
  const { default: init, get_sapling_root } = await import('pivx-shield-rust');
  return reverseHex(get_sapling_root(state.commitmentTree));
}

const makeHandlers = (tipRoot) => ({
  getblockcount: () => BIRTH + 1,
  getblockhash: (h) => `hash${h}`,
  getblock: (hash) => ({
    height: Number(hash.slice(4)),
    finalsaplingroot: tipRoot,
    tx: hash === `hash${BIRTH + 1}` ? [{ hex: TX_HEX, txid: 'fixture' }] : [],
  }),
});

test('sync pulls blocks from RPC, finds the note, and verifies the sapling root', async () => {
  const goodRoot = await expectedRootAfterFixture();
  const node = await stubNode(makeHandlers(goodRoot));
  try {
    const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
    wallet['lastProcessedBlock'] = BIRTH; // stub models a chain of just one block past BIRTH
    wallet['startValidated'] = true; // synthetic stub chain: skip node checkpoint validation
    const client = new PivxClient({ port: node.port });
    const progress = [];
    await wallet.sync(client, { onProgress: (h, tip) => progress.push([h, tip]) });

    assert.equal(wallet.getBalance(), 1_000_000_000);
    assert.equal(wallet.getLastSyncedBlock(), BIRTH + 1);
    assert.deepEqual(progress, [[BIRTH + 1, BIRTH + 1]]);
  } finally {
    node.close();
  }
});

test('sync abort: throws at the batch boundary, keeps applied batches, releases busy', async () => {
  const goodRoot = await expectedRootAfterFixture();
  const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  wallet['lastProcessedBlock'] = BIRTH;
  wallet['startValidated'] = true; // synthetic stub chain: skip node checkpoint validation
  // Plain object stub: two blocks past BIRTH; the empty second block leaves the root unchanged.
  const client = {
    getBlockCount: async () => BIRTH + 2,
    getBlockHash: async (h) => `hash${h}`,
    getBlock: async (hash) => ({
      height: Number(hash.slice(4)),
      finalsaplingroot: goodRoot,
      tx: Number(hash.slice(4)) === BIRTH + 1 ? [{ hex: TX_HEX, txid: 'fixture' }] : [],
    }),
  };

  const ac = new AbortController();
  await assert.rejects(
    wallet.sync(client, { batchSize: 1, signal: ac.signal, onProgress: () => ac.abort() }),
    (err) => err.name === 'AbortError',
  );
  // Only the fully applied first batch is kept.
  assert.equal(wallet.getLastSyncedBlock(), BIRTH + 1);
  assert.equal(wallet.getBalance(), 1_000_000_000);

  // Busy guard released: a follow-up sync resumes and completes.
  await wallet.sync(client, { batchSize: 1 });
  assert.equal(wallet.getLastSyncedBlock(), BIRTH + 2);
  assert.equal(wallet.getBalance(), 1_000_000_000);
});

test('sync fails loudly when the node sapling root diverges', async () => {
  const node = await stubNode(makeHandlers('00'.repeat(32)));
  try {
    const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
    wallet['lastProcessedBlock'] = BIRTH;
    wallet['startValidated'] = true; // synthetic stub chain: skip node checkpoint validation
    const client = new PivxClient({ port: node.port });
    await assert.rejects(wallet.sync(client), ScanDivergedError);
  } finally {
    node.close();
  }
});

// Advance a wallet to the tip by scanning the fixture, so lastProcessedBlock
// === tip with a real commitment tree — the stale-tip case the batch loop's
// per-batch root check can't reach (the loop never runs).
async function walletAtTip() {
  const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  wallet.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  wallet['startValidated'] = true; // synthetic stub chain: skip node checkpoint validation
  return wallet;
}

test('stale tip (lastProcessed === tip): matching tip root is a clean no-op', async () => {
  const goodRoot = await expectedRootAfterFixture();
  const node = await stubNode(makeHandlers(goodRoot));
  try {
    const wallet = await walletAtTip();
    assert.equal(wallet.getLastSyncedBlock(), BIRTH + 1);
    const client = new PivxClient({ port: node.port });
    await wallet.sync(client); // lastProcessed === tip and tip root matches → no throw
    assert.equal(wallet.getBalance(), 1_000_000_000);
    assert.equal(wallet.getLastSyncedBlock(), BIRTH + 1);
  } finally {
    node.close();
  }
});

test('stale tip (lastProcessed === tip): differing tip root throws ScanDiverged; reload recovers', async () => {
  const goodRoot = await expectedRootAfterFixture();
  const wallet = await walletAtTip();

  // A same-height reorg changed the shielded set: the node's tip root differs
  // from our local one though the height is unchanged.
  const badNode = await stubNode(makeHandlers('00'.repeat(32)));
  try {
    const client = new PivxClient({ port: badNode.port });
    await assert.rejects(wallet.sync(client), ScanDivergedError);
    // The guard throws before the batch loop; no state was mutated.
    assert.equal(wallet.getLastSyncedBlock(), BIRTH + 1);
    assert.equal(wallet.getBalance(), 1_000_000_000);
  } finally {
    badNode.close();
  }

  // Recovery: reset to the checkpoint (drops notes), then resync a healthy node.
  wallet.reloadFromCheckpoint(BIRTH);
  assert.equal(wallet.getBalance(), 0);
  const goodNode = await stubNode(makeHandlers(goodRoot));
  try {
    wallet['lastProcessedBlock'] = BIRTH; // model the stub's one-block-past-checkpoint chain
    wallet['startValidated'] = true;
    const client = new PivxClient({ port: goodNode.port });
    await wallet.sync(client);
    assert.equal(wallet.getBalance(), 1_000_000_000);
    assert.equal(wallet.getLastSyncedBlock(), BIRTH + 1);
  } finally {
    goodNode.close();
  }
});
