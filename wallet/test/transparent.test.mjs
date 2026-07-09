import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { deriveKey, encodeAddress, decodeAddress, isValidAddress } from '../dist/index.js';

// The derived address is cross-checked against the Rust SDK (same seed →
// same address) and against the live node's validateaddress; this value is
// the locked cross-SDK/consensus reference.
test('BIP44 derivation matches the Rust SDK and is deterministic', () => {
  const seed = new Uint8Array(32).fill(9);
  const k = deriveKey(seed, 'mainnet', 0, 0, 0);
  assert.equal(k.address, 'DCj8jEiVxcYmBjVtqxeGENSegWSJSA73K6');
  assert.equal(deriveKey(seed, 'mainnet', 0, 0, 0).address, k.address);
  assert.notEqual(deriveKey(seed, 'mainnet', 0, 0, 1).address, k.address);
  assert.match(k.address, /^D/);
  assert.ok(k.wif.length > 0 && k.privateKey.length === 32 && k.publicKey.length === 33);
});

// S7: WIF is computed lazily (a getter), not eagerly on every derivation —
// TransparentWallet.create derives 2*gap keys (up to 20000) and never reads
// .wif, so eager encoding produced thousands of unused private-key strings on
// the heap. Matches Rust's lazy TransparentKey::wif(); a getter preserves the
// public `.wif` property shape for any caller that reads it.
test('S7: deriveKey computes wif lazily and still returns the correct value', () => {
  const seed = new Uint8Array(32).fill(9);
  const k = deriveKey(seed, 'mainnet', 0, 0, 0);
  const desc = Object.getOwnPropertyDescriptor(k, 'wif');
  assert.equal(typeof desc.get, 'function', 'wif must be an accessor (computed on read)');
  assert.equal(desc.value, undefined, 'wif must not be an eagerly-materialized string');
  // Correctness: reading .wif yields the compressed-WIF base58check encoding,
  // recomputed here independently from the raw private key (mainnet prefix 0xD4).
  const b58c = base58check(sha256);
  const expected = b58c.encode(Uint8Array.from([212, ...k.privateKey, 0x01]));
  assert.equal(k.wif, expected);
  // Deterministic across reads and re-derivations.
  assert.equal(k.wif, deriveKey(seed, 'mainnet', 0, 0, 0).wif);
});

// W-SEED reference lock (funds-critical): a 64-byte BIP39 seed derives the same
// m/44'/119'/0'/0/0 address MyPIVXWallet (MPW) / BIP39 seed-phrase wallets produce
// (BIP32 over the FULL seed). This is the correctness gate for accepting the BIP39 seed.
test('W-SEED: 64-byte BIP39 seed derives the reference PIVX address', () => {
  // BIP39 seed (empty passphrase) of the standard test mnemonic
  // "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".
  const seed = Uint8Array.from(
    ('5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1' +
      '9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4')
      .match(/../g)
      .map((b) => parseInt(b, 16)),
  );
  assert.equal(seed.length, 64);
  assert.equal(deriveKey(seed, 'mainnet', 0, 0, 0).address, 'DPo9TNvPwy2ZfmVM3CRCxbBvh6NojguWXJ');
});

// W-SEEDLEN: the exported deriveKey enforces the 32/64-byte seed contract at its
// top (the transparent constructors route through it), so an out-of-contract
// length can no longer bypass the check by calling deriveKey directly.
test('deriveKey rejects seeds that are not 32 or 64 bytes', () => {
  for (const n of [16, 33, 48]) {
    assert.throws(
      () => deriveKey(new Uint8Array(n).fill(1), 'mainnet', 0, 0, 0),
      /seed must be 32 bytes \(raw\) or 64 bytes \(BIP39\)/,
    );
  }
  assert.doesNotThrow(() => deriveKey(new Uint8Array(32).fill(1), 'mainnet', 0, 0, 0));
  assert.doesNotThrow(() => deriveKey(new Uint8Array(64).fill(1), 'mainnet', 0, 0, 0));
});

// W1: reject out-of-range account (hardened) / change / index rather than
// deriving a silently-wrong key.
test('W1: deriveKey rejects out-of-range account/change/index', () => {
  const seed = new Uint8Array(32).fill(9);
  assert.throws(() => deriveKey(seed, 'mainnet', 2 ** 31, 0, 0), /account/);
  assert.doesNotThrow(() => deriveKey(seed, 'mainnet', 2 ** 31 - 1, 0, 0));
  assert.throws(() => deriveKey(seed, 'mainnet', 1.5, 0, 0), /account/);
  assert.throws(() => deriveKey(seed, 'mainnet', 0, 1.5, 0), /change/);
  assert.throws(() => deriveKey(seed, 'mainnet', 0, 0, 2 ** 40), /index/);
});

test('address encode/decode round-trips for every kind and network', () => {
  const h = new Uint8Array(20).fill(0x11);
  for (const network of ['mainnet', 'testnet']) {
    for (const kind of ['p2pkh', 'p2sh', 'staking', 'exchange']) {
      const addr = encodeAddress(h, network, kind);
      const d = decodeAddress(addr);
      assert.deepEqual([...d.hash], [...h]);
      assert.equal(d.kind, kind);
      assert.equal(d.network, network);
    }
  }
});

test('exchange addresses carry the EXM/EXT prefix', () => {
  const h = new Uint8Array(20).fill(0x22);
  assert.match(encodeAddress(h, 'mainnet', 'exchange'), /^EXM/);
  assert.match(encodeAddress(h, 'testnet', 'exchange'), /^EXT/);
});

test('isValidAddress rejects garbage and bad checksums', () => {
  assert.equal(isValidAddress('not an address'), false);
  assert.equal(isValidAddress('DMJRSsuU9zfyrvxVaAEFQqK4MxZg6vgeS6X'), false); // bad checksum
  assert.equal(isValidAddress('DCj8jEiVxcYmBjVtqxeGENSegWSJSA73K6'), true);
});
