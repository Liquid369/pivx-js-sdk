import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TransparentWallet,
  ScanDivergedError,
  buildTransparentTx,
  deriveKey,
  scriptPubKeyForAddress,
  p2pkhAddress,
  encodeAddress,
  decodeAddress,
  hash160,
} from '../dist/index.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

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

// Stub chain for sync tests: hash/previousblockhash are required by sync's
// malformed-block guard and must be continuous for the reorg check.
const stubHash = (h) => h.toString(16).padStart(64, '0');
const stubBlock = (h) => ({ height: h, hash: stubHash(h), previousblockhash: stubHash(h - 1), tx: [] });

test('sync with batchSize 0 terminates (clamped to 1)', async () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(8), 'mainnet', 0, 5);
  const client = {
    getBlockCount: async () => 3,
    getBlockHash: async (h) => `hash:${h}`,
    getBlock: async (hash) => stubBlock(Number(hash.split(':')[1])),
  };
  await w.sync(client, { batchSize: 0 }); // used to loop forever (from = to + 1 with to = from - 1)
  assert.equal(w.lastScannedBlock(), 3);
});

test('sync abort: throws signal.reason at the batch boundary, keeps scanned blocks, releases busy', async () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(17), 'mainnet', 0, 5);
  // Honest chain: getBlockHash(h) agrees with the block's own hash field, so a
  // resume sync's tip check matches and does not trip the reorg walk-back.
  const client = {
    getBlockCount: async () => 4,
    getBlockHash: async (h) => stubHash(h),
    getBlock: async (hash) => stubBlock(parseInt(hash, 16)),
  };
  const ac = new AbortController();
  const reason = new Error('operator stop');
  await assert.rejects(
    w.sync(client, { batchSize: 2, signal: ac.signal, onProgress: () => ac.abort(reason) }),
    (err) => err === reason, // custom abort reason propagates as-is
  );
  assert.equal(w.lastScannedBlock(), 2); // only the fully scanned first batch

  // Busy guard released: a follow-up sync resumes from block 3 and completes.
  await w.sync(client);
  assert.equal(w.lastScannedBlock(), 4);
});

test('recognizes, tracks, and spends 26-byte exchange (EXM) outputs', () => {
  const seed = new Uint8Array(32).fill(11);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const exm = encodeAddress(hash160(a0.publicKey), 'mainnet', 'exchange');
  const exmScript = scriptPubKeyForAddress(exm);
  assert.equal(exmScript.length, 26); // e0 76 a9 14 <20> 88 ac

  w.scanBlock({
    height: 100,
    tx: [{
      txid: 'aa'.repeat(32),
      vin: [{ txid: 'ff'.repeat(32), vout: 0 }],
      vout: [{ n: 0, value: 2.0, scriptPubKey: { hex: toHex(exmScript) } }],
    }],
  });
  assert.equal(w.balance(), 200_000_000); // scanBlock credited the exchange output

  assert.equal(w.addUtxo('bb'.repeat(32), 1, 100_000_000, exmScript), true);
  assert.equal(w.balance(), 300_000_000);

  const { hex, spent } = w.buildSend(a0.address, 250_000_000, 100); // needs both EXM utxos
  assert.match(hex, /^01000000/);
  assert.equal(spent.length, 2);
});

test('newExchangeAddress: EXM encoding of the same hash160 as the next newAddress', () => {
  const seed = new Uint8Array(32).fill(12);
  const w1 = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const w2 = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const exm = w1.newExchangeAddress();
  const p2pkh = w2.newAddress();
  assert.match(exm, /^EXM/);
  const dExm = decodeAddress(exm);
  const dP = decodeAddress(p2pkh);
  assert.equal(dExm.kind, 'exchange');
  assert.equal(dP.kind, 'p2pkh');
  assert.deepEqual([...dExm.hash], [...dP.hash]); // same key, two encodings
  // Shared cursor: handing out the EXM form advanced past index 0.
  assert.notEqual(w1.newAddress(), p2pkh);
});

