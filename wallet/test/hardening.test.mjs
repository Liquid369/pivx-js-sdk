import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from 'pivx-rpc';
import { PivxWallet, InsufficientFundsError, WalletBusyError, ProverNotLoadedError } from '../dist/index.js';
import { EXTSK, TX_HEX, SHIELD_ADDRESS } from './fixtures.mjs';

// Above testnet sapling activation (201): the fixture blocks carry a shielded
// tx, which handleBlocks silently skips below activation (W3), so it must
// land at/above activation to be credited.
const BIRTH = 300;
const newWallet = () =>
  PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });

test('pendingSpends survive save/load so notes are not resurrected', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  assert.equal(w.getBalance(), 1_000_000_000);

  // simulate a pending spend of the note, then persist mid-flight
  const nullifier = w.getNotes()[0].nullifier;
  w['pendingSpends'].set('inflight-tx', [nullifier]);
  assert.equal(w.getBalance(), 0, 'pending note excluded from balance');

  const restored = await PivxWallet.load(w.save());
  assert.equal(restored.getBalance(), 0, 'restored wallet still treats note as pending');
});

test('load rejects malformed state instead of corrupting the money path', async () => {
  await assert.rejects(PivxWallet.load('not json'), /valid JSON/);
  await assert.rejects(PivxWallet.load('{"version":2}'), /version/);
  const w = await newWallet();
  const bad = JSON.parse(w.save());
  bad.notes = [{ nullifier: 'x', note: { value: 'lots' } }];
  await assert.rejects(PivxWallet.load(JSON.stringify(bad)), /malformed note/);
});

test('createTransaction validates amount', async () => {
  const w = await newWallet();
  await assert.rejects(w.createTransaction({ to: 'ps1x', amount: -1 }), /positive integer/);
  await assert.rejects(w.createTransaction({ to: 'ps1x', amount: 1.5 }), /positive integer/);
  await assert.rejects(w.createTransaction({ to: 'ps1x', amount: 2 ** 53 }), /positive integer/);
});

test('createTransaction refuses a send the balance cannot cover with fee, unless subtractFeeFromAmount', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  assert.equal(w.getBalance(), 1_000_000_000); // 10 PIV note

  // More than the balance: rejected before the prover is even needed.
  await assert.rejects(
    w.createTransaction({ to: SHIELD_ADDRESS, amount: 2_000_000_000 }),
    /insufficient input value/,
  );
  // subtractFeeFromAmount bypasses the guard and proceeds to the (unloaded) prover.
  await assert.rejects(
    w.createTransaction({ to: SHIELD_ADDRESS, amount: 2_000_000_000, subtractFeeFromAmount: true }),
    /prover not loaded/,
  );
  // A covered amount passes the guard and reaches the prover check.
  await assert.rejects(
    w.createTransaction({ to: SHIELD_ADDRESS, amount: 500_000_000 }),
    /prover not loaded/,
  );
});

// A7: `sweep` is the deprecated alias for `subtractFeeFromAmount` (verified the
// same flag). The alias must still bypass the insufficiency guard for one
// release. FAILS before the rename existed (no alias to map), PASSES after.
test('createTransaction still accepts the deprecated `sweep` alias for subtractFeeFromAmount', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  await assert.rejects(
    w.createTransaction({ to: SHIELD_ADDRESS, amount: 2_000_000_000, sweep: true }),
    /prover not loaded/,
    'deprecated sweep alias bypasses the guard exactly like subtractFeeFromAmount',
  );
});

// A6: insufficient-funds and busy failures throw typed subclasses of Error, so
// callers can discriminate — while existing `instanceof Error` catches still
// work. FAILS before (bare Error), PASSES after.
test('A6: typed InsufficientFundsError and WalletBusyError (both instanceof Error)', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);

  // Insufficient funds → InsufficientFundsError.
  const insufficient = await w
    .createTransaction({ to: SHIELD_ADDRESS, amount: 2_000_000_000 })
    .then(() => null, (e) => e);
  assert.ok(insufficient instanceof InsufficientFundsError, 'InsufficientFundsError');
  assert.ok(insufficient instanceof Error, 'still an Error');

  // A busy wallet → WalletBusyError (reloadFromCheckpoint is a cheap busy site).
  w['busy'] = true;
  const busy = (() => {
    try {
      w.reloadFromCheckpoint(BIRTH);
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(busy instanceof WalletBusyError, 'WalletBusyError');
  assert.ok(busy instanceof Error, 'still an Error');
  assert.match(busy.message, /another sync or spend is in progress/, 'consistent busy message');
});

// R5-7: the prover-not-loaded failure throws a typed ProverNotLoadedError
// (subclass of Error), matching Rust's WalletError::ProverNotLoaded. FAILS
// before (bare Error / no export), PASSES after.
test('R5-7: createTransaction throws ProverNotLoadedError when the prover is unloaded', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  // A covered amount passes the funds guard and reaches the (unloaded) prover check.
  const err = await w
    .createTransaction({ to: SHIELD_ADDRESS, amount: 500_000_000 })
    .then(() => null, (e) => e);
  assert.ok(err instanceof ProverNotLoadedError, 'ProverNotLoadedError');
  assert.ok(err instanceof Error, 'still an Error');
  assert.match(err.message, /prover not loaded/, 'message preserved');
});

