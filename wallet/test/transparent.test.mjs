import { test } from 'node:test';
import assert from 'node:assert/strict';
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