test('save/load round-trip preserves cursors, scan position, utxos, and pending', () => {
  const seed = new Uint8Array(32).fill(13);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  w.newAddress();
  w.newExchangeAddress();
  w.scanBlock({
    height: 100,
    hash: 'ab'.repeat(32),
    tx: [{
      txid: 'aa'.repeat(32),
      vin: [{ coinbase: '00' }],
      vout: [{ n: 0, value: 5.0, scriptPubKey: { hex: toHex(scriptPubKeyForAddress(a0.address)) } }],
    }],
  });
  w.addUtxo('bb'.repeat(32), 2, 300_000_000, scriptPubKeyForAddress(a0.address));
  w.scanBlock({ height: 250, hash: 'cd'.repeat(32), tx: [] }); // coinbase now mature
  w.buildSend(a0.address, 400_000_000, 100); // reserves the 5.0 coinbase, uses change cursor 0

  const json = w.save();
  const s = JSON.parse(json);
  assert.deepEqual(Object.keys(s).sort(), [
    'account', 'gap', 'lastScanned', 'lastScannedHash', 'network',
    'nextChange', 'nextExternal', 'pending', 'scannedHashes', 'utxos', 'version',
  ]);
  assert.equal(s.version, 1);
  assert.equal(s.network, 'mainnet');
  assert.equal(s.account, 0);
  assert.equal(s.gap, 5);
  assert.equal(s.nextExternal, 2);
  assert.equal(s.nextChange, 1);
  assert.equal(s.lastScanned, 250);
  assert.equal(s.lastScannedHash, 'cd'.repeat(32));
  // The rolling reorg window round-trips (both scanned blocks, ascending).
  assert.deepEqual(s.scannedHashes, [
    { height: 100, hash: 'ab'.repeat(32) },
    { height: 250, hash: 'cd'.repeat(32) },
  ]);
  assert.equal(s.utxos.length, 2);
  assert.deepEqual(s.pending, [{ txid: 'aa'.repeat(32), vout: 0 }]);
  // No key material: neither the WIF nor the raw private key of the involved key.
  assert.ok(!json.includes(a0.wif));
  assert.ok(!json.toLowerCase().includes(toHex(a0.privateKey)));

  const w2 = TransparentWallet.load(seed, json);
  assert.equal(w2.lastScannedBlock(), 250);
  assert.equal(w2.balance(), 300_000_000); // the reservation survived the round-trip
  const cb = w2.getUtxos().find((u) => u.txid === 'aa'.repeat(32));
  assert.equal(cb.coinbase, true);
  assert.equal(cb.height, 100);
  // The loaded wallet can spend the non-reserved utxo.
  const r2 = w2.buildSend(a0.address, 100_000_000, 100);
  assert.match(r2.hex, /^01000000/);
  assert.deepEqual(r2.spent, [{ txid: 'bb'.repeat(32), vout: 2 }]);
  // Stable round-trip: load(save(x)).save() === save(x).
  assert.equal(TransparentWallet.load(seed, json).save(), json);
});

test('load with the wrong seed throws', () => {
  const seed = new Uint8Array(32).fill(13);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  w.addUtxo('aa'.repeat(32), 0, 100_000_000, scriptPubKeyForAddress(a0.address));
  const json = w.save();
  assert.throws(() => TransparentWallet.load(new Uint8Array(32).fill(99), json), /does not match/);
});

test('buildSend reserves inputs: disjoint selection, release restores, markSpent finalizes', () => {
  const seed = new Uint8Array(32).fill(14);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spk = scriptPubKeyForAddress(a0.address);
  w.addUtxo('aa'.repeat(32), 0, 200_000_000, spk);
  w.addUtxo('bb'.repeat(32), 1, 200_000_000, spk);

  const first = w.buildSend(a0.address, 100_000_000, 100);
  const second = w.buildSend(a0.address, 100_000_000, 100);
  const key = (o) => `${o.txid}:${o.vout}`;
  assert.equal(first.spent.filter((s) => second.spent.some((t) => key(t) === key(s))).length, 0);

  assert.equal(w.balance(), 0); // both reserved
  assert.equal(w.getUtxos().length, 2); // getUtxos still lists reserved utxos
  assert.throws(() => w.buildSend(a0.address, 100_000_000, 100), /insufficient/);

  w.release(second.spent); // definitively rejected broadcast → selectable again
  assert.equal(w.balance(), 200_000_000);
  assert.doesNotThrow(() => w.buildSend(a0.address, 100_000_000, 100));

  w.markSpent(first.spent); // confirmed broadcast → gone for good
  assert.equal(w.getUtxos().length, 1);
});

test('reorg: mismatched previousblockhash throws ScanDivergedError; resetScan recovers', () => {
  const seed = new Uint8Array(32).fill(15);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spkHex = toHex(scriptPubKeyForAddress(a0.address));
  w.scanBlock({
    height: 100,
    hash: 'aa'.repeat(32),
    tx: [{
      txid: '11'.repeat(32),
      vin: [{ txid: 'ff'.repeat(32), vout: 9 }],
      vout: [{ n: 0, value: 1.0, scriptPubKey: { hex: spkHex } }],
    }],
  });
  assert.equal(w.balance(), 100_000_000);

  // Block 101 built on a different block 100 → divergence, nothing mutated
  // (the block's spend of 11:0 must not be applied).
  assert.throws(
    () => w.scanBlock({
      height: 101,
      hash: 'cc'.repeat(32),
      previousblockhash: 'bb'.repeat(32),
      tx: [{ txid: '22'.repeat(32), vin: [{ txid: '11'.repeat(32), vout: 0 }], vout: [] }],
    }),
    ScanDivergedError,
  );
  assert.equal(w.balance(), 100_000_000);
  assert.equal(w.lastScannedBlock(), 100);

  // Recovery: scanned utxos above the reset height are dropped, caller-supplied kept.
  w.addUtxo('33'.repeat(32), 0, 50_000_000, scriptPubKeyForAddress(a0.address));
  w.resetScan(99);
  assert.equal(w.lastScannedBlock(), 99);
  assert.equal(w.balance(), 50_000_000);
  // Hash cleared: the replacement block 100 is accepted whatever it builds on.
  assert.doesNotThrow(() =>
    w.scanBlock({ height: 100, hash: 'ee'.repeat(32), previousblockhash: 'bb'.repeat(32), tx: [] }));
});

