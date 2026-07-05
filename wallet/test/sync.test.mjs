import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PivxClient } from 'pivx-rpc';
import { PivxWallet, ScanDivergedError } from '../dist/index.js';
import { EXTSK, TX_HEX } from './fixtures.mjs';

// Keep >= 200 so the fixture/synced block (BIRTH + 1) is >= 201 (testnet V5_0
// activation): the batch-loop and stale-tip sapling-root checks only run at/above
// activation, so a lower BIRTH would silently skip the very check these tests
// exist to exercise. Genuinely below-activation cases hardcode their own heights.
const BIRTH = 300;
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
    // Synced block BIRTH + 1 is >= 201, so the batch-loop root check runs and
    // genuinely verifies the built tree against the node's finalsaplingroot.
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
  // A height well above real V5_0 activation (201), where the per-batch root
  // check runs (below activation the node reports a zero root our non-zero empty
  // tree can't match, so it is skipped).
  const H = 43_200;
  const node = await stubNode({
    getblockcount: () => H + 1,
    getblockhash: (h) => `hash${h}`,
    getblock: (hash) => ({ height: Number(hash.slice(4)), finalsaplingroot: '00'.repeat(32), tx: [] }),
  });
  try {
    const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
    wallet['lastProcessedBlock'] = H;
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
    // lastProcessed === tip === BIRTH + 1 (>= 201), so the stale-tip check runs
    // and genuinely compares local vs node root; they match → clean no-op.
    await wallet.sync(client);
    assert.equal(wallet.getBalance(), 1_000_000_000);
    assert.equal(wallet.getLastSyncedBlock(), BIRTH + 1);
  } finally {
    node.close();
  }
});

test('stale tip (lastProcessed === tip): differing tip root throws ScanDiverged; reload recovers', async () => {
  // Above sapling activation (checkpoint 86400) so the stale-tip check runs;
  // below activation the node reports a zero root our non-zero empty tree can't
  // match, so the check is skipped and there is nothing to diverge on.
  const wallet = await walletOnCheckpoint();
  const H = wallet.getLastSyncedBlock();
  const { get_sapling_root } = await import('pivx-shield-rust');
  const goodRoot = reverseHex(get_sapling_root(JSON.parse(wallet.save()).commitmentTree));

  // A same-height reorg changed the shielded set: the node's tip root differs
  // from our local one though the height is unchanged.
  const badNode = await stubNode(cpHandlers('00'.repeat(32), H));
  try {
    const client = new PivxClient({ port: badNode.port });
    await assert.rejects(wallet.sync(client), ScanDivergedError);
    // The guard throws before the batch loop; no state was mutated.
    assert.equal(wallet.getLastSyncedBlock(), H);
  } finally {
    badNode.close();
  }

  // Recovery: reset to the checkpoint, then resync against a healthy node whose
  // tip root matches the checkpoint tree.
  wallet.reloadFromCheckpoint(H);
  const goodNode = await stubNode(cpHandlers(goodRoot, H));
  try {
    wallet['startValidated'] = true;
    const client = new PivxClient({ port: goodNode.port });
    await wallet.sync(client);
    assert.equal(wallet.getLastSyncedBlock(), H);
  } finally {
    goodNode.close();
  }
});

// Finding 1: at an EXACT bundled-checkpoint height (lastProcessed === tip === H,
// H itself a checkpoint) the old closest-checkpoint gate — `lastProcessed >
// closestCheckpoint(lastProcessed)` — was false, so the tip-root check was
// skipped and a same-height reorg at H went undetected. birthHeight 100000
// lands the wallet on a real testnet checkpoint (H = 86400, above sapling
// activation) with no scanned notes: the pure checkpoint-height case.
const cpHandlers = (root, H) => ({
  getblockcount: () => H,
  getblockhash: (h) => `hash${h}`,
  getblock: (hash) => ({ height: Number(hash.slice(4)), finalsaplingroot: root, tx: [] }),
});

const walletOnCheckpoint = async () => {
  const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: 100_000 });
  // Isolate the tip-root gate from ensureValidCheckpoint (its own divergence
  // path would otherwise throw regardless of the gate, masking the fix).
  wallet['startValidated'] = true;
  return wallet;
};