test('concurrent createTransaction serializes on the busy guard (no shared snapshot)', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  // Two covered-amount sends fired together: the first acquires the busy guard
  // before snapshotting notes or awaiting, so the second must see busy and be
  // rejected — it can never snapshot the same notes and double-spend. (The
  // first then fails only on the unloaded prover.) Before the guard was moved
  // ahead of the snapshot/await, both reached the prover check.
  const results = await Promise.allSettled([
    w.createTransaction({ to: SHIELD_ADDRESS, amount: 500_000_000 }),
    w.createTransaction({ to: SHIELD_ADDRESS, amount: 500_000_000 }),
  ]);
  const reasons = results.map((r) => String(r.reason?.message ?? ''));
  assert.equal(results.filter((r) => r.status === 'rejected').length, 2);
  assert.equal(reasons.filter((m) => /busy/.test(m)).length, 1, 'exactly one rejected as busy');
  assert.equal(reasons.filter((m) => /prover not loaded/.test(m)).length, 1);
  assert.equal(w.pendingTransactions ? Object.keys(w.pendingTransactions()).length : 0, 0);
});

test('createTransaction rejects a non-integer transparent input amount', async () => {
  const w = await newWallet();
  await assert.rejects(
    w.createTransaction({
      to: SHIELD_ADDRESS,
      amount: 100_000,
      inputs: [{ txid: 'ab', vout: 0, amount: 1.5, private_key: new Uint8Array(32), script: new Uint8Array(1) }],
      transparentChangeAddress: 'yTdummy',
    }),
    /non-negative integer/,
  );
});

test('load rejects a tampered viewing key or diversifier index', async () => {
  const good = JSON.parse((await newWallet()).save());
  const badDiv = { ...good, diversifierIndex: [1, 2, 3] };
  await assert.rejects(PivxWallet.load(JSON.stringify(badDiv)), /diversifier/);
  const badKey = { ...good, extfvk: 'ptestsapling-not-a-real-key' };
  await assert.rejects(PivxWallet.load(JSON.stringify(badKey)), /viewing key/);
});

test('load with expectedViewingKey rejects a swapped key', async () => {
  const good = (await newWallet()).save();
  const state = JSON.parse(good);
  // Correct expected key loads fine.
  await PivxWallet.load(good, { expectedViewingKey: state.extfvk });
  // A state whose key was swapped is rejected when an expected key is given.
  const other = JSON.parse((await PivxWallet.create({ seed: new Uint8Array(32).fill(9), network: 'testnet', birthHeight: BIRTH })).save());
  const swapped = JSON.stringify({ ...state, extfvk: other.extfvk });
  await assert.rejects(PivxWallet.load(swapped, { expectedViewingKey: state.extfvk }), /does not match/);
});

test('pendingTransactions exposes in-flight spends for reconciliation', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  const nullifier = w.getNotes()[0].nullifier;
  w['pendingSpends'].set('tx-abc', [nullifier]);
  assert.deepEqual(w.pendingTransactions(), { 'tx-abc': [nullifier] });
});