test('sync resets to the true fork on a within-window reorg: orphan dropped, new chain credited', async () => {
  const seed = new Uint8Array(32).fill(21);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spkHex = toHex(scriptPubKeyForAddress(a0.address));
  // Explicit hashes so getBlockHash(h) and the block's own hash field agree —
  // the reorg check compares the two, so they must match on an honest chain.
  const blk = (h, hash, prev, tx = []) => ({ height: h, hash, previousblockhash: prev, tx });
  const pay = (txid, amt) => [{ txid, vin: [{ txid: 'ff'.repeat(32), vout: 9 }],
    vout: [{ n: 0, value: amt, scriptPubKey: { hex: spkHex } }] }];

  // Chain A (1..5); block 5 pays us 2 PIV (the deposit a reorg will orphan).
  let chain = {
    1: blk(1, 'a1'.repeat(32), '00'.repeat(32)),
    2: blk(2, 'a2'.repeat(32), 'a1'.repeat(32)),
    3: blk(3, 'a3'.repeat(32), 'a2'.repeat(32)),
    4: blk(4, 'a4'.repeat(32), 'a3'.repeat(32)),
    5: blk(5, 'a5'.repeat(32), 'a4'.repeat(32), pay('11'.repeat(32), 2.0)),
  };
  const byHash = () => Object.fromEntries(Object.values(chain).map((b) => [b.hash, b]));
  let blockFetches = 0;
  let hashCalls = 0;
  const client = {
    getBlockCount: async () => 5,
    getBlockHash: async (h) => { hashCalls++; return chain[h].hash; },
    getBlock: async (hash) => { blockFetches++; return byHash()[hash]; },
  };

  await w.sync(client);
  assert.equal(w.balance(), 200_000_000); // chain-A deposit credited
  assert.equal(w.lastScannedBlock(), 5);

  // No-reorg re-sync: exactly one getBlockHash (the tip check) matches the
  // stored hash → no walk, no reset, no block re-fetch, deposit untouched.
  blockFetches = 0;
  hashCalls = 0;
  await w.sync(client);
  assert.equal(hashCalls, 1, 'no-reorg re-sync must issue exactly one getBlockHash');
  assert.equal(blockFetches, 0, 'no-reorg re-sync must not reset or rescan');
  assert.equal(w.balance(), 200_000_000);
  assert.equal(w.lastScannedBlock(), 5);

  // Same-height reorg forking at height 3: blocks 4 and 5 are replaced (tip
  // height stays 5); the replacement block 5 instead pays us 3 PIV.
  chain = {
    ...chain,
    4: blk(4, 'b4'.repeat(32), 'a3'.repeat(32)),
    5: blk(5, 'b5'.repeat(32), 'b4'.repeat(32), pay('22'.repeat(32), 3.0)),
  };
  blockFetches = 0;
  await w.sync(client);
  // Reset to the TRUE fork (3), not blindly to lastScanned-100: only blocks 4
  // and 5 are re-fetched.
  assert.equal(blockFetches, 2, 'reorg resets to the true fork and rescans only 4..5');
  assert.equal(w.lastScannedBlock(), 5);
  assert.equal(w.balance(), 300_000_000); // orphaned 2 PIV gone, new 3 PIV credited
  assert.equal(w.getUtxos().length, 1);
});

test('sync throws ScanDivergedError on a reorg deeper than the window (fail-safe)', async () => {
  const seed = new Uint8Array(32).fill(22);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const TIP = 105; // > REORG_WINDOW (100): the fork lands below the oldest window entry
  // Per-chain, per-height distinct 64-hex hashes.
  const H = (c, n) => (c === 'a' ? 'aa' : 'bb') + n.toString(16).padStart(62, '0');
  let tag = 'a';
  const client = {
    getBlockCount: async () => TIP,
    getBlockHash: async (n) => H(tag, n),
    getBlock: async (hash) => {
      const c = hash.startsWith('aa') ? 'a' : 'b';
      const n = parseInt(hash.slice(2), 16);
      return { height: n, hash, previousblockhash: H(c, n - 1), tx: [] };
    },
  };

  await w.sync(client);
  assert.equal(w.lastScannedBlock(), TIP);

  // Whole-chain reorg: every height now hashes differently, so no stored window
  // entry (heights 6..105) matches the node — the fork is beyond the window and
  // cannot be located, so sync must fail loud instead of silently self-healing.
  tag = 'b';
  await assert.rejects(w.sync(client), ScanDivergedError);
  // State is left intact for the caller to reset from a trusted checkpoint.
  assert.equal(w.lastScannedBlock(), TIP);
});

test('concurrent sync throws busy', async () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(16), 'mainnet', 0, 5);
  // Honest chain (consistent getBlockHash/hash) so the post-completion re-sync's
  // tip check matches and does not trip the reorg walk-back.
  const client = {
    getBlockCount: async () => 2,
    getBlockHash: async (h) => stubHash(h),
    getBlock: async (hash) => {
      await new Promise((r) => setTimeout(r, 10));
      return stubBlock(parseInt(hash, 16));
    },
  };
  const p1 = w.sync(client);
  await assert.rejects(w.sync(client), /busy/);
  await p1;
  assert.equal(w.lastScannedBlock(), 2);
  await w.sync(client); // guard released after completion
});

