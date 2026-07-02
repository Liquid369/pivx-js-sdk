// Fully standalone shielded send: keys and proving live in this process;
// the node only supplies blocks and relays the final transaction.
// Usage: node send-standalone.mjs <extended-spending-key> <birth-height> <to-address> <piv-amount>
import { PivxClient } from 'pivx-rpc';
import { PivxWallet } from 'pivx-wallet';

const [spendingKey, birthHeight, to, piv] = process.argv.slice(2);
const client = new PivxClient({
  user: process.env.PIVX_RPC_USER,
  pass: process.env.PIVX_RPC_PASS,
});

const wallet = await PivxWallet.create({ spendingKey, birthHeight: Number(birthHeight) });
await wallet.sync(client);
console.log(`balance: ${wallet.getBalance() / 1e8} PIV`);

// ~50MB, downloaded once and cached by your infra ideally; or { path: dir }
await wallet.loadProver({ url: 'https://pivxla.bz' });

const txid = await wallet.send(client, {
  to,
  amount: Math.round(Number(piv) * 1e8),
  memo: 'standalone pivx-wallet send',
});
console.log(`sent: ${txid}`);
