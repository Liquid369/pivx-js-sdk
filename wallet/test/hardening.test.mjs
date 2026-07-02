import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PivxWallet } from '../dist/index.js';
import { EXTSK, TX_HEX } from './fixtures.mjs';

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

test('reloadFromCheckpoint resets scan state', async () => {
  const w = await newWallet();
  w.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  assert.equal(w.getNotes().length, 1);

  w.reloadFromCheckpoint(BIRTH);
  assert.equal(w.getNotes().length, 0);
  assert.equal(w.getBalance(), 0);
});
