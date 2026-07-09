import { test } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { PivxWallet, NoSpendAuthorityError, InvalidKeyError } from '../dist/index.js';
import { EXTSK, SHIELD_ADDRESS, TX_HEX } from './fixtures.mjs';

// These tests run the real pivx-shield WASM: real key derivation, real note
// decryption against a known regtest transaction. No mocks.

// Above testnet sapling activation (201): the fixture blocks carry a shielded
// tx, which handleBlocks silently skips below activation (W3), so it must
// land at/above activation to be credited.
const BIRTH = 300;

test('key derivation is deterministic and network-correct', async () => {
  const seed = new Uint8Array(32).fill(7);
  const a = await PivxWallet.create({ seed, network: 'testnet', birthHeight: BIRTH });
  const b = await PivxWallet.create({ seed, network: 'testnet', birthHeight: BIRTH });
  const addrA = a.getNewAddress();
  assert.equal(addrA, b.getNewAddress());
  assert.match(addrA, /^ptestsapling1/);
  assert.ok(a.canSpend);

  const mainnet = await PivxWallet.create({ seed, network: 'mainnet', birthHeight: BIRTH });
  assert.match(mainnet.getNewAddress(), /^ps1/);
  // different coin type -> different keys
  assert.notEqual(mainnet.getNewAddress(), addrA);
});

// W-SEED (funds-critical): shield accepts a 64-byte BIP39 seed and derives from
// its first 32 bytes only (the WASM truncates), so a 64-byte seed and its first
// 32 bytes yield the same shield key. Runs the real WASM.
test('W-SEED: shield accepts a 64-byte BIP39 seed; first 32 bytes derive the same key', async () => {
  const seed64 = Uint8Array.from(
    ('5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1' +
      '9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4')
      .match(/../g)
      .map((b) => parseInt(b, 16)),
  );
  const a = await PivxWallet.create({ seed: seed64, network: 'mainnet', birthHeight: BIRTH });
  const b = await PivxWallet.create({ seed: seed64.slice(0, 32), network: 'mainnet', birthHeight: BIRTH });
  // Same viewing key + same receive address ⇒ same spending key (WASM truncates).
  assert.equal(JSON.parse(a.save()).extfvk, JSON.parse(b.save()).extfvk);
  assert.equal(a.getNewAddress(), b.getNewAddress());
  // A length other than 32 or 64 is rejected.
  await assert.rejects(
    PivxWallet.create({ seed: new Uint8Array(31), network: 'mainnet', birthHeight: BIRTH }),
    /seed must be/,
  );
});

// W6: a birthHeight the WASM would wrap to i32 (NaN, negative, or > 2^31-1) is
// rejected rather than silently rescanning from genesis or skipping past deposits.
test('W6: create rejects an out-of-range birthHeight', async () => {
  const seed = new Uint8Array(32).fill(7);
  await assert.rejects(PivxWallet.create({ seed, network: 'testnet', birthHeight: NaN }), /birthHeight/);
  await assert.rejects(PivxWallet.create({ seed, network: 'testnet', birthHeight: -1 }), /birthHeight/);
  await assert.rejects(PivxWallet.create({ seed, network: 'testnet', birthHeight: 2 ** 40 }), /birthHeight/);
});

test('scans a real transaction into a spendable note (spending key)', async () => {
  const wallet = await PivxWallet.create({
    spendingKey: EXTSK,
    network: 'testnet',
    birthHeight: BIRTH,
  });
  const walletTxs = wallet.handleBlocks([
    { height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] },
  ]);

  assert.equal(walletTxs.length, 1, 'fixture tx is wallet-relevant');
  assert.equal(wallet.getBalance(), 1_000_000_000);
  assert.equal(wallet.getNotes().length, 1);
  assert.equal(wallet.getLastSyncedBlock(), BIRTH + 1);

  const note = wallet.getNotes()[0];
  const attributed = wallet.getNoteFromNullifier(note.nullifier);
  assert.equal(attributed?.recipient, SHIELD_ADDRESS);
  assert.equal(attributed?.value, 1_000_000_000);
});

test('watch-only: same scan result from viewing key alone, but cannot spend', async () => {
  // derive the viewing key using a throwaway full wallet
  const full = await PivxWallet.create({
    spendingKey: EXTSK,
    network: 'testnet',
    birthHeight: BIRTH,
  });
  const viewingKey = JSON.parse(full.save()).extfvk;

  const watch = await PivxWallet.create({ viewingKey, network: 'testnet', birthHeight: BIRTH });
  assert.equal(watch.canSpend, false);
  watch.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  assert.equal(watch.getBalance(), 1_000_000_000);

  await assert.rejects(
    watch.createTransaction({ to: SHIELD_ADDRESS, amount: 1 }),
    NoSpendAuthorityError,
  );

  // upgrade in place; wrong key must be rejected (corrupt one char mid-key)
  const corrupted = EXTSK.slice(0, 60) + (EXTSK[60] === 'q' ? 'p' : 'q') + EXTSK.slice(61);
  assert.throws(() => watch.loadSpendingKey(corrupted));
  watch.loadSpendingKey(EXTSK);
  assert.ok(watch.canSpend);
});

