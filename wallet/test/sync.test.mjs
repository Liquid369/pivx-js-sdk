import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PivxClient } from 'pivx-rpc';
import { PivxWallet, ScanDivergedError } from '../dist/index.js';
import { EXTSK, TX_HEX } from './fixtures.mjs';

const BIRTH = 100;
const reverseHex = (hex) => hex.match(/../g).reverse().join('');

async function stubNode(handlers) {
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await new Promise((r) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => r(data));
    }));
    const result = handlers[body.method](...body.params);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: body.id, result, error: null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, close: () => server.close() };
}

// Learn the correct post-scan sapling root by scanning a reference wallet.
async function expectedRootAfterFixture() {
  const ref = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
  ref.handleBlocks([{ height: BIRTH + 1, txs: [{ hex: TX_HEX, txid: 'fixture' }] }]);
  const state = JSON.parse(ref.save());
  const { default: init, get_sapling_root } = await import('pivx-shield-rust');
  return reverseHex(get_sapling_root(state.commitmentTree));
}

const makeHandlers = (tipRoot) => ({
  getblockcount: () => BIRTH + 1,
  getblockhash: (h) => `hash${h}`,
  getblock: (hash) => ({
    height: Number(hash.slice(4)),
    finalsaplingroot: tipRoot,
    tx: hash === `hash${BIRTH + 1}` ? [{ hex: TX_HEX, txid: 'fixture' }] : [],
  }),
});

test('sync pulls blocks from RPC, finds the note, and verifies the sapling root', async () => {
  const goodRoot = await expectedRootAfterFixture();
  const node = await stubNode(makeHandlers(goodRoot));
  try {
    const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
    const client = new PivxClient({ port: node.port });
    const progress = [];
    await wallet.sync(client, { onProgress: (h, tip) => progress.push([h, tip]) });

    assert.equal(wallet.getBalance(), 1_000_000_000);
    assert.equal(wallet.getLastSyncedBlock(), BIRTH + 1);
    assert.deepEqual(progress, [[BIRTH + 1, BIRTH + 1]]);
  } finally {
    node.close();
  }
});

test('sync fails loudly when the node sapling root diverges', async () => {
  const node = await stubNode(makeHandlers('00'.repeat(32)));
  try {
    const wallet = await PivxWallet.create({ spendingKey: EXTSK, network: 'testnet', birthHeight: BIRTH });
    const client = new PivxClient({ port: node.port });
    await assert.rejects(wallet.sync(client), ScanDivergedError);
  } finally {
    node.close();
  }
});