// Cross-SDK state fixture: this exact JSON is what BOTH SDKs' save() must
// emit for the recipe below (the Rust suite byte-compares the same string).
// Any change to the state format must update both suites together.
const CROSS_SDK_STATE = '{"version":1,"network":"mainnet","account":0,"gap":3,"nextExternal":1,"nextChange":1,"lastScanned":7,"lastScannedHash":"0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b","scannedHashes":[{"height":7,"hash":"0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"}],"utxos":[{"txid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","vout":0,"amount":123456789,"scriptPubKey":"76a9149fae9617b8665480001546cf2825fcc6465e0c3288ac","keyHash":"9fae9617b8665480001546cf2825fcc6465e0c32","coinbase":false,"height":0},{"txid":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","vout":0,"amount":100000000,"scriptPubKey":"76a9149fae9617b8665480001546cf2825fcc6465e0c3288ac","keyHash":"9fae9617b8665480001546cf2825fcc6465e0c32","coinbase":true,"height":7}],"pending":[{"txid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","vout":0}]}';

test('save() output is byte-identical to the Rust SDK for the shared recipe', () => {
  const seed = new Uint8Array(32).fill(1);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 3);
  const addr0 = w.newAddress();
  assert.equal(addr0, 'DKhR8EBzgqFh7D98cxS1FDJYtdgEMyWvZ9'); // locked cross-SDK
  w.addUtxo('aa'.repeat(32), 0, 123456789, scriptPubKeyForAddress(addr0));
  const spkHex = [...scriptPubKeyForAddress(addr0)].map((b) => b.toString(16).padStart(2, '0')).join('');
  w.scanBlock({ height: 7, hash: '0b'.repeat(32), tx: [{ txid: 'cd'.repeat(32), vin: [{ coinbase: '00' }], vout: [{ n: 0, value: 1.0, scriptPubKey: { hex: spkHex } }] }] });
  w.buildSend(addr0, 50_000_000, 100);
  assert.equal(w.save(), CROSS_SDK_STATE);
});

test('loads a Rust-SDK-saved state and restores every field', () => {
  const w = TransparentWallet.load(new Uint8Array(32).fill(1), CROSS_SDK_STATE);
  assert.equal(w.lastScannedBlock(), 7);
  assert.equal(w.balance(), 100_000_000); // aa:0 reserved; coinbase counted (maturity gates spend, not balance)
  assert.equal(w.getUtxos().length, 2);
  // Reservation survived: only the immature coinbase remains, so a send fails.
  assert.throws(() => w.buildSend('DKhR8EBzgqFh7D98cxS1FDJYtdgEMyWvZ9', 50_000_000, 100), /insufficient/);
  // Cursors survived: next external is index 1, not 0.
  assert.notEqual(w.newAddress(), 'DKhR8EBzgqFh7D98cxS1FDJYtdgEMyWvZ9');
});

test('load rejects hostile states', () => {
  const seed = new Uint8Array(32).fill(1);
  // Foreign scriptPubKey paired with a valid keyHash: the wallet must not
  // sign an arbitrary script with its key.
  const foreign = CROSS_SDK_STATE.replace(
    '76a9149fae9617b8665480001546cf2825fcc6465e0c3288ac',
    '76a914000000000000000000000000000000000000000088ac',
  );
  assert.throws(() => TransparentWallet.load(seed, foreign), /does not pay its key hash/);
  // Oversized gap: hang-on-load derivation DoS.
  assert.throws(() => TransparentWallet.load(seed, CROSS_SDK_STATE.replace('"gap":3', '"gap":20000')), /gap/);
  // Malformed txid (not 64-hex) corrupts composite keys.
  const badTxid = CROSS_SDK_STATE.replace(
    '"txid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","vout":0,"amount":123456789',
    '"txid":"aa:aa","vout":0,"amount":123456789',
  );
  assert.throws(() => TransparentWallet.load(seed, badTxid), /malformed utxo/);
  // Amount above the safe-integer bound must fail in BOTH SDKs.
  assert.throws(() => TransparentWallet.load(seed, CROSS_SDK_STATE.replace('123456789', '9007199254740993')));
});

// A4: the Rust SDK deserializes vout as u32, so JS load() must cap vout at
// 0xffffffff — otherwise a state with vout in (2^32, 2^53) would load in JS but
// not Rust. FAILS before (isCount accepted up to 2^53-1), PASSES after.
test('A4: load caps vout at 0xffffffff to match Rust u32 (loads in both or neither)', () => {
  const seed = new Uint8Array(32).fill(1);
  // utxo vout = 2^32 rejected.
  assert.throws(
    () => TransparentWallet.load(seed, CROSS_SDK_STATE.replace('"vout":0,"amount":123456789', '"vout":4294967296,"amount":123456789')),
    /malformed utxo/,
  );
  // pending vout = 2^32 rejected (the pending entry is the only `"vout":0}]`).
  assert.throws(
    () => TransparentWallet.load(seed, CROSS_SDK_STATE.replace('"vout":0}]', '"vout":4294967296}]')),
    /malformed pending entry/,
  );
  // The exact u32 max (0xffffffff) is still accepted — it's a cap, not a ban.
  assert.doesNotThrow(() =>
    TransparentWallet.load(seed, CROSS_SDK_STATE.replace('"vout":0,"amount":123456789', '"vout":4294967295,"amount":123456789')),
  );
});

test('a scan-observed spend clears the reservation with the utxo', () => {
  const seed = new Uint8Array(32).fill(3);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 20);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  w.addUtxo('aa'.repeat(32), 0, 200_000_000, scriptPubKeyForAddress(a0.address));
  w.buildSend(a0.address, 100_000_000, 100); // reserves aa:0
  // The spend confirms on-chain: the reservation must not outlive the UTXO.
  w.scanBlock({
    height: 50,
    hash: '0c'.repeat(32),
    tx: [{ txid: 'bb'.repeat(32), vin: [{ txid: 'aa'.repeat(32), vout: 0 }], vout: [] }],
  });
  const st = JSON.parse(w.save());
  assert.equal(st.pending.length, 0);
  assert.equal(st.utxos.length, 0);
});