test('checkpoint-height stale tip: differing tip root throws ScanDiverged (gate removed)', async () => {
  const wallet = await walletOnCheckpoint();
  const H = wallet.getLastSyncedBlock(); // exact bundled-checkpoint height
  assert.ok(H > 0);
  // Same-height reorg: node reports a different finalsaplingroot at H. Before the
  // gate removal this was a silent no-op; now the reorg is caught. This test
  // FAILS (no throw) before the fix and PASSES after.
  const node = await stubNode(cpHandlers('00'.repeat(32), H));
  try {
    await assert.rejects(wallet.sync(new PivxClient({ port: node.port })), ScanDivergedError);
  } finally {
    node.close();
  }
});

test('checkpoint-height stale tip: matching checkpoint root is a clean no-op (no false positive)', async () => {
  const wallet = await walletOnCheckpoint();
  const H = wallet.getLastSyncedBlock();
  // The node returns the wallet's own checkpoint root — what a checkpoint IS.
  const { get_sapling_root } = await import('pivx-shield-rust');
  const localRoot = reverseHex(get_sapling_root(JSON.parse(wallet.save()).commitmentTree));
  const node = await stubNode(cpHandlers(localRoot, H));
  try {
    await wallet.sync(new PivxClient({ port: node.port })); // matches → no divergence
    assert.equal(wallet.getBalance(), 0);
    assert.equal(wallet.getLastSyncedBlock(), H);
  } finally {
    node.close();
  }
});

// An honest wallet at lastProcessed === tip === H BELOW real V5_0 activation
// (testnet 201): PIVX reports finalsaplingroot = 0 (UINT256_ZERO) there while
// our empty tree carries the non-zero sapling empty root. The stale-tip check
// must skip below activation, so sync is a clean no-op — not a false divergence.
test('stale tip below sapling activation: zero node root is a clean no-op (skipped)', async () => {
  const H = 100; // below testnet V5_0 activation (201)
  const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  wallet['lastProcessedBlock'] = H; // empty tree, honest below-activation tip
  wallet['startValidated'] = true; // synthetic stub chain: skip node checkpoint validation
  const node = await stubNode(cpHandlers('00'.repeat(32), H));
  try {
    // The zero root mismatches our non-zero empty-tree root, but the check is
    // skipped below activation, so sync must not throw.
    await wallet.sync(new PivxClient({ port: node.port }));
    assert.equal(wallet.getLastSyncedBlock(), H);
  } finally {
    node.close();
  }
});

// The fail-open gap the old 43_200 constant left: a testnet wallet at a height in
// [201, 43_200) is at/above real V5_0 activation (201) but below the old
// constant, so the stale-tip check was skipped and a divergence went uncaught.
// With testnet activation set to its real 201 the check now runs and catches it:
// FAILS before (10_000 < 43_200 → skipped → no throw), PASSES after
// (10_000 >= 201 → ScanDiverged).
test('stale tip in [201, 43200) activation gap: differing node root throws ScanDiverged', async () => {
  const H = 10_000; // above real activation (201), below the old 43_200 constant
  const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  wallet['lastProcessedBlock'] = H;
  wallet['startValidated'] = true; // synthetic stub chain: skip node checkpoint validation
  const node = await stubNode(cpHandlers('00'.repeat(32), H));
  try {
    await assert.rejects(wallet.sync(new PivxClient({ port: node.port })), ScanDivergedError);
  } finally {
    node.close();
  }
});

// MAINNET regression for the corrected V5_0 activation (2_700_500, not
// 2_700_000). A wallet resolving to the base checkpoint 2_700_000 with node tip
// == 2_700_000 sits BELOW real activation, where PIVX reports finalsaplingroot =
// 0. The stale-tip check must skip, so sync is a clean no-op. With the old
// 2_700_000 constant the guard ran (2_700_000 >= 2_700_000) and false-diverged:
// FAILS before the constant fix, PASSES after.
test('mainnet stale tip at base checkpoint (below V5_0): zero node root is a clean no-op (skipped)', async () => {
  const CP = 2_700_000; // base mainnet checkpoint, below real V5_0 (2_700_500)
  const wallet = await PivxWallet.create({ seed: new Uint8Array(32), network: 'mainnet', birthHeight: CP });
  const H = wallet.getLastSyncedBlock(); // resolves to the base checkpoint
  assert.equal(H, CP);
  wallet['startValidated'] = true; // synthetic stub chain: skip node checkpoint validation
  const node = await stubNode(cpHandlers('00'.repeat(32), H));
  try {
    // The zero root mismatches our non-zero empty-tree root, but 2_700_000 <
    // corrected activation 2_700_500, so the check is skipped: sync must not throw.
    await wallet.sync(new PivxClient({ port: node.port }));
    assert.equal(wallet.getLastSyncedBlock(), H);
  } finally {
    node.close();
  }
});
