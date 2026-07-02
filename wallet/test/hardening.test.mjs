import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PivxWallet } from '../dist/index.js';
import { EXTSK, TX_HEX, SHIELD_ADDRESS } from './fixtures.mjs';

const BIRTH = 100;
const newWallet = () =>
  PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });

test('pendingSpends survive save/load so notes are not resurrected', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  assert.equal(w.getBalance(), 1_000_000_000);

  // simulate a pending spend of the note, then persist mid-flight
  const nullifier = w.getNotes()[0].nullifier;
  w['pendingSpends'].set('inflight-tx', [nullifier]);
  assert.equal(w.getBalance(), 0, 'pending note excluded from balance');

  const restored = await PivxWallet.load(w.save());
  assert.equal(restored.getBalance(), 0, 'restored wallet still treats note as pending');
});

test('load rejects malformed state instead of corrupting the money path', async () => {
  await assert.rejects(PivxWallet.load('not json'), /valid JSON/);
  await assert.rejects(PivxWallet.load('{"version":2}'), /version/);
  const w = await newWallet();
  const bad = JSON.parse(w.save());
  bad.notes = [{ nullifier: 'x', note: { value: 'lots' } }];
  await assert.rejects(PivxWallet.load(JSON.stringify(bad)), /malformed note/);
});

test('createTransaction validates amount', async () => {
  const w = await newWallet();
  await assert.rejects(w.createTransaction({ to: 'ps1x', amount: -1 }), /positive integer/);
  await assert.rejects(w.createTransaction({ to: 'ps1x', amount: 1.5 }), /positive integer/);
  await assert.rejects(w.createTransaction({ to: 'ps1x', amount: 2 ** 53 }), /positive integer/);
});

test('createTransaction refuses a send the balance cannot cover with fee, unless sweep', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  assert.equal(w.getBalance(), 1_000_000_000); // 10 PIV note

  // More than the balance: rejected before the prover is even needed.
  await assert.rejects(
    w.createTransaction({ to: SHIELD_ADDRESS, amount: 2_000_000_000 }),
    /insufficient spendable balance/,
  );
  // sweep bypasses the guard and proceeds to the (unloaded) prover.
  await assert.rejects(
    w.createTransaction({ to: SHIELD_ADDRESS, amount: 2_000_000_000, sweep: true }),
    /prover not loaded/,
  );
  // A covered amount passes the guard and reaches the prover check.
  await assert.rejects(
    w.createTransaction({ to: SHIELD_ADDRESS, amount: 500_000_000 }),
    /prover not loaded/,
  );
});

test('createTransaction rejects a non-integer transparent input amount', async () => {
  const w = await newWallet();
  await assert.rejects(
    w.createTransaction({
      to: SHIELD_ADDRESS,
      amount: 100_000,
      inputs: [{ txid: 'ab', vout: 0, amount: 1.5, private_key: new Uint8Array(32), script: new Uint8Array(1) }],
      transparentChangeAddress: 'yTdummy',
    }),
    /non-negative integer/,
  );
});

test('load rejects a tampered viewing key or diversifier index', async () => {
  const good = JSON.parse((await newWallet()).save());
  const badDiv = { ...good, diversifierIndex: [1, 2, 3] };
  await assert.rejects(PivxWallet.load(JSON.stringify(badDiv)), /diversifier/);
  const badKey = { ...good, extfvk: 'ptestsapling-not-a-real-key' };
  await assert.rejects(PivxWallet.load(JSON.stringify(badKey)), /viewing key/);
});

test('reloadFromCheckpoint resets scan state', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  assert.equal(w.getNotes().length, 1);

  w.reloadFromCheckpoint(BIRTH);
  assert.equal(w.getNotes().length, 0);
  assert.equal(w.getBalance(), 0);
});