test('sync rejects a block missing hash/previousblockhash instead of scanning past it', async () => {
  const w = TransparentWallet.create(new Uint8Array(32).fill(9), 'mainnet', 0, 5);
  const client = {
    getBlockCount: async () => 2,
    getBlockHash: async (h) => `hash:${h}`,
    getBlock: async () => ({ height: 1, tx: [] }), // no hash/previousblockhash
  };
  await assert.rejects(w.sync(client), /without hash\/previousblockhash/);
});

// Finding 2: buildSend is synchronous but can run in the event-loop gap while a
// sync is suspended on an RPC await; selecting a UTXO an in-flight reorg reset
// is about to drop would broadcast a spend of an orphaned output. The busy
// guard (the one sync sets) refuses buildSend while a sync holds it.
test('buildSend refuses to run while a sync is in progress (busy guard)', () => {
  const seed = new Uint8Array(32).fill(18);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  w.addUtxo('aa'.repeat(32), 0, 200_000_000, scriptPubKeyForAddress(a0.address));
  w['busy'] = true; // a sync holds the guard (set before its first RPC await)
  assert.throws(() => w.buildSend(a0.address, 100_000_000, 100), /busy/);
  w['busy'] = false; // guard released → selection proceeds normally
  assert.doesNotThrow(() => w.buildSend(a0.address, 100_000_000, 100));
});

// Finding 3: honest save() output is ascending, unique, ≤ REORG_WINDOW entries,
// all heights ≤ lastScanned. load must reject any window that violates this, so
// the reorg walk-back (which trusts array order and heights) can't be misled.
test('load rejects a future / non-ascending / oversized scannedHashes window', () => {
  const seed = new Uint8Array(32).fill(1);
  const base = JSON.parse(CROSS_SDK_STATE); // lastScanned 7, one window entry at 7
  const hashOf = (n) => n.toString(16).padStart(2, '0').repeat(32);
  const withState = (o) => JSON.stringify({ ...base, ...o });

  // Future entry: height above lastScanned (7).
  assert.throws(
    () => TransparentWallet.load(seed, withState({ scannedHashes: [{ height: 8, hash: hashOf(8) }] })),
    /invalid scanned-hash window/,
  );
  // Duplicate height (not strictly ascending).
  assert.throws(
    () => TransparentWallet.load(seed, withState({ scannedHashes: [{ height: 7, hash: hashOf(7) }, { height: 7, hash: hashOf(0) }] })),
    /invalid scanned-hash window/,
  );
  // Descending heights.
  assert.throws(
    () => TransparentWallet.load(seed, withState({ scannedHashes: [{ height: 6, hash: hashOf(6) }, { height: 5, hash: hashOf(5) }] })),
    /invalid scanned-hash window/,
  );
  // Longer than REORG_WINDOW (100): 101 ascending, in-range entries — only the
  // length rule fails (lastScanned bumped so heights stay ≤ it).
  const long = Array.from({ length: 101 }, (_, i) => ({ height: i, hash: hashOf(i % 256) }));
  assert.throws(
    () => TransparentWallet.load(seed, withState({ lastScanned: 200, scannedHashes: long })),
    /invalid scanned-hash window/,
  );

  // An honest window still loads (regression guard).
  assert.doesNotThrow(() => TransparentWallet.load(seed, CROSS_SDK_STATE));
});

// C1: selecting past MAX_STANDARD_TX_SIZE (100000, PIVX validation.h) must
// error with consolidation guidance instead of building a tx the network
// will never relay.
test('buildSend caps at the 100kB standard tx size instead of building a doomed tx', () => {
  const seed = new Uint8Array(32).fill(30);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spk = scriptPubKeyForAddress(a0.address);
  // 700 dust UTXOs: satisfying the send needs > 675 inputs (> 100kB).
  for (let i = 0; i < 700; i++) {
    assert.equal(w.addUtxo(i.toString(16).padStart(64, '0'), 0, 10_000, spk), true);
  }
  assert.throws(() => w.buildSend(a0.address, 6_000_000, 10), /100kB standard size.*consolidate/);
});

// C2: an absurd feePerByte must yield a labeled error, not a fee past exact-
// integer range that silently corrupts every later comparison.
test('buildSend errors on fee overflow instead of computing with unsafe integers', () => {
  const seed = new Uint8Array(32).fill(31);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  w.addUtxo('cc'.repeat(32), 0, 200_000_000, scriptPubKeyForAddress(a0.address));
  assert.throws(() => w.buildSend(a0.address, 100_000_000, 2 ** 60), /overflows/);
});

