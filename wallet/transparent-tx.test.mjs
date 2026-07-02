import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTransparentTx, scriptPubKeyForAddress, deriveKey, encodeAddress } from '../dist/index.js';

// Signing correctness is proven by the mainnet-accepted send; these lock the
// serialization structure and script encoding.
const key = (n) => deriveKey(new Uint8Array(32).fill(n), 'mainnet', 0, 0, 0);

test('scriptPubKey encodes P2PKH, P2SH, exchange; rejects staking', () => {
  const h = new Uint8Array(20).fill(0x11);
  const p2pkh = scriptPubKeyForAddress(encodeAddress(h, 'mainnet', 'p2pkh'));
  assert.deepEqual([...p2pkh.slice(0, 3)], [0x76, 0xa9, 0x14]);
  assert.deepEqual([...p2pkh.slice(23)], [0x88, 0xac]);
  const p2sh = scriptPubKeyForAddress(encodeAddress(h, 'mainnet', 'p2sh'));
  assert.deepEqual([...p2sh.slice(0, 2)], [0xa9, 0x14]);
  assert.equal(p2sh[22], 0x87);
  const ex = scriptPubKeyForAddress(encodeAddress(h, 'mainnet', 'exchange'));
  assert.deepEqual([...ex.slice(0, 4)], [0xe0, 0x76, 0xa9, 0x14]); // OP_EXCHANGEADDR + P2PKH
  assert.deepEqual([...ex.slice(24)], [0x88, 0xac]);
  assert.throws(() => scriptPubKeyForAddress(encodeAddress(h, 'mainnet', 'staking')), /cold-staking/);
});

test('build produces a legacy v1 tx with the expected structure', () => {
  const k = key(2);
  const dest = key(3);
  const hex = buildTransparentTx(
    [{ txid: 'ab'.repeat(32), vout: 1, amount: 100_000_000, scriptPubKey: scriptPubKeyForAddress(k.address), privateKey: k.privateKey }],
    [{ address: dest.address, amount: 99_000_000 }],
  );
  assert.match(hex, /^01000000/); // nVersion=1, nType=0
  assert.match(hex, /00000000$/); // nLockTime = 0
  // signed single-input tx is well over the unsigned size
  assert.ok(hex.length / 2 > 150);
});

test('build validates amounts and inputs', () => {
  const k = key(2);
  const input = { txid: 'ab'.repeat(32), vout: 0, amount: 100_000_000, scriptPubKey: scriptPubKeyForAddress(k.address), privateKey: k.privateKey };
  assert.throws(() => buildTransparentTx([], [{ address: k.address, amount: 1 }]), /no inputs/);
  assert.throws(() => buildTransparentTx([input], [{ address: k.address, amount: -1 }]), /non-negative integer/);
  assert.throws(() => buildTransparentTx([{ ...input, amount: 1.5 }], [{ address: k.address, amount: 1 }]), /non-negative integer/);
});
