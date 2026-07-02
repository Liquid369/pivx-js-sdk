import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PivxWallet, NoSpendAuthorityError } from '../dist/index.js';
import { EXTSK, SHIELD_ADDRESS, TX_HEX } from './fixtures.mjs';

// These tests run the real pivx-shield WASM: real key derivation, real note
// decryption against a known regtest transaction. No mocks.

const BIRTH = 100;

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
  const outputs = wallet.previewTransaction(TX_HEX);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].recipient, SHIELD_ADDRESS);
  assert.equal(outputs[0].value, 1_000_000_000);
  // state untouched
  assert.equal(wallet.getBalance(), 0);
  assert.equal(wallet.getLastSyncedBlock(), BIRTH);
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
