# Usage

Two packages. `pivx-rpc` talks to a pivxd node you trust with keys.
`pivx-wallet` holds keys itself and uses the node only as a chain-data
source. That node must be one you trust — the SDK does not validate
proof-of-stake or the header chain, so a malicious node can fabricate
deposits (see [Trust model](#trust-model) and `SECURITY.md`). Most
integrations want `pivx-wallet`; use `pivx-rpc` alone when the node's
built-in wallet already does what you need.

Node 20.19 or newer. Both packages are ESM.

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

Or read credentials from the node's `.cookie` file instead of hardcoding
them (Node-only; the file is read via a dynamic `node:fs` import):

```js
const client = await PivxClient.fromCookie('/home/pivx/.pivx/.cookie');
```

pivxd rewrites the cookie on every restart. On an HTTP 401 the client
re-reads the file and retries the request once if the credentials changed,
so a node restart doesn't require reconstructing the client. A 403 (an
IP/ACL denial a cookie can't fix) is not retried and throws `AuthError`.

### Calling the node

Typed methods cover the blockchain, wallet, shield, masternode, staking,
budget, and network surface:

```js
const height = await client.getBlockCount();
const balance = await client.getShieldBalance();          // all shield funds, PIV
const mnCount = await client.getMasternodeCount();         // masternode count
const fee = await client.estimateSmartFee(6);              // smart fee estimate
const addr = await client.getNewShieldAddress();
```

v0.4 widened the typed surface across blockchain introspection, raw
transactions, and exchange-grade wallet calls:

```js
const header = await client.getBlockHeader(await client.getBestBlockHash());
const utxo = await client.getTxOut(txid, 0);       // null once the output is spent

// Verbose getRawTransaction decodes ANY txid — not just wallet ones — and
// carries confirmations. Needs -txindex, or pass a blockhash to look in one block:
//   getRawTransaction(txid, true, blockhash)
const tx = await client.getRawTransaction(txid, true);
console.log(tx.confirmations);

// Reorg-safe deposit cursor for exchanges: page new wallet txs from the last
// block you processed; the returned lastblock is your next cursor.
const { transactions, lastblock } = await client.listSinceBlock(lastProcessed);

// Batch payout to many recipients in one transaction.
const payoutTxid = await client.sendMany({ 'D1...': 1.5, 'D2...': 2.0 });

// Build → sign → broadcast a raw transaction (the node's RPC is
// signrawtransaction, 4 params).
const rawHex = await client.createRawTransaction([{ txid, vout: 0 }], { 'D...': 1.0 });
const signed = await client.signRawTransaction(rawHex);
if (signed.complete) await client.sendRawTransaction(signed.hex);
```

`gettransaction` and `validateaddress` are typed too, now returning
structured results (`TransactionInfo`, `ValidateAddress`) rather than opaque
objects.

v0.5 typed the node-status surface — network, mempool, mining, util, budget,
and staking — so those return structured objects as well:

```js
const fee = await client.estimateSmartFee(6);
console.log(fee.feerate);                 // PIV/kB; -1 when the node has no estimate

const staking = await client.getStakingStatus();
if (staking.staking_status) console.log('actively staking');

// getRawMempool is overloaded on the verbose flag:
const txids = await client.getRawMempool();        // string[]
const entries = await client.getRawMempool(true);  // Record<txid, MempoolEntry>
for (const [txid, e] of Object.entries(entries)) console.log(txid, e.fee);
```

Each typed status result also carries an index signature, so a field a newer
node adds is preserved rather than dropped. `getMasternodeStatus`,
`masternodeCurrent`, and `listMasternodes` stay raw JSON on purpose — their
shape is polymorphic.

Anything still not wrapped goes through `call`, which takes the method name
and positional params exactly as `pivx-cli` would:

```js
const decoded = await client.call('decodescript', scriptHex);
```

Node errors throw `RpcError` with the node's own `code` and message.
Transport failures (refused connection, timeout) throw plain errors, so
retry logic can tell them apart. An HTTP 401/403 that survives the cookie
refresh throws `AuthError` (with the `status`), a distinct type from a
rejected RPC — match it to surface a credentials problem rather than
retrying:

```js
try {
  await client.shieldSendMany('from_shield', [{ address, amount: 1.5 }]);
} catch (e) {
  if (e instanceof RpcError && e.code === -13) {
    // wallet locked: walletpassphrase first
  }
}
```

### Batch calls

`batch` sends several calls in one HTTP round-trip. Results come back in
request order; a per-call error is reported in place (as `{ error }`) and
does not fail the others — only a transport/auth failure rejects the whole
promise. Handy for fanning out a set of lookups, e.g. several block hashes or
txids at once:

```js
const results = await client.batch([
  { method: 'getblockhash', params: [100] },
  { method: 'getblockhash', params: [200] },
  { method: 'gettxout', params: [txid, 0] },
]);
for (const r of results) {
  if ('error' in r) console.error(r.error.code, r.error.message);
  else console.log(r.result);
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

### ZMQ push notifications

v0.6 adds ZMQ push notifications: pivxd can push a notification on every new
block or transaction, so you can trigger a wallet `sync` the moment the chain
moves instead of polling `ShieldWatcher`. (v0.6.0 ships pivx-rpc 0.5.0.) Launch
the node with the matching endpoints, e.g.
`-zmqpubhashblock=tcp://127.0.0.1:28332 -zmqpubrawtx=tcp://127.0.0.1:28332`
(topics: `hashblock`, `hashtx`, `rawblock`, `rawtx`).

`ZmqSubscriber` owns a SUB socket and yields typed events; iterate it and
`sync` on each `hashblock`:

```js
import { ZmqSubscriber } from 'pivx-rpc';

const sub = await ZmqSubscriber.connect('tcp://127.0.0.1:28332', ['hashblock']);
for await (const ev of sub) {
  if (ev.topic === 'hashblock') await wallet.sync(client);
}
```

The subscriber needs the `zeromq` package (`npm install zeromq`); it is not a
runtime dependency of `pivx-rpc` and is imported dynamically only when
`connect()` runs, so the package stays zero-runtime-deps and browser-importable.
`hashblock`/`hashtx` events carry `ev.hash` (display-order hex); `rawblock`/`rawtx`
carry the raw bytes as `ev.block` / `ev.tx`; every event carries a little-endian
`ev.sequence`.

If you already have a socket, skip the subscriber and decode frames yourself
with the pure, dependency-free `parseZmqFrame(frames)` — it takes the 3-part
`[topic, body, sequence]` multipart message and returns the same typed event.

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

A long first sync can be cancelled with an `AbortSignal`. Both
`PivxWallet.sync` and `TransparentWallet.sync` take one in their options and
check it at each batch boundary; aborting throws `signal.reason` (an
`AbortError` by default) with state left consistent — only fully applied,
root-verified batches are kept — and releases the busy guard, so a later
`sync` resumes where this one stopped:

```js
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 30_000);   // give up after 30s
try {
  await wallet.sync(client, { signal: ac.signal });
} catch (e) {
  if (e?.name !== 'AbortError') throw e;
  // partial progress is persisted; call sync again later to continue
} finally {
  clearTimeout(timer);
}
```

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
notes, and pending spends. It cannot spend, but it can see: anyone holding
it can decrypt this wallet's transaction history. Store it with the same
care as customer data. Store the spending key separately, encrypted,
ideally on fewer hosts.

Save after every sync and after every send. Pending spends are persisted:
notes committed to a broadcast-but-unconfirmed transaction survive
`save()`/`load()`, so a crash between broadcast and finalize cannot
resurrect them into a double-spend — provided the state you restore was
saved after the send. After a crash, wait for the in-flight txid to
confirm or clearly disappear, sync, then resume sending. The spending key
is never persisted, as above.

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
  // Discard only when the node definitively rejected the transaction.
  if (e instanceof RpcError) wallet.discardTransaction(tx.txid);
  throw e;
}
```

Discard only on `RpcError` (a definitive node rejection): a transport or
timeout failure is ambiguous — the node may have accepted the transaction —
so the notes must stay pending until the txid confirms or clearly
disappears, or a retry could double-spend them.

Fee behavior to know before wiring withdrawals: the fee is size-based
(1000 sats/byte over a fixed model; a typical 1-in-2-out shield spend pays
about 0.024 PIV). When the wallet's funds cover the amount but not
amount + fee, the send is rejected rather than silently underpaying the
recipient. To empty a wallet, opt in with `sweep: true`, which deducts the
fee from the recipient's amount instead. For exact payouts, keep fee
headroom above the requested amount.

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

## Transparent wallet

`pivx-wallet` also manages PIVX's transparent (non-shielded, UTXO) funds,
separately from the shield wallet. Transparent sends are plain ECDSA-signed
legacy transactions — no proving parameters. Amounts are integer satoshis,
same as the shield wallet.

### Addressing

```js
import { deriveKey, p2pkhAddress, decodeAddress, isValidAddress } from 'pivx-wallet';

// BIP44 m/44'/119'/account'/change/index — change 0 = receive, 1 = internal
const key = deriveKey(seed, 'mainnet', 0, 0, 0);
key.address;                    // 'D...'  (also key.publicKey, key.privateKey, key.wif)

isValidAddress(key.address);    // true
const { hash, kind, network } = decodeAddress(key.address);
// kind: 'p2pkh' | 'p2sh' | 'staking' | 'exchange'
```

### Creating and receiving

PIVX has no address index, so a transparent wallet learns about incoming
coins two ways — scan the chain, or hand it UTXOs you already know about.

```js
import { TransparentWallet } from 'pivx-wallet';
import { PivxClient } from 'pivx-rpc';

const wallet = TransparentWallet.create(seed, 'mainnet', 0, 100);  // account 0, gap 100
const addr = wallet.newAddress();     // fresh receive address per deposit

// (a) scan the chain
const client = new PivxClient({ user, pass });
await wallet.sync(client, { fromHeight: 4_800_000, batchSize: 100 });
// or feed one decoded block (getblock <hash> 2) from your own source:
wallet.scanBlock(block);

// (b) or register a UTXO yourself; returns false if it isn't ours
wallet.addUtxo(txid, vout, 200_000_000, scriptPubKeyBytes);

wallet.balance();   // sats — excludes outpoints reserved by buildSend
wallet.getUtxos();  // all tracked outputs, reserved ones included
```

Only one `sync` runs at a time; a concurrent call throws (the same busy
guard as the shield wallet).

`scanBlock` checks parent-hash continuity: when a block claims to extend
the last scanned one (height exactly one higher) but its
`previousblockhash` differs from the hash recorded, it throws
`ScanDivergedError` before mutating any state — the chain reorganized
under the wallet. This is a breaking change from 0.1, where `scanBlock`
never threw. Recover with `resetScan(height)`, which drops scanned UTXOs
above `height` along with their reservations (caller-supplied UTXOs are
kept) and re-sync from below the fork point:

```js
import { ScanDivergedError } from 'pivx-wallet';

try {
  await wallet.sync(client);
} catch (e) {
  if (!(e instanceof ScanDivergedError)) throw e;
  wallet.resetScan(e.height - 20);   // a height below the fork point
  await wallet.sync(client);
}
```

### Sending

```js
const { hex, spent } = wallet.buildSend('D...recipient', 150_000_000, 100);  // 100 sats/byte
try {
  await client.sendRawTransaction(hex);
  wallet.markSpent(spent);            // finalize: inputs dropped for good
} catch (e) {
  // Release only when the node definitively rejected the transaction.
  if (e instanceof RpcError) wallet.release(spent);
  throw e;
}
```

`buildSend` selects coins largest-first, signs locally (ECDSA), sizes the
fee from `feePerByte` (default 100), and sends change to a fresh internal
address. It throws if funds can't cover amount + fee rather than
underpaying. The inputs it selects are reserved: a second `buildSend`
cannot double-spend them before broadcast, and `balance()` excludes them
(`getUtxos()` still lists them). `markSpent(spent)` finalizes after a
successful broadcast; `release(spent)` un-reserves after a definitive node
rejection (`RpcError`). A transport or timeout failure is ambiguous — the
node may have accepted the transaction — so keep the reservation until
the txid confirms or clearly disappears, the same rule as the shield
wallet's discard. This send path is verified against real mainnet
transactions.

### Persistence

`save()` returns versioned JSON (version 1) holding the address cursors,
the UTXO set (with coinbase heights), reservations (pending spends), and
the last-scanned height and block hash — no key material.
`load(seed, state)` re-derives the keys from the seed and rejects a state
that does not match it. The output is byte-identical across the JS and
Rust SDKs — a state saved by one loads in the other (the test suites
byte-compare a shared fixture).

```js
const json = wallet.save();
// ... crash, restart, maybe another host or the Rust SDK
const restored = TransparentWallet.load(seed, json);
```

Reservations survive save/load, so a crash between broadcast and
`markSpent` cannot resurrect the inputs into a double-spend — provided the
state was saved after the send. Save after every sync and every send.

### Exchange addresses

Exchange addresses (`EXM` mainnet, `EXT` testnet) encode the same hash160
as a P2PKH address behind an `OP_EXCHANGEADDR` (`0xe0`) prefix on an
otherwise standard P2PKH script. The wallet both sends to them and
receives on them.

Sending — validate and pay them like any address:

```js
isValidAddress('EXM...');             // true
decodeAddress('EXM...').kind;         // 'exchange'
const { hex, spent } = wallet.buildSend('EXM...', 150_000_000, 100);
```

Receiving — `newExchangeAddress()` hands out the next external index
encoded as an exchange address. It shares the cursor and key with
`newAddress()`: the same index's P2PKH form pays this wallet too, the two
encodings differ only in scriptPubKey. Deposits through the 26-byte
exchange script are credited by `scanBlock` and `addUtxo` exactly like
P2PKH, and the UTXOs spend like any other:

```js
const exm = wallet.newExchangeAddress();   // 'EXM...'
// after the deposit confirms and a sync/scan picks it up:
wallet.balance();                          // includes the exchange-script UTXO
```

This path is verified on mainnet: a deposit to an exchange address was
detected by a real block scan and the received output spent, accepted by
the network.

Sending to a cold-staking address is rejected.