test('pruneNullifiers removes only settled spent entries; live attribution intact', async () => {
  const w = await newWallet();
  // The same output scanned at two positions yields two notes with distinct
  // (position-dependent) nullifiers — two map entries.
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  w.handleBlocks([{ height: BIRTH + 2, txs: [{ hex: TX_HEX, txid: 'fixture2' }] }]);
  const [spentNote, liveNote] = w.getNotes();
  assert.equal(w.getNotes().length, 2);
  assert.notEqual(spentNote.nullifier, liveNote.nullifier);

  // Everything still referenced by an unspent note: nothing to prune.
  assert.equal(w.pruneNullifiers(), 0);

  // Spend the first note and settle it (broadcast accepted → finalize).
  w['pendingSpends'].set('tx-spend', [spentNote.nullifier]);
  w.finalizeTransaction('tx-spend');

  // An in-flight (unsettled) spend whose note is no longer tracked must
  // survive pruning: pendingSpends still references it.
  const inflight = 'ab'.repeat(32);
  w['nullifierMap'].set(inflight, { recipient: 'pending', value: 1 });
  w['pendingSpends'].set('tx-inflight', [inflight]);

  assert.equal(w.pruneNullifiers(), 1, 'only the settled spend is pruned');
  assert.equal(w.getNoteFromNullifier(spentNote.nullifier), undefined);
  assert.equal(w.getNoteFromNullifier(inflight)?.recipient, 'pending');
  const live = w.getNoteFromNullifier(liveNote.nullifier);
  assert.equal(live?.recipient, SHIELD_ADDRESS);
  assert.equal(live?.value, 1_000_000_000);
  assert.equal(w.getBalance(), 1_000_000_000);
  // Prune is idempotent/deterministic.
  assert.equal(w.pruneNullifiers(), 0);
});

// W3 (reworks D1/#28): consensus forbids shielded DATA below V5_0 activation
// (IsShieldedTx = sapling version AND sapling data, PIVX transaction.h), not
// the '03' version byte itself, so a below-activation v3 tx must not brick
// sync. handleBlocks SKIPS '03'-prefixed txs below activation: the batch
// succeeds, nothing reaches the scanner, nothing is credited. Regression for
// the original D1 fail-open: fabricated sapling data below activation is
// still never credited.
test('handleBlocks skips shielded txs below sapling activation without crediting them', async () => {
  const w = await newWallet();
  const relevant = w.handleBlocks([{ height: 150, txs: [{ hex: TX_HEX, txid: 'x' }] }]);
  assert.deepEqual(relevant, [], 'skipped tx is not reported as wallet-relevant');
  assert.equal(w.getNotes().length, 0, 'fabricated below-activation note never credited');
  assert.equal(w.getBalance(), 0);
  assert.equal(w.getLastSyncedBlock(), 150, 'sync position advances: success, not failure');
  // The same tx at/above activation still credits normally.
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  assert.equal(w.getBalance(), 1_000_000_000);
});

// W5: a NaN/undefined/fractional height bypasses the ascending guard
// (NaN <= prev is false) and the below-activation filter, letting fabricated
// data reach the scanner and poisoning lastProcessedBlock. FAILS before (a
// NaN-height block credited the note), PASSES after (labeled error, state
// untouched).
test('handleBlocks rejects non-safe-integer block heights', async () => {
  const w = await newWallet();
  for (const height of [NaN, undefined, 1.5, 2 ** 53]) {
    assert.throws(
      () => w.handleBlocks([{ height, txs: [{ hex: TX_HEX, txid: 'x' }] }]),
      /safe integer/,
      `height ${String(height)}`,
    );
  }
  assert.equal(w.getNotes().length, 0, 'state untouched');
  assert.equal(w.getBalance(), 0);
  assert.equal(w.getLastSyncedBlock(), 0);
});

// D3: a tx object without hex gets a labeled error naming the block (matching
// the Rust SDK) instead of a bare TypeError. FAILS before (TypeError from
// hex.startsWith), PASSES after.
test('handleBlocks labels a tx without hex instead of a bare TypeError', async () => {
  const w = await newWallet();
  assert.throws(
    () => w.handleBlocks([{ height: BIRTH + 1, txs: [{ txid: 'x' }] }]),
    new RegExp(`block ${BIRTH + 1} has a tx without hex`),
  );
  assert.equal(w.getLastSyncedBlock(), 0, 'state untouched');
});

