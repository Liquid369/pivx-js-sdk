# pivx-rpc

Typed JSON-RPC client for [PIVX](https://pivx.org) nodes (`pivxd`), zero
dependencies. Covers the blockchain, wallet, and full shield (SHIELD/Sapling)
RPC surface, plus masternode, staking, budget, and network methods, and a
poll-based `ShieldWatcher` for shielded balance/note events. Amounts are PIV
floats, exactly as the node emits them.

## Install

```
npm install pivx-rpc
```

Node >= 20.19. ESM only.

## Usage

```js
import { PivxClient, ShieldWatcher } from 'pivx-rpc';

// credentials go in the user/pass options (or PivxClient.fromCookie) —
// never embedded in a URL (http://user:pass@host is not supported)
const client = new PivxClient({ user: 'rpcuser', pass: 'rpcpass' });

const height = await client.getBlockCount();
const balance = await client.getShieldBalance(); // all shield funds, PIV

const watcher = new ShieldWatcher(client).start();
watcher.on('note', (n) => console.log('received', n.amount, 'PIV in', n.txid));
```

Anything not wrapped goes through `client.call(method, ...params)`.

Full docs, examples, and the companion standalone-wallet package
(`pivx-wallet`): https://github.com/Liquid369/pivx-js-sdk
