# Usage

Two packages. `pivx-rpc` talks to a pivxd node you trust with keys.
`pivx-wallet` holds keys itself and uses the node only as a chain-data
source. That node must be one you trust — the SDK does not validate
proof-of-stake or the header chain, so a malicious node can fabricate
deposits (see [Trust model](#trust-model) and `SECURITY.md`). Most
integrations want `pivx-wallet`; use `pivx-rpc` alone when the node's
built-in wallet already does what you need.

Node 18 or newer. Both packages are ESM.

```
npm install pivx-rpc pivx-wallet
```

## Trust model

The wallet does not validate proof-of-stake or the header chain. Its only
sync check — comparing the local commitment-tree root to the block's
`finalsaplingroot` — proves the tree matches *the node's own reported root*,
not that the chain is real. A malicious node can therefore fabricate a
deposit to a known address. Point the wallet at a node you control (or
corroborate across independent nodes), require confirmations before
crediting, and never credit from `previewTransaction`. Full detail and the
integrator checklist are in [`SECURITY.md`](../SECURITY.md).

## Units

`pivx-rpc` amounts are PIV as decimal numbers, exactly as pivxd emits them
(`5.12345678`). `pivx-wallet` amounts are integer satoshis (`512345678`),
the unit of the underlying cryptography. 1 PIV = 100_000_000 sats. Mixing
these up is the classic integration bug; check twice at the boundary
between the two layers.

## pivx-rpc

### Connecting

```js
import { PivxClient, RpcError } from 'pivx-rpc';

const client = new PivxClient({
  host: '127.0.0.1',   // default
  port: 51473,          // default; testnet is 51475
  user: 'rpcuser',
  pass: 'rpcpass',
  wallet: 'wallet.dat', // only for multiwallet nodes; routes to /wallet/<name>
  timeoutMs: 30000,     // default
});
```

Credentials come from `rpcuser`/`rpcpassword` in pivx.conf. The client
speaks HTTP Basic auth. There is no TLS: run the node on localhost or
tunnel the connection; do not expose the RPC port.

### Calling the node

Typed methods cover the blockchain, wallet, and shield surface:

```js
const height = await client.getBlockCount();
const balance = await client.getShieldBalance();          // all shield funds, PIV
const notes = await client.listShieldUnspent(1);           // unspent shield notes
const addr = await client.getNewShieldAddress();
```

Anything not covered goes through `call`, which takes the method name and
positional params exactly as `pivx-cli` would:

```js
const info = await client.call('getmasternodecount');
```

Node errors throw `RpcError` with the node's own `code` and message.
Transport failures (refused connection, timeout) throw plain errors, so
retry logic can tell them apart:

```js
try {
  await client.shieldSendMany('from_shield', [{ address, amount: 1.5 }]);
} catch (e) {
  if (e instanceof RpcError && e.code === -13) {
    // wallet locked: walletpassphrase first
  }
}
```

### Watching the node wallet

`ShieldWatcher` polls per block and diffs the node wallet's unspent shield
notes. With a viewing key imported, this monitors an address whose spending
key the node never sees:

```js
import { watchViewingKey } from 'pivx-rpc';

const { address, watcher } = await watchViewingKey(client, vkey, {
  rescan: 'whenkeyisnew',
  height: 4_800_000,        // limits the rescan
});
watcher.on('note', (n) => console.log(`+${n.amount} PIV in ${n.txid}`));
watcher.on('balance', (now, before) => console.log(`${before} -> ${now}`));
watcher.on('error', console.error);
```

Caveat, straight from the node: with only an incoming viewing key, spends
made elsewhere are invisible, so a watch-only balance can over-report.
Reconcile against note events rather than the balance number when the
spending key lives somewhere else.

### Sending from the node wallet

`shieldsendmany` proves and broadcasts in one call and returns the txid.
Expect it to take seconds; proving is expensive.

```js
const txid = await client.shieldSendMany('from_shield', [
  { address: 'ps1...', amount: 5.0, memo: 'invoice 42' },
]);
const view = await client.viewShieldTransaction(txid);  // decrypted amounts + memos
```

The from address can be a specific address or a selector:
`'from_shield'`, `'from_transparent'`, `'from_trans_cold'`.

## pivx-wallet

### Creating a wallet

A wallet is built from whichever key material you have. Capability follows
the key:

```js
import { PivxWallet } from 'pivx-wallet';

// full capability: 32 bytes of entropy, ZIP32 derivation (coin type 119)
const w1 = await PivxWallet.create({ seed, birthHeight: 4_800_000 });

// full capability: an exported extended spending key (p-secret-spending-key-...)
const w2 = await PivxWallet.create({ spendingKey, birthHeight: 4_800_000 });

// watch-only: scan, derive addresses, track balance; cannot spend
const w3 = await PivxWallet.create({ viewingKey, birthHeight: 4_800_000 });
```

`birthHeight` is the height the wallet's keys first existed. Scanning
starts at the nearest checkpoint at or below it; blocks before that are
never seen. For a new wallet, pass the current chain height. Setting it too
low costs sync time; too high loses funds received before it.

`network: 'testnet'` switches ports, key prefixes, and checkpoints.
`accountIndex` selects the ZIP32 account under a seed; default 0.

A watch-only wallet upgrades in place, and rejects a key that doesn't match
its viewing key:

```js
w3.loadSpendingKey(spendingKey);
```

Get a viewing key to hand to a watch-only host from the node
(`exportsaplingviewingkey`) or from a full wallet's saved state (the
`extfvk` field).

### Receive addresses

```js
const addr = wallet.getNewAddress();  // next diversified address, ps1...
```

Diversified addresses all decrypt with the same keys; hand out a fresh one
per deposit and match incoming notes by address or memo.

### Syncing

```js
import { PivxClient } from 'pivx-rpc';
const client = new PivxClient({ user, pass });

await wallet.sync(client, {
  batchSize: 100,                          // blocks per round trip batch
  onProgress: (h, tip) => console.log(`${h}/${tip}`),
});
```

`sync` walks from the last synced block to the node's tip, decrypts every
transaction, and verifies the local commitment tree against the block
header's `finalsaplingroot` after each batch. Call it again any time; it
picks up where it left off. A first sync from an old birth height fetches
every block since, so budget minutes, not milliseconds.

If you have your own block feed (ZMQ, an indexer), skip `sync` and push
blocks yourself; heights must be strictly ascending:

```js
wallet.handleBlocks([{ height, txs: [{ hex, txid }] }]);
```

If the tree check ever fails, `sync` throws `ScanDivergedError`. This means
a chain reorg crossed a batch boundary, the node lied, or the saved state
is corrupt. Recovery is mechanical: recreate the wallet from its keys with
the same birth height and sync again.

```js
import { ScanDivergedError } from 'pivx-wallet';

try {
  await wallet.sync(client);
} catch (e) {
  if (e instanceof ScanDivergedError) {
    wallet = await PivxWallet.create({ viewingKey, birthHeight });
    await wallet.sync(client);
  } else throw e;
}
```

Do not run two `sync` calls on one wallet concurrently, and do not build a
transaction while a sync is in flight. One wallet, one writer.

### Detecting deposits

Confirmed deposits are new entries in `getNotes()` after a sync. Track
nullifiers you've already credited:

```js
const seen = new Set(credited);
await wallet.sync(client);
for (const n of wallet.getNotes()) {
  if (seen.has(n.nullifier)) continue;
  credit(n.note.value, n.memo);      // sats; memo may carry your payment id
  seen.add(n.nullifier);
}
```

For unconfirmed detection, decrypt a mempool transaction without touching
wallet state:

```js
const outputs = wallet.previewTransaction(rawTxHex);
// [{ recipient, value, memo }] — outputs this wallet can decrypt
```

Treat previews as a hint. Credit balances only from synced, confirmed
notes, at whatever confirmation depth your risk model wants (PIVX targets
60-second blocks).

### Persistence

```js
const json = wallet.save();              // no spending key inside
// ... later, possibly on another host or in the Rust SDK
const restored = await PivxWallet.load(json);
restored.loadSpendingKey(spendingKey);   // only where spending happens
```

`save()` output contains the viewing key, sync position, commitment tree,
and notes. It cannot spend, but it can see: anyone holding it can decrypt
this wallet's transaction history. Store it with the same care as customer
data. Store the spending key separately, encrypted, ideally on fewer hosts.

Save after every sync. Two things are deliberately not persisted:

- Pending spends. If the process dies between `createTransaction` and
  `finalizeTransaction`, a restored wallet believes the notes are still
  spendable. A second send would double-spend notes already committed to an
  in-flight transaction, and the network will reject it. After a crash,
  wait until the in-flight txid confirms or is clearly gone, sync, then
  resume sending.
- The spending key, as above.

The state format is versioned JSON, identical across the JS and Rust SDKs.

### Sending

Spending needs the sapling proving parameters (~50MB, one-time):

```js
await wallet.loadProver({ path: '/var/lib/pivx-params' });   // sapling-*.params on disk
// or: { url: 'https://pivxla.bz' }  — SHA256-pinned download
// or: { spend, output }             — raw bytes you supply
```

Then:

```js
const txid = await wallet.send(client, {
  to: 'ps1...',
  amount: 150_000_000,          // sats
  memo: 'payout 991',           // shield recipients only, <= 512 bytes UTF-8
});
```

`send` builds and proves locally, broadcasts through the client, and
settles the pending state. To broadcast yourself:

```js
const tx = await wallet.createTransaction({ to, amount, memo });
try {
  await client.sendRawTransaction(tx.hex);
  wallet.finalizeTransaction(tx.txid);
} catch (e) {
  wallet.discardTransaction(tx.txid);   // notes become spendable again
  throw e;
}
```

Fee behavior to know before wiring withdrawals: the fee is size-based
(1000 sats/byte over a fixed model; a typical 1-in-2-out shield spend pays
about 0.024 PIV). When the wallet's funds cover the amount but not
amount + fee, the fee is deducted from the recipient's amount rather than
failing. For exact payouts, keep a fee margin above the requested amount
and treat balance-emptying sends as "sweep" semantics.

Notes selected into a transaction are excluded from `getBalance()` until
you finalize or discard. Change returns to a fresh address of this wallet
and appears as a new note once the transaction confirms and is scanned.

Shielding transparent funds — spending UTXOs into a shield address — passes
transparent inputs explicitly:

```js
await wallet.createTransaction({
  to: 'ps1...',
  amount,
  inputs: [{ txid, vout, amount, private_key, script }],
  transparentChangeAddress: 'D...',
});
```

Proving in Node runs single-threaded WASM: tens of seconds per
transaction. If send latency matters, do it on the Rust SDK, which proves
natively.

### Browsers

The same package runs in bundlers; the WASM loads through the bundler's
asset pipeline instead of the filesystem. `loadProver({ path })` is
Node-only; use `{ url }` or bytes in a browser. For a full browser wallet
UX (multicore proving, workers) look at PIVX Labs' `pivx-shield`, which
this SDK shares its engine with.

### Testing your integration

Unit-test against fixtures the way this repo's own tests do
(`wallet/test/`). For end-to-end validation run a regtest node, mine past
the sapling activation height, and drive real deposits and sends; nothing
else exercises consensus acceptance of locally-built transactions.