// D2: load() shape-checks nullifierMap entries and pendingSpends values (the
// Rust SDK's typed deserialization rejects these for free). FAILS before
// (all of these loaded silently), PASSES after.
test('load rejects malformed nullifierMap entries and pendingSpends values', async () => {
  const good = JSON.parse((await newWallet()).save());
  const cases = [
    [{ ...good, nullifierMap: 'zzz' }, /nullifier map/],
    [{ ...good, nullifierMap: { '00ff': 'not-an-object' } }, /nullifier-map entry/],
    [{ ...good, nullifierMap: { '00ff': { recipient: 5, value: 1 } } }, /nullifier-map entry/],
    [{ ...good, nullifierMap: { '00ff': { recipient: 'ps1x', value: -1 } } }, /nullifier-map entry/],
    [{ ...good, nullifierMap: { '00ff': { recipient: 'ps1x', value: 1.5 } } }, /nullifier-map entry/],
    [{ ...good, pendingSpends: { tx: 'not-an-array' } }, /pending-spends entry/],
    [{ ...good, pendingSpends: { tx: [42] } }, /pending-spends entry/],
  ];
  for (const [state, re] of cases) {
    await assert.rejects(PivxWallet.load(JSON.stringify(state)), re);
  }
  // Well-formed maps still load.
  await PivxWallet.load(
    JSON.stringify({
      ...good,
      nullifierMap: { '00ff': { recipient: 'ps1x', value: 5 } },
      pendingSpends: { tx: ['00ff'] },
    }),
  );
});

// D4/T5: send() error branches. An "accepted-tx" RpcError (already in
// mempool/chain) keeps the spend pending like a transport error — the D4
// cases FAIL before the fix (every RpcError discarded the spend) and PASS
// after; a genuine validation RpcError still frees the notes.
test('send keeps pending on accepted-tx RPC errors, frees on validation errors', async () => {
  const makeWallet = async () => {
    const w = await newWallet();
    w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
    const nullifier = w.getNotes()[0].nullifier;
    // send() builds via createTransaction; stub it (no prover in tests) with
    // the same pending-spend bookkeeping the real one performs.
    w.createTransaction = async () => {
      w['pendingSpends'].set('tx-built', [nullifier]);
      return { txid: 'tx-built', hex: '00', nullifiers: [nullifier] };
    };
    return w;
  };
  const failWith = (err) => ({ sendRawTransaction: async () => { throw err; } });
  const sendOpts = { to: SHIELD_ADDRESS, amount: 1 };

  // Accepted-tx RpcError (-26 txn-already-in-mempool): spend stays pending.
  let w = await makeWallet();
  const inMempool = new RpcError(-26, 'txn-already-in-mempool: ', 'sendrawtransaction');
  await assert.rejects(w.send(failWith(inMempool), sendOpts));
  assert.deepEqual(Object.keys(w.pendingTransactions()), ['tx-built'], 'kept on already-in-mempool');
  assert.equal(w.getBalance(), 0);
  assert.equal(inMempool.txid, 'tx-built', 'txid attached for reconciliation');

  // -27 already-in-chain: same.
  w = await makeWallet();
  await assert.rejects(
    w.send(failWith(new RpcError(-27, 'transaction already in block chain', 'sendrawtransaction')), sendOpts),
  );
  assert.deepEqual(Object.keys(w.pendingTransactions()), ['tx-built'], 'kept on already-in-chain');

  // Genuine validation RpcError: notes freed.
  w = await makeWallet();
  await assert.rejects(
    w.send(failWith(new RpcError(-26, 'bad-txns-inputs-duplicate', 'sendrawtransaction')), sendOpts),
  );
  assert.deepEqual(w.pendingTransactions(), {}, 'validation reject frees the notes');
  assert.equal(w.getBalance(), 1_000_000_000);

  // Transport error: ambiguous → pending kept, txid attached.
  w = await makeWallet();
  const transport = new TypeError('fetch failed');
  await assert.rejects(w.send(failWith(transport), sendOpts));
  assert.deepEqual(Object.keys(w.pendingTransactions()), ['tx-built'], 'kept on transport error');
  assert.equal(transport.txid, 'tx-built');
});

// W4: shield-specific reject reasons that mean the network already has a
// transaction spending these nullifiers — possibly OURS, rebroadcast or raced
// (PIVX validation.cpp: bad-txns-nullifier-double-spent from the mempool
// nullifier check, bad-txns-shielded-requirements-not-met from
// HaveShieldedRequirements; -27 cannot fire for z→z, its already-in-chain
// probe scans vout only). Discarding would let a retry double-spend, so the
// spend must stay pending. FAILS before (both reasons discarded), PASSES after.
test('send keeps pending on shield-specific already-spent reject reasons', async () => {
  for (const reason of ['bad-txns-nullifier-double-spent', 'bad-txns-shielded-requirements-not-met']) {
    const w = await newWallet();
    w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
    const nullifier = w.getNotes()[0].nullifier;
    w.createTransaction = async () => {
      w['pendingSpends'].set('tx-built', [nullifier]);
      return { txid: 'tx-built', hex: '00', nullifiers: [nullifier] };
    };
    const client = {
      sendRawTransaction: async () => {
        throw new RpcError(-26, `${reason}: `, 'sendrawtransaction');
      },
    };
    await assert.rejects(w.send(client, { to: SHIELD_ADDRESS, amount: 1 }));
    assert.deepEqual(Object.keys(w.pendingTransactions()), ['tx-built'], `kept on ${reason}`);
    assert.equal(w.getBalance(), 0);
  }
});

