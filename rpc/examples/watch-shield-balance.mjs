// Watch a shielded address using only its viewing key (no spend key on this node).
// Usage: PIVX_RPC_USER=u PIVX_RPC_PASS=p node watch-shield-balance.mjs <sapling-viewing-key>
import { PivxClient, watchViewingKey } from 'pivx-rpc';

const client = new PivxClient({
  port: 51473, // testnet: 51475
  user: process.env.PIVX_RPC_USER,
  pass: process.env.PIVX_RPC_PASS,
});

const { address, watcher } = await watchViewingKey(client, process.argv[2], {
  pollIntervalMs: 15000,
});
console.log(`watching ${address}`);

// A sender controls the memo bytes, so strip C0/C1 control chars and DEL
// (ANSI escapes, etc.) before they reach the operator's console.
const cleanMemo = (m) =>
  [...String(m)].filter((ch) => {
    const c = ch.codePointAt(0);
    return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f));
  }).join('');

watcher.on('note', (n) => {
  const memo = n.memo ? ` memo=${cleanMemo(Buffer.from(n.memo, 'hex').toString('utf8'))}` : '';
  console.log(`+${n.amount} PIV in ${n.txid}:${n.outindex}${memo}`);
});
watcher.on('balance', (balance, previous) =>
  console.log(`shield balance: ${previous} -> ${balance} PIV`));
watcher.on('error', (err) => console.error('watch error:', err.message));
