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

// nSequence of a single-input tx, parsed from the raw hex: 4 bytes
// version+type, 1 varint vin count, 32 txid, 4 vout, 1 varint scriptSig
// length, scriptSig, then the 4 sequence bytes.
const firstInputSequence = (hex) => {
  const scriptLen = parseInt(hex.slice(82, 84), 16);
  return hex.slice(84 + scriptLen * 2, 84 + scriptLen * 2 + 8);
};

// C11: a non-zero locktime needs a non-final nSequence (0xfffffffe) or the
// node ignores nLockTime entirely (IsFinalTx).
test('locktime != 0 sets the non-final nSequence 0xfffffffe', () => {
  const k = key(2);
  const dest = key(3);
  const build = (locktime) => buildTransparentTx(
    [{ txid: 'ab'.repeat(32), vout: 0, amount: 100_000_000, scriptPubKey: scriptPubKeyForAddress(k.address), privateKey: k.privateKey }],
    [{ address: dest.address, amount: 99_000_000 }],
    locktime,
  );
  const withLock = build(500_000);
  assert.match(withLock, /20a10700$/); // nLockTime = 500000 LE
  assert.equal(firstInputSequence(withLock), 'feffffff'); // non-final
  const without = build(0);
  assert.match(without, /00000000$/);
  assert.equal(firstInputSequence(without), 'ffffffff'); // final
});

test('build validates amounts and inputs', () => {
  const k = key(2);
  const input = { txid: 'ab'.repeat(32), vout: 0, amount: 100_000_000, scriptPubKey: scriptPubKeyForAddress(k.address), privateKey: k.privateKey };
  assert.throws(() => buildTransparentTx([], [{ address: k.address, amount: 1 }]), /no inputs/);
  assert.throws(() => buildTransparentTx([input], [{ address: k.address, amount: -1 }]), /non-negative integer/);
  assert.throws(() => buildTransparentTx([{ ...input, amount: 1.5 }], [{ address: k.address, amount: 1 }]), /non-negative integer/);
});