test('reloadFromCheckpoint resets scan state', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  assert.equal(w.getNotes().length, 1);

  w.reloadFromCheckpoint(BIRTH);
  assert.equal(w.getNotes().length, 0);
  assert.equal(w.getBalance(), 0);
});

// A2: reloadFromCheckpoint must apply create()'s [0, 2^31-1] guard before
// touching state. An unchecked NaN/negative/2^40 height wraps to a wrong
// checkpoint in the WASM and would clear notes/pending into a stuck resync.
// FAILS before (state cleared, wrong checkpoint adopted), PASSES after (throws,
// notes and sync position untouched).
test('A2: reloadFromCheckpoint rejects an out-of-range height without clearing state', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  assert.equal(w.getNotes().length, 1);
  const syncedBefore = w.getLastSyncedBlock();

  for (const bad of [2 ** 40, NaN, -1, 1.5]) {
    assert.throws(() => w.reloadFromCheckpoint(bad), /\[0, 2\^31-1\]/, `height ${String(bad)}`);
  }
  assert.equal(w.getNotes().length, 1, 'notes not cleared by a rejected reload');
  assert.equal(w.getBalance(), 1_000_000_000, 'balance intact');
  assert.equal(w.getLastSyncedBlock(), syncedBefore, 'sync position untouched');
});

// W3: getNewAddress() advances the shield diversifier before create_transaction
// runs; if that call throws, the cursor must be restored so a failed send does
// not burn an internal address (the JS twin of the Rust plan_transaction fix).
test('W3: a failed create_transaction leaves the diversifier index unchanged', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  const real = w['shield'];
  // The shield module namespace is immutable, so wrap it: pass the prover gate
  // and force create_transaction to throw AFTER getNewAddress advances the cursor.
  w['shield'] = new Proxy(real, {
    get(target, prop) {
      if (prop === 'prover_is_loaded') return async () => true;
      if (prop === 'create_transaction') return async () => { throw new Error('forced prover error'); };
      return target[prop];
    },
  });
  const before = JSON.stringify(w['diversifierIndex']);
  try {
    await assert.rejects(
      w.createTransaction({ to: SHIELD_ADDRESS, amount: 500_000_000 }),
      /forced prover error/,
    );
  } finally {
    w['shield'] = real;
  }
  assert.equal(JSON.stringify(w['diversifierIndex']), before, 'diversifier not advanced by a failed send');
});

// W2: the shield load must bound lastProcessedBlock to [0, 2^53-1]; a negative
// value would previously load and underflow downstream block-height math.
test('W2: load rejects an out-of-range lastProcessedBlock', async () => {
  const w = await newWallet();
  const state = JSON.parse(w.save());
  await assert.rejects(
    PivxWallet.load(JSON.stringify({ ...state, lastProcessedBlock: -1 })),
    /sync position/,
  );
  await assert.rejects(
    PivxWallet.load(JSON.stringify({ ...state, lastProcessedBlock: 2 ** 53 })),
    /sync position/,
  );
});

// W7: caller-supplied proving parameters are SHA256-verified against the pinned
// hashes (the Rust integrity contract) before the WASM ever sees them.
test('W7: loadProver rejects proving parameters whose SHA256 does not match', async () => {
  const w = await newWallet();
  await assert.rejects(
    w.loadProver({ output: new Uint8Array([1, 2, 3]), spend: new Uint8Array([4, 5, 6]) }),
    /SHA256 verification/,
  );
});

// W7b: loadProver {url} now fetches the params and SHA256-pins them (parity with
// Rust's load_prover_from_url) instead of handing the raw URL to the WASM
// unverified — a mirror serving wrong bytes is rejected before proving.
test('W7b: loadProver {url} rejects fetched params whose SHA256 does not match', async () => {
  const w = await newWallet();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
  try {
    await assert.rejects(
      w.loadProver({ url: 'https://example.invalid/params' }),
      /SHA256 verification/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
