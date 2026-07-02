# PIVX JS SDK

JavaScript SDK for the [PIVX](https://pivx.org) blockchain with first-class
shielded (SHIELD/Sapling) support. Node ≥ 18 and browsers.

| Package | What it does |
|---|---|
| [`rpc/`](rpc/) — npm `pivx-rpc` | Typed JSON-RPC client for `pivxd` (zero dependencies): blockchain, wallet, full shield RPC surface, plus masternode, staking, budget, and network dev-kit methods; poll-based `ShieldWatcher`. |
| [`wallet/`](wallet/) — npm `pivx-wallet` | **Standalone wallet: the application owns the keys.** ZIP32 derivation, block scanning with note decryption (via `pivx-shield-rust` WASM, no Web Worker), checkpointed sync verified against `finalsaplingroot`, locally-proved shielded transactions. Also a transparent (BIP44 HD, UTXO) wallet for non-shielded funds — block-scan or supplied-UTXO receive, ECDSA-signed legacy sends, exchange-address support. The node is only a chain-data source. |

A wallet is constructed from a seed, spending key, **or viewing key** —
watch-only is a capability level (scan/receive/balance, no spend),
upgradeable in place. Wallet state JSON is interchangeable with the
[Rust SDK](https://github.com/PIVX-Project/pivx-rust-sdk).

```js
import { PivxClient } from 'pivx-rpc';
import { PivxWallet } from 'pivx-wallet';

// exchange deposit detection: keys never on this host
const wallet = await PivxWallet.create({ viewingKey, birthHeight: 4_800_000 });
await wallet.sync(new PivxClient({ user, pass }));
console.log(wallet.getBalance()); // sats

// standalone send (with a spending key + prover loaded)
const txid = await wallet.send(client, { to: 'ps1…', amount: 150_000_000, memo: 'hi' });
```

Examples: [`wallet/examples/`](wallet/examples/) (deposit watcher,
standalone send), [`rpc/examples/`](rpc/examples/) (node-wallet flows).

Full usage guide: [docs/usage.md](docs/usage.md).
Feature list: [docs/FEATURES.md](docs/FEATURES.md). Deployment + safety: [docs/deployment.md](docs/deployment.md), [SECURITY.md](SECURITY.md).

## Develop

```
npm install
npm test -ws
```

Tests decrypt a real regtest transaction through the actual WASM — no crypto
mocks. Units: `pivx-rpc` uses PIV floats (as the node emits); `pivx-wallet`
uses integer satoshis.
