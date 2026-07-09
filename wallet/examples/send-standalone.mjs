// Fully standalone shielded send: keys and proving live in this process;
// the node only supplies blocks and relays the final transaction.
// Usage: PIVX_SPENDING_KEY=<extended-spending-key> node send-standalone.mjs <birth-height> <to-address> <piv-amount>
//
// SECURITY: the spending key is read from the PIVX_SPENDING_KEY environment
// variable and must NEVER be passed on the command line — argv is exposed via
// shell history, `ps`, and CI logs. This example uses a plain env var for
// brevity; a real deployment should source the key from a secret manager and
// scope it to this process only.
//
// Note: proving on a single WASM thread (the default in Node) is slow. For
// server-side signing use the Rust SDK's native proving; in a browser enable
// multicore. See docs/deployment.md.
import { PivxClient } from 'pivx-rpc';
import { PivxWallet } from 'pivx-wallet';

const spendingKey = process.env.PIVX_SPENDING_KEY;
if (!spendingKey) throw new Error('set PIVX_SPENDING_KEY (never pass a spending key in argv)');
const [birthHeight, to, piv] = process.argv.slice(2);
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
