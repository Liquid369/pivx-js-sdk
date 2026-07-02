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

test('insufficient balance throws', () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(4), 'mainnet', 0, 5);
  const a0 = deriveKey(new Uint8Array(32).fill(4), 'mainnet', 0, 0, 0);
  w.addUtxo('cc'.repeat(32), 0, 1000, scriptPubKeyForAddress(a0.address));
  assert.throws(() => w.buildSend(a0.address, 100_000_000, 100), /insufficient/);
});