test('previewTransaction decrypts without mutating state', async () => {
  const wallet = await PivxWallet.create({
    spendingKey: EXTSK,
    network: 'testnet',
    birthHeight: BIRTH,
  });
  const syncedBefore = wallet.getLastSyncedBlock();
  const outputs = wallet.previewTransaction(TX_HEX);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].recipient, SHIELD_ADDRESS);
  assert.equal(outputs[0].value, 1_000_000_000);
  // state untouched
  assert.equal(wallet.getBalance(), 0);
  assert.equal(wallet.getLastSyncedBlock(), syncedBefore);
});

test('save/load round-trip preserves state; spending key is excluded', async () => {
  const wallet = await PivxWallet.create({
    spendingKey: EXTSK,
    network: 'testnet',
    birthHeight: BIRTH,
  });
  wallet.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);

  const json = wallet.save();
  assert.ok(!json.includes(EXTSK), 'spending key must not be serialized');

  const restored = await PivxWallet.load(json);
  assert.equal(restored.getBalance(), 1_000_000_000);
  assert.equal(restored.getLastSyncedBlock(), BIRTH + 1);
  assert.equal(restored.canSpend, false);
  restored.loadSpendingKey(EXTSK);
  assert.ok(restored.canSpend);

  // scanning continues from restored state without complaint
  assert.throws(() => restored.handleBlocks([{ height: BIRTH + 1, txs: [] }]), /ascending/);
});

// R5-7 / R5-2: invalid-key conditions throw a typed InvalidKeyError (a subclass
// of Error, so existing `instanceof Error` / message catches still work),
// matching Rust's WalletError::InvalidKey. FAILS before (bare Error / no export),
// PASSES after.
test('R5-7/R5-2: invalid-key conditions throw InvalidKeyError (instanceof Error)', async () => {
  const seed = new Uint8Array(32).fill(7);

  // Wrong seed length (Rust keys.rs InvalidKey twin).
  const badSeed = await PivxWallet.create({ seed: new Uint8Array(31), network: 'testnet', birthHeight: BIRTH })
    .then(() => null, (e) => e);
  assert.ok(badSeed instanceof InvalidKeyError && badSeed instanceof Error, 'seed length → InvalidKeyError');

  // R5-2: accountIndex at/above the ZIP32 hardened boundary (0x80000000,
  // src/sapling/zip32.h) is rejected before the WASM call; the max valid index
  // (2^31-1) is accepted. Rust rejects the same via AccountId::try_from.
  const badAccount = await PivxWallet.create({ seed, network: 'testnet', birthHeight: BIRTH, accountIndex: 2 ** 31 })
    .then(() => null, (e) => e);
  assert.ok(badAccount instanceof InvalidKeyError && badAccount instanceof Error, 'accountIndex 2^31 → InvalidKeyError');
  await assert.doesNotReject(
    PivxWallet.create({ seed, network: 'testnet', birthHeight: BIRTH, accountIndex: 2 ** 31 - 1 }),
    'accountIndex 2^31-1 is accepted',
  );

  // loadSpendingKey already holds a key (Rust wallet.rs InvalidKey twin).
  const full = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  assert.throws(() => full.loadSpendingKey(EXTSK), (e) => e instanceof InvalidKeyError && e instanceof Error);

  // loadSpendingKey with a valid-but-mismatched key: EXTSK decodes fine but
  // derives a different viewing key than this watch-only wallet's → mismatch.
  const other = await PivxWallet.create({ seed, network: 'testnet', birthHeight: BIRTH });
  const otherVk = JSON.parse(other.save()).extfvk;
  const watch = await PivxWallet.create({ viewingKey: otherVk, network: 'testnet', birthHeight: BIRTH });
  assert.throws(() => watch.loadSpendingKey(EXTSK), (e) => e instanceof InvalidKeyError && e instanceof Error);
});

test('handleBlocks rejects non-ascending heights', async () => {
  const wallet = await PivxWallet.create({
    spendingKey: EXTSK,
    network: 'testnet',
    birthHeight: BIRTH,
  });
  assert.throws(
    () =>
      wallet.handleBlocks([
        { height: BIRTH + 2, txs: [] },
        { height: BIRTH + 1, txs: [] },
      ]),
    /ascending/,
  );
});

// S3: extsk is an ES #private field, so it can never be reached by
// console.log(wallet) / util.inspect / JSON.stringify — a TypeScript `private`
// field is only compile-time and would leak the spending key at runtime.
test('S3: spending key does not leak via JSON.stringify or util.inspect', async () => {
  const wallet = await PivxWallet.create({
    spendingKey: EXTSK,
    network: 'testnet',
    birthHeight: BIRTH,
  });
  assert.ok(wallet.canSpend, 'wallet must hold spend authority for this to be meaningful');
  assert.ok(
    !JSON.stringify(wallet).includes(EXTSK),
    'spending key must not appear in JSON.stringify output',
  );
  assert.ok(
    !util.inspect(wallet, { depth: null }).includes(EXTSK),
    'spending key must not appear in util.inspect output',
  );
  // #extsk is not even an own property name.
  assert.ok(!Object.getOwnPropertyNames(wallet).includes('extsk'));
});
