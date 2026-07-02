# pivx-wallet

Standalone [PIVX](https://pivx.org) wallet SDK: the application owns the keys.
ZIP32 derivation, shielded (SHIELD/Sapling) block scanning with note
decryption, checkpointed sync verified against `finalsaplingroot`, and
locally-proved shielded transactions — plus a transparent (BIP44 HD, UTXO)
wallet. The node is only a chain-data source; point it at one you trust.
Amounts are integer satoshis.

## Install

```
npm install pivx-wallet pivx-rpc
```

Node >= 20.19. ESM only.

## Usage

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

A wallet is built from a seed, spending key, or viewing key — watch-only is a
capability level, upgradeable in place.

Full docs, security model, and examples: https://github.com/Liquid369/pivx-js-sdk
