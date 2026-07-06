// Exchange deposit flow: watch-only wallet from a viewing key detects
// incoming shielded payments; keys never touch this process.
// Usage: node deposit-watcher.mjs <extended-viewing-key> <birth-height>
import { PivxClient } from 'pivx-rpc';
import { PivxWallet, ScanDivergedError } from 'pivx-wallet';

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

// A sender controls the memo bytes, so strip C0/C1 control chars and DEL
// (ANSI escapes, etc.) before they reach the operator's console.
const cleanMemo = (m) =>
  [...String(m)].filter((ch) => {
    const c = ch.codePointAt(0);
    return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f));
  }).join('');

// One polling pass: sync, then credit any notes that appeared since.
async function poll() {
  const before = new Set(wallet.getNotes().map((n) => n.nullifier));
  await wallet.sync(client);
  for (const n of wallet.getNotes()) {
    if (!before.has(n.nullifier)) {
      const memo = n.memo ? ` memo="${cleanMemo(n.memo)}"` : '';
      console.log(`deposit: ${n.note.value / 1e8} PIV${memo}`);
    }
  }
}

// Poll for new blocks. Each pass awaits its sync before scheduling the next
// (no overlap — setInterval would fire into an in-flight sync), mirroring the
// Rust example's sequential loop, and recovers instead of crashing on error.
(async function loop() {
  try {
    await poll();
  } catch (err) {
    if (err instanceof ScanDivergedError) {
      // Local state diverged from the node (reorg past our data, or corruption):
      // reset to the checkpoint at/below the divergence; the next pass resyncs.
      console.error(`scan diverged at ${err.height}; reloading from checkpoint`);
      wallet.reloadFromCheckpoint(err.height);
    } else {
      // Transient RPC/network error: log and keep polling.
      console.error('sync error:', err.message);
    }
  }
  setTimeout(loop, 15000);
})();