// C3: coinstake detection requires vout[0] to be EMPTY (zero value AND empty
// script, CTxOut::IsEmpty). A zero-value OP_RETURN vout[0] tx paying us must
// NOT be maturity-gated; a true coinstake still is.
test('zero-value OP_RETURN vout[0] is not mistaken for a coinstake', () => {
  const seed = new Uint8Array(32).fill(32);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spkHex = toHex(scriptPubKeyForAddress(a0.address));
  // Zero-value OP_RETURN at vout[0] (script '6a', not empty), pays us at
  // vout 1: an ordinary tx, spendable with one confirmation.
  w.scanBlock({
    height: 100,
    tx: [{
      txid: '55'.repeat(32),
      vin: [{ txid: '44'.repeat(32), vout: 0 }],
      vout: [
        { n: 0, value: 0, scriptPubKey: { hex: '6a' } },
        { n: 1, value: 2.0, scriptPubKey: { hex: spkHex } },
      ],
    }],
  });
  assert.equal(w.balance(), 200_000_000);
  assert.doesNotThrow(() => w.buildSend(a0.address, 100_000_000, 100));

  // A true coinstake (empty vout[0]: value 0 AND script '') IS gated.
  const w2 = TransparentWallet.create(seed, 'mainnet', 0, 5);
  w2.scanBlock({
    height: 100,
    tx: [{
      txid: '66'.repeat(32),
      vin: [{ txid: '44'.repeat(32), vout: 0 }],
      vout: [
        { n: 0, value: 0, scriptPubKey: { hex: '' } },
        { n: 1, value: 2.0, scriptPubKey: { hex: spkHex } },
      ],
    }],
  });
  assert.equal(w2.balance(), 200_000_000);
  assert.throws(() => w2.buildSend(a0.address, 100_000_000, 100), /insufficient/);
});

// C4: addUtxo must reject what load() rejects — otherwise a wallet can
// save() a state it can never load() again.
test('addUtxo rejects what load would reject, and the state still round-trips', () => {
  const seed = new Uint8Array(32).fill(33);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spk = scriptPubKeyForAddress(a0.address);
  assert.equal(w.addUtxo('aa'.repeat(31), 0, 1000, spk), false);       // txid not 64-hex
  assert.equal(w.addUtxo('zz'.repeat(32), 0, 1000, spk), false);       // txid not hex
  assert.equal(w.addUtxo('aa'.repeat(32), 1.5, 1000, spk), false);     // fractional vout
  assert.equal(w.addUtxo('aa'.repeat(32), 2 ** 32, 1000, spk), false); // vout past u32
  assert.equal(w.addUtxo('aa'.repeat(32), 0, -1000, spk), false);      // negative amount
  assert.equal(w.addUtxo('aa'.repeat(32), 0, 1000.5, spk), false);     // fractional amount
  assert.equal(w.addUtxo('aa'.repeat(32), 0, 2 ** 53, spk), false);    // unsafe-integer amount
  assert.equal(w.getUtxos().length, 0);
  // A valid UTXO is still accepted and the state round-trips.
  assert.equal(w.addUtxo('aa'.repeat(32), 0, 1000, spk), true);
  assert.doesNotThrow(() => TransparentWallet.load(seed, w.save()));
});

// C5: re-scanning an already-scanned block must not push a duplicate window
// entry that load() then rejects (save/load self-brick).
test('scanning the same block twice still saves and loads', () => {
  const seed = new Uint8Array(32).fill(34);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const block = { height: 100, hash: 'aa'.repeat(32), tx: [] };
  w.scanBlock(block);
  w.scanBlock(block); // e.g. a replay after a crash-restore
  assert.equal(w.lastScannedBlock(), 100);
  const json = w.save();
  let restored;
  assert.doesNotThrow(() => { restored = TransparentWallet.load(seed, json); }, 'state after a re-scan must load');
  assert.equal(restored.save(), json);
});

// C6: a buildSend reservation must survive resetScan — after the re-scan
// re-credits the outpoint, a second send must not double-select the inputs
// of the still-in-flight first send.
test('a buildSend reservation survives resetScan', () => {
  const seed = new Uint8Array(32).fill(35);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spkHex = toHex(scriptPubKeyForAddress(a0.address));
  const block = {
    height: 100,
    hash: 'aa'.repeat(32),
    tx: [{
      txid: 'e1'.repeat(32),
      vin: [{ txid: 'f1'.repeat(32), vout: 0 }],
      vout: [{ n: 0, value: 2.0, scriptPubKey: { hex: spkHex } }],
    }],
  };
  w.scanBlock(block);
  const { spent } = w.buildSend(a0.address, 100_000_000, 100); // reserves e1:0
  w.resetScan(99); // reorg walk-back: drops the UTXO, keeps the reservation
  w.scanBlock(block); // re-scan re-credits e1:0
  // Still reserved: the only UTXO must not be selectable again.
  assert.throws(() => w.buildSend(a0.address, 100_000_000, 100), /insufficient/);
  // release (or a scan-observed spend / markSpent) frees it.
  w.release(spent);
  assert.doesNotThrow(() => w.buildSend(a0.address, 100_000_000, 100));
});

// C7: feerates below the node's relay floor (minRelayTxFee = 10000/kB =
// 10 sat/byte, PIVX validation.cpp) are rejected with the minimum named.
test('buildSend rejects a feePerByte below the 10 sat/byte relay floor', () => {
  const seed = new Uint8Array(32).fill(36);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  w.addUtxo('cc'.repeat(32), 0, 200_000_000, scriptPubKeyForAddress(a0.address));
  assert.throws(() => w.buildSend(a0.address, 100_000_000, 9), /minRelayTxFee/);
  assert.doesNotThrow(() => w.buildSend(a0.address, 100_000_000, 10));
});

