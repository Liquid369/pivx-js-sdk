# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-07-03

### Added

- `pivx-rpc`: batch JSON-RPC — `client.batch([{ method, params }, ...])` runs
  several calls in one HTTP round-trip, returning `{ result }` | `{ error }`
  per call in request order; a per-call error does not fail the batch.
- `pivx-rpc`: typed methods for the exchange deposit/withdrawal workflow —
  `listSinceBlock` (reorg-safe deposit cursor), `listTransactions`, `sendMany`,
  `getNewExchangeAddress`, `abandonTransaction`, `getTxOut`, `getBlockHeader`,
  `getChainTips`, `createRawTransaction`, `decodeRawTransaction`,
  `signRawTransaction`, and a verbose `getRawTransaction` (typed decoded object
  with confirmations — works for a non-wallet txid with `-txindex`).

### Changed

- `pivx-rpc`: `getTransaction` and `validateAddress` now return typed objects
  instead of `Record<string, unknown>` (breaking, hence `pivx-rpc` 0.3.0).

## [0.3.0] - 2026-07-03

### Added

- `pivx-wallet`: `pruneNullifiers()` — opt-in, drops nullifier-attribution
  entries for notes that are neither tracked-unspent nor pending; call after
  reconciling. Bounds state growth under a dust flood (sub-dust notes, ≤ 384000
  sats, are also skipped in attribution and purged from tracked state).
- `pivx-wallet`: `signal?: AbortSignal` on `PivxWallet.sync` and
  `TransparentWallet.sync` — aborting throws at a batch boundary with state left
  consistent and the busy guard released.
- `pivx-rpc`: `PivxClient.fromCookie(path)` — cookie-file auth; on HTTP 401 the
  cookie is re-read and the request retried once if the credentials rotated
  (node restart). A 403 is not retried.
- `pivx-rpc`: `AuthError` (HTTP 401/403) as a distinct, matchable error.

### Changed

- `pivx-rpc`: `ShieldWatcher` balance-change detection compares integer
  satoshis (round-then-sum), so floating-point note amounts cannot fire a
  spurious balance event.

## [0.2.0] - 2026-07-02

### Added

- `pivx-wallet` transparent wallet: `save()`/`load(seed, state)` — versioned
  JSON state (cursors, UTXO set, reservations, scan position), byte-identical
  across the JS and Rust SDKs; no key material in the file, and load rejects
  a state that does not belong to the seed or pairs a script with the wrong
  key hash.
- `pivx-wallet` transparent wallet: exchange-address receiving — deposits
  paying the wallet through the 26-byte `OP_EXCHANGEADDR` script are
  recognized, and `newExchangeAddress()` hands out the next external key
  EXM-encoded (mainnet-verified end to end).
- `pivx-wallet` transparent wallet: reorg detection — `scanBlock` checks
  parent-hash continuity and throws `ScanDivergedError` before mutating
  state; `resetScan(height)` recovers. `sync` rejects blocks missing
  `hash`/`previousblockhash`.
- `pivx-wallet` transparent wallet: UTXO reservation — `buildSend` reserves
  its inputs until `markSpent` or `release`; `balance()` excludes reserved
  outpoints; `sync` gains a busy guard.

### Changed

- **Breaking**: `scanBlock` can now throw `ScanDivergedError`
  (JS) / `scan_block` returns `Result` (Rust).
- `ScanDivergedError` message generalized (no longer sapling-specific).

## [0.1.0] - 2026-07-02

### Added

- `pivx-rpc`: typed JSON-RPC client for `pivxd` — 48 typed methods across
  blockchain, wallet, shield, masternode, staking, budget, network, mempool,
  mining, and util surfaces, plus a generic `call` for everything else.
- `pivx-rpc`: node errors (`RpcError` with the node's code) separated from
  transport failures; poll-based `ShieldWatcher` for node-wallet monitoring.
- `pivx-wallet`: standalone shield (SHIELD/Sapling) wallet — ZIP32 key
  derivation, block scanning with note decryption, checkpointed sync
  verified against `finalsaplingroot`, locally-proved shielded spends.
- `pivx-wallet`: watch-only wallets from a viewing key (scan, receive,
  balance), upgradeable in place with a spending key.
- `pivx-wallet`: `save()`/`load()` of versioned JSON wallet state, pending
  spends included; the format is interchangeable with the Rust SDK.
- `pivx-wallet`: transparent HD wallet — BIP44 derivation (coin type 119),
  block-scan or supplied-UTXO receive, ECDSA-signed legacy sends, exchange
  (`EXM`/`EXT`) address support.
