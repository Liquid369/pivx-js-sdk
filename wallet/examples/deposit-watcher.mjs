// Exchange deposit flow: watch-only wallet from a viewing key detects
// incoming shielded payments; keys never touch this process.
// Usage: node deposit-watcher.mjs <extended-viewing-key> <birth-height>
import { PivxClient } from 'pivx-rpc';
import { PivxWallet } from 'pivx-wallet';

const [viewingKey, birthHeight] = [process.argv[2], Number(process.argv[3])];
const client = new PivxClient({
  user: process.env.PIVX_RPC_USER,
  pass: process.env.PIVX_RPC_PASS,
});

const wallet = await PivxWallet.create({ viewingKey, birthHeight });
console.log(`deposit address: ${wallet.getNewAddress()}`);

await wallet.sync(client, {
  onProgress: (h, tip) => console.log(`scanned ${h}/${tip}`),
});
console.log(`balance: ${wallet.getBalance() / 1e8} PIV`);

// poll for new blocks; credit deposits as notes arrive
setInterval(async () => {
  const before = new Set(wallet.getNotes().map((n) => n.nullifier));
  await wallet.sync(client);
  for (const n of wallet.getNotes()) {
    if (!before.has(n.nullifier)) {
      console.log(`deposit: ${n.note.value / 1e8} PIV${n.memo ? ` memo="${n.memo}"` : ''}`);
    }
  }
}, 15000);