// C8: resetScan can only rewind — a height above lastScanned would silently
// skip the blocks in between.
test('resetScan rejects a height above the last scanned block', () => {
  const seed = new Uint8Array(32).fill(37);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  w.scanBlock({ height: 100, hash: 'aa'.repeat(32), tx: [] });
  assert.throws(() => w.resetScan(150), /above the last scanned/);
  assert.equal(w.lastScannedBlock(), 100); // nothing mutated
  assert.doesNotThrow(() => w.resetScan(100)); // rewind-to-current is fine
});

// C9: hostile vout entries are SKIPPED, never mangled — non-integer indices
// and negative values must not be credited or brick a later load.
test('scanBlock skips non-integer vout indices and negative values (and still round-trips)', () => {
  const seed = new Uint8Array(32).fill(38);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spkHex = toHex(scriptPubKeyForAddress(a0.address));
  w.scanBlock({
    height: 10,
    tx: [{
      txid: 'ee'.repeat(32),
      vin: [{ txid: 'ff'.repeat(32), vout: 0 }],
      vout: [
        { n: 1.5, value: 1.0, scriptPubKey: { hex: spkHex } }, // fractional index
        { n: 0, value: -3.0, scriptPubKey: { hex: spkHex } },  // negative value
        { n: 2 ** 32, value: 1.0, scriptPubKey: { hex: spkHex } }, // index past u32
        { n: 2, value: 1.0, scriptPubKey: { hex: spkHex } },   // valid
      ],
    }],
  });
  assert.equal(w.getUtxos().length, 1); // only the valid vout credited
  assert.equal(w.balance(), 100_000_000);
  assert.doesNotThrow(() => TransparentWallet.load(seed, w.save()));
});

// C10: getUtxos must hand out copies — mutating a returned utxo (or its
// scriptPubKey bytes) must not corrupt wallet state.
test('getUtxos returns copies, not live internals', () => {
  const seed = new Uint8Array(32).fill(40);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  w.addUtxo('aa'.repeat(32), 0, 200_000_000, scriptPubKeyForAddress(a0.address));
  const [u] = w.getUtxos();
  u.amount = 1;
  u.scriptPubKey.fill(0xff);
  assert.equal(w.balance(), 200_000_000); // untouched
  const { hex } = w.buildSend(a0.address, 100_000_000, 100); // script not corrupted
  assert.match(hex, /^01000000/);
});

// C12: spendableBalance applies buildSend's maturity filter; balance
// deliberately does not.
test('spendableBalance excludes immature coinbase that balance counts', () => {
  const seed = new Uint8Array(32).fill(39);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spkHex = toHex(scriptPubKeyForAddress(a0.address));
  w.scanBlock({
    height: 100,
    tx: [{ txid: 'dd'.repeat(32), vin: [{ coinbase: '00' }], vout: [{ n: 0, value: 5.0, scriptPubKey: { hex: spkHex } }] }],
  });
  assert.equal(w.balance(), 500_000_000);    // counted...
  assert.equal(w.spendableBalance(), 0);     // ...but not yet spendable
  w.scanBlock({ height: 199, tx: [] });      // 100 confirmations: mature
  assert.equal(w.spendableBalance(), 500_000_000);
});

// W1: buildSend's loop-time size guard works on an ESTIMATE; a drifted
// estimator could still let an oversized tx through, and PIVX rejects any tx
// at or above MAX_STANDARD_TX_SIZE (sz >= 100000, src/policy/policy.cpp).
// The builder re-checks the ACTUAL serialized size — and buildSend reserves
// inputs only after the builder returns, so nothing is reserved for a doomed
// tx. 700 P2PKH inputs serialize past 100kB for ANY signature sizes (even
// minimal 145-byte inputs give ~101.5kB).
test('buildTransparentTx refuses a tx whose ACTUAL size reaches 100kB', () => {
  const seed = new Uint8Array(32).fill(33);
  const k = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spk = scriptPubKeyForAddress(k.address);
  const inputs = Array.from({ length: 700 }, (_, i) => ({
    txid: i.toString(16).padStart(64, '0'),
    vout: 0,
    amount: 150_000,
    scriptPubKey: spk,
    privateKey: k.privateKey,
  }));
  assert.throws(
    () => buildTransparentTx(inputs, [{ address: k.address, amount: 1_000_000 }], 0),
    /100kB standard size/,
  );
});

// W2: an invalid block height (NaN/negative/fractional/2^53/string/missing)
// must be a labeled error with state untouched — before the fix it poisoned
// lastScanned and bricked the next load() (JSON NaN serializes to null;
// negative/fractional/unsafe heights fail load's counter checks). Both SDKs
// bound heights to [0, 2^53-1] so a state loads in both or neither.
test('scanBlock rejects invalid heights before mutating state', () => {
  const seed = new Uint8Array(32).fill(34);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spkHex = toHex(scriptPubKeyForAddress(a0.address));
  w.scanBlock({
    height: 100,
    hash: 'aa'.repeat(32),
    tx: [{ txid: 'bb'.repeat(32), vin: [{ coinbase: '00' }], vout: [{ n: 0, value: 1.0, scriptPubKey: { hex: spkHex } }] }],
  });
  assert.equal(w.balance(), 100_000_000);
  const payTx = [{ txid: 'cc'.repeat(32), vin: [{ txid: 'dd'.repeat(32), vout: 0 }], vout: [{ n: 0, value: 2.0, scriptPubKey: { hex: spkHex } }] }];
  for (const height of [NaN, -1, 1.5, 2 ** 53, '101', undefined]) {
    assert.throws(
      () => w.scanBlock({ height, hash: 'ee'.repeat(32), tx: payTx }),
      /height/,
      `height ${String(height)}`,
    );
  }
  assert.equal(w.lastScannedBlock(), 100, 'scan position untouched');
  assert.equal(w.balance(), 100_000_000, 'nothing credited from rejected blocks');
  // The state still saves and loads (a poisoned height used to brick load()).
  const r = TransparentWallet.load(seed, w.save());
  assert.equal(r.lastScannedBlock(), 100);
});

