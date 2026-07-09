import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTransparentTx, transparentSighash, scriptPubKeyForAddress, deriveKey, encodeAddress } from '../dist/index.js';

// Signing correctness is proven by the regtest-accepted send; these lock the
// v3 (SAPLING) serialization structure, script encoding, and — via the
// amount-commitment test — that the sighash commits the input amount (S1).
const key = (n) => deriveKey(new Uint8Array(32).fill(n), 'mainnet', 0, 0, 0);

// Empty-but-present sapData: Optional(0x01) || valueBalance(0) || 0 spends ||
// 0 outputs || 64-byte zero bindingSig = 0x01 followed by 74 zero bytes.
const EMPTY_SAPDATA_HEX = '01' + '00'.repeat(74);

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

test('build produces a v3 (SAPLING) tx with empty sapData', () => {
  const k = key(2);
  const dest = key(3);
  const hex = buildTransparentTx(
    [{ txid: 'ab'.repeat(32), vout: 1, amount: 100_000_000, scriptPubKey: scriptPubKeyForAddress(k.address), privateKey: k.privateKey }],
    [{ address: dest.address, amount: 99_000_000 }],
  );
  assert.match(hex, /^03000000/); // nVersion=3 (int16 LE), nType=0 (int16 LE)
  assert.ok(hex.endsWith(EMPTY_SAPDATA_HEX), 'ends with empty-but-present sapData');
  // signed single-input tx is well over the unsigned size
  assert.ok(hex.length / 2 > 150);
});

// The whole point of S1: SIGVERSION_SAPLING commits the input amount, so
// changing ONLY the amount changes the sighash and therefore the signature.
test('sighash and signature commit the input amount (S1)', () => {
  const k = key(2);
  const dest = key(3);
  const mk = (amount) => [{ txid: 'ab'.repeat(32), vout: 0, amount, scriptPubKey: scriptPubKeyForAddress(k.address), privateKey: k.privateKey }];
  const out = [{ address: dest.address, amount: 99_000_000 }];
  assert.notEqual(transparentSighash(mk(100_000_000), out, 0), transparentSighash(mk(99_999_999), out, 0));
  assert.notEqual(buildTransparentTx(mk(100_000_000), out), buildTransparentTx(mk(99_999_999), out));
});

// Deterministic cross-SDK fixture (cross-checked byte-for-byte against the Rust
// build and validated on a regtest node). seed=32x0x07, testnet, account 0,
// first address owns a single 1 PIV input (txid=aa*32, vout 0), self-sends
// 0.9 PIV, locktime 0.
test('deterministic v3 fixture (cross-SDK vector)', () => {
  const k = deriveKey(new Uint8Array(32).fill(0x07), 'testnet', 0, 0, 0);
  const inputs = [{ txid: 'aa'.repeat(32), vout: 0, amount: 100_000_000, scriptPubKey: scriptPubKeyForAddress(k.address), privateKey: k.privateKey }];
  const outputs = [{ address: k.address, amount: 90_000_000 }];
  const sighash = transparentSighash(inputs, outputs, 0, 0);
  const hex = buildTransparentTx(inputs, outputs, 0);
  assert.equal(k.address, 'xydyjTeoyQft8D84bCxek6GZAWZ24uHpvE');
  assert.equal(sighash, 'ffbbfeb8d4e17599d4c80b70a699d29f3ddcea0cc6b8a72641a9faedfc8ba45d');
  assert.equal(
    hex,
    '0300000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000006b483045022100811ef9366425410ec139bd1e68584fe8914e304eff8d27fae63351306a0e33d502202a22c50cdeec362edabe09c328399d6c85ae7661e5fb90f2f9584eb50dc767b20121026ba36f35dfb3979ab7610e2839bd1f25c00df98bf9087f24d55488b485910f94ffffffff01804a5d05000000001976a9141d26a055949695e1753a1fd7cc747cb6218f5bd888ac00000000' + EMPTY_SAPDATA_HEX,
  );
});

// nSequence of a single-input tx, parsed from the raw hex: 4 bytes
// version+type, 1 varint vin count, 32 txid, 4 vout, 1 varint scriptSig
// length, scriptSig, then the 4 sequence bytes. (The v3 header is the same
// 4 leading bytes as v1, so these offsets are unchanged.)
const firstInputSequence = (hex) => {
  const scriptLen = parseInt(hex.slice(82, 84), 16);
  return hex.slice(84 + scriptLen * 2, 84 + scriptLen * 2 + 8);
};

// nLockTime sits just before the 75-byte (150 hex) sapData suffix.
const lockTimeHex = (hex) => hex.slice(-158, -150);

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
  assert.equal(lockTimeHex(withLock), '20a10700'); // nLockTime = 500000 LE
  assert.ok(withLock.endsWith(EMPTY_SAPDATA_HEX));
  assert.equal(firstInputSequence(withLock), 'feffffff'); // non-final
  const without = build(0);
  assert.equal(lockTimeHex(without), '00000000');
  assert.equal(firstInputSequence(without), 'ffffffff'); // final
});

test('build validates amounts and inputs', () => {
  const k = key(2);
  const input = { txid: 'ab'.repeat(32), vout: 0, amount: 100_000_000, scriptPubKey: scriptPubKeyForAddress(k.address), privateKey: k.privateKey };
  assert.throws(() => buildTransparentTx([], [{ address: k.address, amount: 1 }]), /no inputs/);
  assert.throws(() => buildTransparentTx([input], [{ address: k.address, amount: -1 }]), /non-negative integer/);
  assert.throws(() => buildTransparentTx([{ ...input, amount: 1.5 }], [{ address: k.address, amount: 1 }]), /non-negative integer/);
});
