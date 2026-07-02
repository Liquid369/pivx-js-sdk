// Send a shielded transaction with a memo from the node wallet's shield funds.
// Usage: PIVX_RPC_USER=u PIVX_RPC_PASS=p node send-shielded.mjs <shield-addr> <amount>
import { PivxClient } from 'pivx-rpc';

const [address, amount] = [process.argv[2], Number(process.argv[3])];
const client = new PivxClient({
  user: process.env.PIVX_RPC_USER,
  pass: process.env.PIVX_RPC_PASS,
});

// PIVX proves + broadcasts synchronously; this resolves with the txid.
const txid = await client.shieldSendMany('from_shield', [
  { address, amount, memo: 'paid with pivx-rpc' },
]);
console.log(`sent: ${txid}`);

// Decrypted view of what we just sent (amounts + memos).
const view = await client.viewShieldTransaction(txid);
console.log(`fee ${view.fee} PIV, outputs:`, view.outputs.map((o) => ({
  address: o.address,
  value: o.value,
  memo: o.memoStr,
})));