// W2: resetScan(-1) used to drop every scanned UTXO and set a negative scan
// position that bricked the next load(); now it rejects before mutating.
test('resetScan rejects negative and non-integer heights before mutating', () => {
  const seed = new Uint8Array(32).fill(35);
  const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
  const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
  const spkHex = toHex(scriptPubKeyForAddress(a0.address));
  w.scanBlock({
    height: 100,
    hash: 'aa'.repeat(32),
    tx: [{ txid: 'bb'.repeat(32), vin: [{ txid: 'dd'.repeat(32), vout: 0 }], vout: [{ n: 0, value: 1.0, scriptPubKey: { hex: spkHex } }] }],
  });
  assert.equal(w.balance(), 100_000_000);
  for (const height of [-1, 1.5, NaN]) {
    assert.throws(() => w.resetScan(height), /height/, `height ${String(height)}`);
  }
  assert.equal(w.lastScannedBlock(), 100, 'scan position untouched');
  assert.equal(w.balance(), 100_000_000, 'scanned UTXOs kept');
  TransparentWallet.load(seed, w.save()); // state still loads
});

// W1: create rejects an account in the hardened range (which would alias a
// lower account and emit a state load() rejects).
test('W1: create rejects a hardened-range account', () => {
  assert.throws(() => TransparentWallet.create(new Uint8Array(32).fill(1), 'mainnet', 2 ** 31, 2), /account/);
  assert.doesNotThrow(() => TransparentWallet.create(new Uint8Array(32).fill(1), 'mainnet', 2 ** 31 - 1, 2));
});

// W-SEED: accept a 32-byte raw seed OR a 64-byte BIP39 seed; reject any other length.
test('W-SEED: create accepts a 32- or 64-byte seed, rejects others', () => {
  assert.doesNotThrow(() => TransparentWallet.create(new Uint8Array(32).fill(1), 'mainnet', 0, 2));
  assert.doesNotThrow(() => TransparentWallet.create(new Uint8Array(64).fill(1), 'mainnet', 0, 2));
  assert.throws(() => TransparentWallet.create(new Uint8Array(16).fill(1), 'mainnet', 0, 2), /seed must be/);
  assert.throws(() => TransparentWallet.create(new Uint8Array(33).fill(1), 'mainnet', 0, 2), /seed must be/);
});

// W2: load bounds persisted heights to [0, 2^53-1] (verify — JS was already
// bounded via isCount; the shield side gained the matching bound).
test('W2: load rejects out-of-range persisted heights', () => {
  const seed = new Uint8Array(32).fill(1);
  assert.doesNotThrow(() => TransparentWallet.load(seed, CROSS_SDK_STATE));
  assert.throws(
    () => TransparentWallet.load(seed, CROSS_SDK_STATE.replace('"lastScanned":7', '"lastScanned":9007199254740993')),
    /counter/i,
  );
  assert.throws(
    () => TransparentWallet.load(seed, CROSS_SDK_STATE.replace('"coinbase":true,"height":7', '"coinbase":true,"height":9007199254740993')),
    /malformed utxo/,
  );
});

// W4: an EXM output is 35 bytes (26-byte script), not the 34 a flat P2PKH
// assumes. At 10 sat/byte an EXM send must pay 10 sats more fee (10 sats less
// change) than a P2PKH send — before the fix both were counted at 34.
test('W4: EXM recipient is fee-sized at its true length; P2PKH unchanged', () => {
  // Change output is the last output: [8-byte value][0x19][25-byte script][4 locktime].
  const readChangeValue = (hex) => {
    const valHex = hex.slice(hex.length - 76, hex.length - 60);
    let v = 0n;
    for (let i = 0; i < 8; i++) v += BigInt(parseInt(valHex.slice(i * 2, i * 2 + 2), 16)) << BigInt(8 * i);
    return Number(v);
  };
  const changeAfter = (toExm) => {
    const seed = new Uint8Array(32).fill(5);
    const w = TransparentWallet.create(seed, 'mainnet', 0, 5);
    const a0 = deriveKey(seed, 'mainnet', 0, 0, 0);
    assert.equal(w.addUtxo('aa'.repeat(32), 0, 1_000_000_000, scriptPubKeyForAddress(a0.address)), true);
    const hash = hash160(deriveKey(new Uint8Array(32).fill(9), 'mainnet', 0, 0, 0).publicKey);
    const to = encodeAddress(hash, 'mainnet', toExm ? 'exchange' : 'p2pkh');
    const { hex } = w.buildSend(to, 100_000_000, 10);
    assert.equal(hex.slice(hex.length - 60, hex.length - 58), '19', 'change is a 25-byte P2PKH output');
    return readChangeValue(hex);
  };
  const changeExm = changeAfter(true);
  const changeP2pkh = changeAfter(false);
  assert.equal(changeP2pkh - changeExm, 10);
});
