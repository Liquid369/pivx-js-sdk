import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransparentWallet, deriveKey, scriptPubKeyForAddress, p2pkhAddress } from '../dist/index.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

// End-to-end signing/selection is proven by the mainnet-accepted round-trip;
// these lock tracking and selection behavior.
test('tracks own UTXOs, ignores others, selects and spends', () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(3), 'mainnet', 0, 20);
  const a0 = deriveKey(new Uint8Array(32).fill(3), 'mainnet', 0, 0, 0);
  assert.equal(w.addUtxo('aa'.repeat(32), 0, 200_000_000, scriptPubKeyForAddress(a0.address)), true);
  const other = p2pkhAddress(secp256k1.getPublicKey(new Uint8Array(32).fill(9), true), 'mainnet');
  assert.equal(w.addUtxo('bb'.repeat(32), 0, 5, scriptPubKeyForAddress(other)), false);
  assert.equal(w.balance(), 200_000_000);

  const { hex, spent } = w.buildSend(other, 100_000_000, 100);
  assert.match(hex, /^01000000/);
  assert.equal(spent.length, 1);
  w.markSpent(spent);
  assert.equal(w.balance(), 0);
});

test('scanBlock credits our outputs and removes spends', () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(7), 'mainnet', 0, 20);
  const a0 = deriveKey(new Uint8Array(32).fill(7), 'mainnet', 0, 0, 0);
  const spkHex = [...scriptPubKeyForAddress(a0.address)].map((b) => b.toString(16).padStart(2, '0')).join('');

  // Block 100: a tx paying us 1.5 PIV at vout 0 (coinbase vin skipped).
  w.scanBlock({
    height: 100,
    tx: [{
      txid: 'aa'.repeat(32),
      vin: [{ coinbase: '00' }],
      vout: [{ n: 0, value: 1.5, scriptPubKey: { hex: spkHex } }],
    }],
  });
  assert.equal(w.balance(), 150_000_000);
  assert.equal(w.lastScannedBlock(), 100);

  // Block 101: a tx spending that UTXO (aa:0).
  w.scanBlock({
    height: 101,
    tx: [{
      txid: 'bb'.repeat(32),
      vin: [{ txid: 'aa'.repeat(32), vout: 0 }],
      vout: [],
    }],
  });
  assert.equal(w.balance(), 0);
  assert.equal(w.lastScannedBlock(), 101);
});

test('insufficient balance throws', () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(4), 'mainnet', 0, 5);
  const a0 = deriveKey(new Uint8Array(32).fill(4), 'mainnet', 0, 0, 0);
  w.addUtxo('cc'.repeat(32), 0, 1000, scriptPubKeyForAddress(a0.address));
  assert.throws(() => w.buildSend(a0.address, 100_000_000, 100), /insufficient/);
});

test('rejects wrong-network destination, dust amount, and bad fee', () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(5), 'mainnet', 0, 5);
  const a0 = deriveKey(new Uint8Array(32).fill(5), 'mainnet', 0, 0, 0);
  w.addUtxo('cc'.repeat(32), 0, 200_000_000, scriptPubKeyForAddress(a0.address));
  const testnetDest = p2pkhAddress(a0.publicKey, 'testnet');
  assert.throws(() => w.buildSend(testnetDest, 100_000_000, 100), /different network/);
  assert.throws(() => w.buildSend(a0.address, 5000, 100), /dust/);        // < 5460 sats
  assert.throws(() => w.buildSend(a0.address, 100_000_000, -1), /feePerByte/);
  assert.doesNotThrow(() => w.buildSend(a0.address, 100_000_000, 100));
});

test('immature coinbase is not spendable until mature', () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(6), 'mainnet', 0, 5);
  const a0 = deriveKey(new Uint8Array(32).fill(6), 'mainnet', 0, 0, 0);
  const spkHex = [...scriptPubKeyForAddress(a0.address)].map((b) => b.toString(16).padStart(2, '0')).join('');
  w.scanBlock({
    height: 100,
    tx: [{ txid: 'dd'.repeat(32), vin: [{ coinbase: '00' }], vout: [{ n: 0, value: 5.0, scriptPubKey: { hex: spkHex } }] }],
  });
  assert.equal(w.balance(), 500_000_000);
  assert.throws(() => w.buildSend(a0.address, 100_000_000, 100), /insufficient/); // 1 confirmation
  w.scanBlock({ height: 199, tx: [] }); // 100 confirmations => mature
  assert.doesNotThrow(() => w.buildSend(a0.address, 100_000_000, 100));
});

test('scanBlock skips malformed vouts instead of poisoning balance', () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(7), 'mainnet', 0, 5);
  const a0 = deriveKey(new Uint8Array(32).fill(7), 'mainnet', 0, 0, 0);
  const spkHex = [...scriptPubKeyForAddress(a0.address)].map((b) => b.toString(16).padStart(2, '0')).join('');
  w.scanBlock({
    height: 10,
    tx: [{
      txid: 'ee'.repeat(32),
      vin: [{ coinbase: '00' }],
      vout: [
        { n: 0 },                                                    // missing value + script
        { n: 1, value: 2.0, scriptPubKey: {} },                      // missing hex
        { n: 2, value: 3.0, scriptPubKey: { hex: spkHex } },         // valid, ours
      ],
    }],
  });
  assert.equal(w.balance(), 300_000_000); // only the valid vout credited, no NaN
});
