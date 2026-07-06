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

// W5: a node block missing its tx array is malformed data; fetchBlock must fail
// with a labeled error rather than a bare TypeError on `block.tx.map`.
test('W5: sync rejects a node block missing its tx array with a labeled error', async () => {
  const node = await stubNode({
    getblockcount: () => BIRTH + 1,
    getblockhash: (h) => `hash${h}`,
    // No `tx` field: the block is malformed.
    getblock: (hash) => ({ height: Number(hash.slice(4)), finalsaplingroot: '00'.repeat(32) }),
  });
  try {
    const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
    wallet['lastProcessedBlock'] = BIRTH;
    wallet['startValidated'] = true;
    const client = new PivxClient({ port: node.port });
    await assert.rejects(wallet.sync(client), /malformed block/);
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

// W3 (reworks D1/#28): a below-activation block carrying a '03'-prefixed tx
// must not brick sync — consensus forbids shielded DATA below activation
// (IsShieldedTx = sapling version AND sapling data, PIVX transaction.h), not
// the version byte, so a bare-v3 tx is consensus-legal. The tx is SKIPPED
// (never reaches the scanner): sync SUCCEEDS and nothing is credited —
// fabricated sapling data below activation stays uncredited (the original D1
// fail-open stays closed).
test('sync skips a below-activation shielded tx: succeeds with nothing credited', async () => {
  const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  assert.equal(wallet.getLastSyncedBlock(), 0); // starts on the height-0 checkpoint
  const node = await stubNode({
    getblockcount: () => 1,
    getblockhash: (h) => `hash${h}`,
    getblock: () => ({ height: 1, finalsaplingroot: '00'.repeat(32), tx: [{ hex: TX_HEX, txid: 'fixture' }] }),
  });
  try {
    await wallet.sync(new PivxClient({ port: node.port }));
    assert.equal(wallet.getLastSyncedBlock(), 1, 'sync succeeded past the skipped tx');
    assert.equal(wallet.getNotes().length, 0, 'fabricated below-activation note never credited');
    assert.equal(wallet.getBalance(), 0);
  } finally {
    node.close();
  }
});

// T1: a note-bearing batch that fails the root check must roll back
// completely — notes, nullifierMap inserts, AND pending-spend reconciliation
// (a pending entry the batch dropped must come back).
test('note-bearing batch rollback restores notes, nullifierMap, and pendingSpends', async () => {
  const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  wallet['lastProcessedBlock'] = BIRTH;
  wallet['startValidated'] = true;
  // A pending entry whose nullifiers are untracked: the batch's
  // reconciliation deletes it, so only a full rollback restores it.
  wallet['pendingSpends'].set('inflight', ['aa'.repeat(32)]);
  const before = JSON.parse(wallet.save());

  // The batch credits the fixture note, then fails the root check.
  const node = await stubNode(makeHandlers('ff'.repeat(32)));
  try {
    await assert.rejects(wallet.sync(new PivxClient({ port: node.port })), ScanDivergedError);
  } finally {
    node.close();
  }
  assert.deepEqual(JSON.parse(wallet.save()), before, 'state fully restored after the failed batch');
  assert.equal(wallet.getBalance(), 0);
  assert.deepEqual(wallet.pendingTransactions(), { inflight: ['aa'.repeat(32)] });
});

// T2: a fresh wallet on a stale near-tip checkpoint walks back to an older
// checkpoint the node confirms, and adopts it.
test('ensureValidCheckpoint walks back to an older node-confirmed checkpoint', async () => {
  // Fresh wallet on the 86400 checkpoint; the node only confirms 43200.
  const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: 100_000 });
  assert.equal(wallet.getLastSyncedBlock(), 86_400);
  const { get_closest_checkpoint, get_sapling_root } = await import('pivx-shield-rust');
  const [cpHeight, cpTree] = get_closest_checkpoint(86_399, true);
  assert.equal(cpHeight, 43_200);
  const olderRoot = reverseHex(get_sapling_root(cpTree));

  const node = await stubNode({
    getblockcount: () => 43_200,
    getblockhash: (h) => `hash${h}`,
    // Only the 43200 checkpoint matches; everything else is stale.
    getblock: (hash) => ({
      height: Number(hash.slice(4)),
      finalsaplingroot: Number(hash.slice(4)) === 43_200 ? olderRoot : '00'.repeat(32),
      tx: [],
    }),
  });
  try {
    await wallet.sync(new PivxClient({ port: node.port }));
    assert.equal(wallet.getLastSyncedBlock(), 43_200, 'older confirmed checkpoint adopted');
    assert.equal(wallet.getNotes().length, 0);
  } finally {
    node.close();
  }
});

// A spend of the TX_HEX note, built by the Rust SDK's builder (MockProver):
// a full-balance sweep back to this wallet's own next shield address carrying
// a UTF-8 memo. Cross-SDK fixture: written by pivx-rust-sdk, decrypted here.
// Spends nullifier 078f31bc…8ba72d; recipient note = 1e9 minus the 2_365_000
// shield→shield fee.
const SPEND_TXID = 'de73b739843f1547d42c9dc0957e77f2cdfc36c12afc4799a4c5a6cce60c9207';
const SPEND_MEMO = 'memo round-trip ✓ across SDKs';
const SPEND_VALUE = 997_635_000;
const SPEND_TX_HEX = '03000000000000000000014816240000000000013a497a281c7f4f8644aa17ce6202920ec7e8341bb55b76a1f66e204a2bd5d03f15a333367ca73c4bf0c550abf84359146c65094e96901f5e651b05e4642f1565078f31bc087a3fac22b4e61900c35b5c9ee4b524fc8ce050eefb4cfeb78ba72d0fdfc7b2c43437be9f27ea6c6c7d9a8726524f6dac52c08163199842db3f32c800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000036e97497588c6cac8ecc7ddcfa3fb6b4da2dd7d7c8ac89b332708677ca4f3b09600a4aab0ab9592f104a1bce4fe68334bb7ec1db8ecb178a90b737b70537a50702f7bf1933319388325eca6752fd958d590dbbb58367d09d097d37e0ac4677ff86f3c5cadd96f8c653a7c4df79bd449238d45ac1ecfdfcd13dc7416f4f27389758eb0bb7d9b5fb829ae65fe05e60b27819b79fec1f9359a03949d07b36f5b043bb818b41e8f14d5a0aba994e8806c4e5d0666eae55752f45d9462fb493fbee7d8a244cbbf2038477ef86f5ac9c7adb1de03e681da39ff637e39830fce8b7613dd1207a985b59a73f392a42d8093bea2c3874b0bf3776c856d4cd4a247c51543a430f4c7bd94ae3d73a4a2b6ff9eeda4dc7f29418d3a14bf634153797c19e5f333ff1fe0f658fb30b06b3a17b957ce44b536a0099bf52fdb0c4e9c2ce3642f747e405b9dc1e40bfcedb4403c1c0f0041f19c4368026d9b648f706f32672c9d13f0ba95f2b4f555e3977a7d62ce3864e60cd5b19c1e96061993a1cecea2bbf6e9025f90afae9b43576e345e121d5cc93f1a0664f1929916f45274dfe662c7a0000ecd529f28f0c4f677a8f3226e17e353cefcf860f8430409328e5407fe73a8c21a3bada097de00d58e9d786271d52f58ff0270d9d26e3a38368c414866b1fb0320cb32f5cc513270675182b1598c2e66fb59e7cd6fff9e13f64b603633f683d2164761dcc1618570c34b545cd657e2a5cbdb52265b7124d528b41dcb0ea7d12624b64eb623801adf08d57ca845b1bc08923840e614d9bcc7287eaf6a58ce6c2f8a9c5f45a8746a060df427af1f42886d254fb019f740b23529f34fe87e6e105b718d0a5a0c474002e0d85d627a081acf784dbf264f40309998559369b530c2bc19f78ad6edd2c9f434bb9145a71a8a617f93ab376bbeb9a9c67d4f347f19e3da9c995babfd096f1c290f7134fbe0452dc35a6579d21d9fa16e641db65ae287fcb6e96ae09712aa16bdca50d2b6454bcc716f65cd50a93c47c47a02c3e65951fbe875c56c25bed930853df1f4bc649eb7528829b80420286007bdd031b5f71258c00417bfd6793a5fdbe57322a1001d2998d5dff385f779ce83822d49d5d38895f3416740be8743d0e5e0ebf292898717bb611eebefa0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002eedcd56e1688e18b29e8b443715f87f506002d945e0a191357490bddaf4fc545e899513c4f63509c571de166164b2789849d80fbf9a3ab6ec76b6ea8f3b13739aa30a0350052d35032176acb1d533886b15df0eea736f9fc653a8105f283c524bdfddce6ad1faf445e63ffcc96f0ce7c20efa17ad3a1f47b67cf2245365724d2e1b1f1c3f7ad90525f7d1474d9841711d07edb71cba1ce9d0f5a87e3195034b10b3b68ec0e9b36de84fb1ce4bf14ab79acffa97033977166655fe189a0195d27ba85fc4b5c73e7607f80898b8f4744e60d617acfbb7e465d66e861e8f29229ef741a8962428c5e140c7af0c7952ea6f349aa6e71bd37184325b9050a49f7b440ae53bac4003b5c37c83b333ee0df5f33c7d654b9bb0e23235d209b670b2f4bfca45115ab4e90b596b2f5a8344481ead533f1fca74677a96cecd72bd62b7fa9483f9a61b675e2adab84300e0ea0d405f449f6e3133f68391d5e5574e4317c849a8e4a1855a34b5abfb03ec0d81fdef2a9885df685dcb7c8ed421f7ee86960a8a1eea57220cb8a0353aa60e14ccd1627c5d9014067ed84a6ea5ab768709d3d73a9779106f9ed47f4112c72accd247cdb729219f5a0579fd2ecb76cf9ea07d99b528319721f1fa40e04726b7a41b839a296ab391199f9674b18bfee2d063bfde4a692f1e995414e86c5c7e6ecc58e984934d1cdd7cdd1df03dbbe806730e47c37c447c3dbbf14adb80332af0d0cbb0d791227ed5e89d5d477cc1219d166814d552363c422fa646469e4dabe60fa917001ab7b21f60ed5e9a050c5ab468fddf5d077ec10d39e9dc031417f16b58ee5c1aa52570ad891ebce45d89fa51bc94570b9b6247492843ca21ce50dab6f674c32b0c7ae072d40ad43c8c06e257d53c1e83cd816ee14a1b6db31f9cb5af0acdb472668cd5bd22c346325d31aa3cd0eb86e8164289a319ad30f577178954fa9fde3c788efc70c5ea4e8480eb1be2b7a3ebea1126ece4c6f8a4085d22a60b98962c57bbb3eee558436017ba19b3ce0cc603ea4bc535c0131438c1f6af06742c9e454f7ce24dab120000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000d6521760a8ac23c9eb52049529f5d31f245222e3a8760f29de0c7162797496593192bf9d0d5ad60c1207af2af65c6a63b39248d9b99b021a018619e43005703';

// T3: crash-recovery reconciliation. A spend was broadcast-accepted but the
// process died before finalize; the persisted pending entry survives the
// restart, and syncing the confirming block scans the old note out and
// auto-drops the pending entry (the sweep's own change-back note is credited).
test('crash recovery: confirming block scans out the note and auto-drops the pending spend', async () => {
  const w = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  const nullifier = w.getNotes()[0].nullifier;
  w['pendingSpends'].set(SPEND_TXID, [nullifier]);
  const saved = w.save();

  const restored = await PivxWallet.load(saved);
  assert.equal(restored.getBalance(), 0, 'pending spend survives the restart');
  restored['startValidated'] = true;

  // Learn the post-spend root from a reference scan of the same state.
  const reference = await PivxWallet.load(saved);
  reference.handleBlocks([{ height: BIRTH + 2, txs: [{ hex: SPEND_TX_HEX, txid: SPEND_TXID }] }]);
  const { get_sapling_root } = await import('pivx-shield-rust');
  const root = reverseHex(get_sapling_root(JSON.parse(reference.save()).commitmentTree));

  const node = await stubNode({
    getblockcount: () => BIRTH + 2,
    getblockhash: (h) => `hash${h}`,
    getblock: () => ({ height: BIRTH + 2, finalsaplingroot: root, tx: [{ hex: SPEND_TX_HEX, txid: SPEND_TXID }] }),
  });
  try {
    await restored.sync(new PivxClient({ port: node.port }));
  } finally {
    node.close();
  }
  assert.deepEqual(restored.pendingTransactions(), {}, 'pending entry auto-dropped');
  assert.ok(!restored.getNotes().some((n) => n.nullifier === nullifier), 'spent note removed');
  assert.equal(restored.getBalance(), SPEND_VALUE, 'sweep change-back note credited');
});

// T4: reorg re-credit. A credited note, a tip-root divergence, recovery via
// reloadFromCheckpoint, and a rescan must credit the note exactly once.
test('reorg recovery: reloadFromCheckpoint then rescan credits the note exactly once', async () => {
  const wallet = await walletAtTip(); // note credited, lastProcessed === tip === BIRTH+1
  const goodRoot = await expectedRootAfterFixture();
  const fresh = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  const { get_sapling_root } = await import('pivx-shield-rust');
  const emptyRoot = reverseHex(get_sapling_root(JSON.parse(fresh.save()).commitmentTree));

  // Same-height reorg: the node's tip root differs from ours → diverge.
  const badNode = await stubNode(cpHandlers('ff'.repeat(32), BIRTH + 1));
  try {
    await assert.rejects(wallet.sync(new PivxClient({ port: badNode.port })), ScanDivergedError);
  } finally {
    badNode.close();
  }

  // Recover: back to the checkpoint (height 0), then rescan a healthy chain.
  wallet.reloadFromCheckpoint(BIRTH + 1);
  assert.equal(wallet.getLastSyncedBlock(), 0);
  assert.equal(wallet.getNotes().length, 0);

  const tip = BIRTH + 1;
  const goodNode = await stubNode({
    getblockcount: () => tip,
    getblockhash: (h) => `hash${h}`,
    getblock: (hash) => {
      const h = Number(hash.slice(4));
      return h === tip
        ? { height: h, finalsaplingroot: goodRoot, tx: [{ hex: TX_HEX, txid: 'fixture' }] }
        : { height: h, finalsaplingroot: emptyRoot, tx: [] };
    },
  });
  try {
    await wallet.sync(new PivxClient({ port: goodNode.port }));
  } finally {
    goodNode.close();
  }
  assert.equal(wallet.getNotes().length, 1, 'note credited exactly once');
  assert.equal(wallet.getBalance(), 1_000_000_000);
  assert.equal(wallet.getLastSyncedBlock(), tip);
});

// T6 (decrypt side; the build side lives in the Rust SDK, whose builder wrote
// this fixture): a ≤512-byte UTF-8 memo in a built transaction decrypts intact.
test('memo round-trip: a memo written by the Rust SDK builder decrypts intact', async () => {
  const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  const outputs = wallet.previewTransaction(SPEND_TX_HEX);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].memo, SPEND_MEMO);
  assert.equal(outputs[0].value, SPEND_VALUE);
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
