# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.3] - 2026-07-09

Transparent sends now use PIVX's Sapling-version (v3) sighash
(`SIGVERSION_SAPLING`), which commits the input amount in every signature.
The legacy (v1) sighash they used before omitted the amount, so a node that
under-reported a UTXO's value could make the wallet sign a send that spent more
than intended and burned the difference as miner fee. The v3 transaction is an
ordinary transparent tx with an empty Sapling data block; it was validated on
regtest and mainnet (single-input, multi-input, and exchange-address inputs all
accepted by a live node) and builds byte-identically in the JS and Rust SDKs.

### Changed

- `pivx-wallet`: transparent `buildSend` now produces nVersion=3 (Sapling)
  transactions signed with the amount-committing `SIGVERSION_SAPLING` sighash.
  The serialized tx gains a 75-byte empty Sapling-data trailer; the fee-size
  estimate was raised to match so the 100 kB standard-tx cap and the 10
  sat/byte relay floor stay conservative.

### Security

- Closes the transparent-sighash amount-omission gap (S1): the signature is now
  invalid if a node misreports an input value, so it can no longer trick the
  wallet into burning funds as fee. Only the transparent path was affected; the
  shielded path already committed values. See SECURITY.md.

## [0.7.2] - 2026-07-09

Security hardening from a full wallet security review (no Critical/High found;
the fundamentals — deterministic RFC6979/low-S signing, no spend authority in
persisted state — were verified sound, including a live-mainnet transaction).

### Fixed

- `pivx-rpc`: credentials embedded in the `host` option (e.g.
  `{ host: 'user:pass@node' }`) are now rejected at construction like the `url`
  option already was, so a password can no longer reach a thrown transport
  error.
- `pivx-wallet`: the extended spending key, the transparent key map, and the
  RPC auth header are now ES `#private` fields — `console.log`/`JSON.stringify`
  of a wallet or client no longer serialize the spending key (TypeScript
  `private` is only a compile-time guard). `TransparentWallet`'s WIF is now a
  lazy getter, so key derivation no longer materializes thousands of unused
  private-key strings.

### Security

- Examples read the spending key from an environment variable instead of argv
  (argv is exposed via shell history / process listing / CI logs).
- The shield crypto WASM (`pivx-shield-rust`) is pinned to an exact version
  rather than a compatible range.
- SECURITY.md documents the trusted-node transparent-sighash caveat (a
  malicious node can misreport an input amount; being addressed by v3
  amount-committing signatures), the absence of in-memory secret scrubbing,
  and WASM provenance.

## [0.7.1] - 2026-07-06

Patch from a post-publish audit: `pivx-rpc` 0.7.1, `pivx-wallet` 0.7.1.

### Fixed

- `pivx-rpc`: the JSON-RPC response `id` is now verified before the error
  branch on single calls, so a wrong-id reply — success or error — is
  rejected as a malformed response instead of being mis-attributed as this
  call's error (which, on a broadcast, could otherwise release a pending
  spend without the real `sendrawtransaction` response having arrived).
- `pivx-rpc`: `Unspent.address` is typed optional (the node omits it for
  non-standard scriptPubKeys, matching the Rust SDK's `#[serde(default)]`).
- `pivx-wallet`: the transparent wallet now throws the typed
  `WalletBusyError` / `InsufficientFundsError` (previously bare `Error`),
  matching the shield wallet; `accountIndex` outside `[0, 2^31-1]` is
  rejected before shield derivation (ZIP32 hardened boundary).

### Added

- `pivx-wallet`: typed `ProverNotLoadedError` and `InvalidKeyError` error
  classes (thrown for a missing prover, a bad seed length, and a key
  mismatch), aligning the JS error taxonomy with the Rust SDK's.

## [0.7.0] - 2026-07-06

Release of a full-repo audit cycle: `pivx-rpc` 0.7.0, `pivx-wallet` 0.7.0.

### Fixed

- `pivx-rpc`: `getMasternodeCount` now returns the node's real result object
  (`total`/`stable`/`enabled`/`inqueue`/`ipv4`/`ipv6`/`onion`) instead of a
  number, and throws a typed `RpcError` ("node has no chain tip yet") for the
  node's bare-string `"unknown"` reply. **Breaking** for callers that typed
  the old `number`.
- `pivx-rpc`: `ShieldTxView.fee` is typed as the money-formatted string the
  node actually emits, and spend/output `value` as `number | 'unknown'`;
  `valueSat` remains the reliable integer field. **Breaking** type change.
- `pivx-rpc`: optional middle parameters (`shieldSendMany`,
  `rawShieldSendMany`, `importSaplingKey`, `importSaplingViewingKey`,
  `protxList`) now substitute the node's defaults instead of serializing
  `null`, which pivxd rejects.
- `pivx-rpc`: hostile or malformed node responses (top-level `null`,
  primitives, arrays, batch elements) fail with labeled errors instead of
  crashing or silently returning `undefined`; JSON-RPC response ids are
  verified; whole-batch error objects surface the node's code and message;
  money-returning methods validate the result type at runtime.
- `pivx-rpc`: `ShieldWatcher` commits its state before emitting events, so a
  throwing listener can no longer cause duplicate `note`/`spent` events on
  the next poll; watchers no longer emit after `stop()`.
- `pivx-rpc`: `WatchOptions.includeWatchOnly` (default `true`) is now mirrored
  by the Rust SDK, which renamed its inverted `exclude_watch_only` flag to
  `include_watch_only` to match — both SDKs share one watch-only polarity. JS
  callers are unaffected (the field name is unchanged).
- `pivx-rpc`: ZMQ subscription iterators skip frames for unknown topics
  (tolerating prefix subscriptions) and close the socket on termination.
- `pivx-rpc`: sapling key imports that trigger a rescan use a 10-minute
  per-call timeout so the client no longer aborts an import the node
  completes; wallet names are URL-encoded; URLs carrying credentials are
  rejected with guidance to use the `user`/`pass` options.
- `pivx-wallet` transparent: transactions are capped below PIVX's 100 kB
  standard-size limit (checked on the estimate during selection and on the
  actual serialized bytes before any reservation); fee rates below the
  node's 10 sat/byte relay floor are rejected up front; coinstake detection
  now matches the node (zero value **and** empty script), so a zero-value
  `OP_RETURN`-first transaction paying the wallet is no longer wrongly
  maturity-gated.
- `pivx-wallet` transparent: everything the wallet persists it can load
  again — `addUtxo` and block scanning validate inputs with the same
  predicates `load()` enforces, re-scanning a block can no longer produce a
  scanned-hash window `load()` rejects, and scan/reset heights are validated
  (integer, non-negative, cross-SDK bounds) before any state changes.
- `pivx-wallet` transparent: UTXO reservations survive `resetScan`, so a
  reorg walk-back can no longer allow the same output to be selected twice
  while a broadcast is in flight; `resetScan` rejects heights above the last
  scanned block; `getUtxos()` returns copies rather than live internals.
- `pivx-wallet` shield: below Sapling activation, version-3 transactions are
  excluded from scanning (fabricated shielded data is never credited) without
  failing on consensus-legal data; `send()` keeps the pending spend when the
  node's reply means the transaction was accepted or the notes are contested
  (`already in block chain`, `bad-txns-nullifier-double-spent`,
  `bad-txns-shielded-requirements-not-met`), preventing double-pay retries;
  a failed transaction plan no longer advances the change-address index.
- `pivx-wallet`: `ScanDivergedError` guidance and the docs converge on
  `reloadFromCheckpoint()` as the recovery API, and recovery docs warn that
  pending spends are dropped (reconcile in-flight broadcasts first).
- `pivx-wallet`: typed spend-guard errors — a send whose funds cannot cover
  amount + fee throws `InsufficientFundsError` (message points at
  `subtractFeeFromAmount`), and a wallet call made while another mutation is
  in flight throws `WalletBusyError` rather than racing.
- `pivx-wallet`: the `createTransaction`/`send` option `sweep` is renamed to
  `subtractFeeFromAmount`; the `sweep` alias still works but is deprecated and
  will be removed in a future release.

### Added

- `pivx-wallet`: `spendableBalance()` — the balance the wallet can actually
  spend now (maturity- and reservation-aware), alongside `balance()`.
- `pivx-wallet` transparent: `buildTransparentTx` honors a non-zero locktime
  by setting non-final input sequences.
- Test suites covering batch rollback with credited notes, checkpoint
  walk-back adoption, crash-recovery reconciliation, reorg re-credit,
  send-error branches, memo round-trips (cross-SDK fixtures built by the
  Rust SDK and decrypted by the JS WASM), and hostile-input state handling.

## [0.6.2] - 2026-07-05

### Fixed

- `pivx-wallet`: the tip sapling-root check now runs at exact checkpoint
  heights, not only above them, so a same-height reorg landing on a bundled
  checkpoint is caught.
- `pivx-wallet`: the tip-root and batch-scan root checks are skipped below
  Sapling activation, where the node reports a zero root against the non-zero
  empty tree (matching the checkpoint validator). The SDK now uses the
  consensus V5 activation heights (mainnet 2700500, testnet 201) and fetches
  the tip root with `getblock` verbosity 1.
- `pivx-wallet` transparent wallet: `buildSend` is refused while a sync is in
  progress, so a spend cannot reserve a UTXO a concurrent reorg reset is
  about to drop.
- `pivx-wallet` transparent wallet: the scanned-hash window is validated on
  load (bounded, strictly ascending, no future heights), so malformed state
  cannot misdirect the reorg walk-back.

## [0.6.1] - 2026-07-04

### Fixed

- `pivx-wallet`: closed a double-spend race in `createTransaction` — the
  single-writer guard is now acquired before the spendable-note snapshot and
  any await, so two concurrent sends can no longer select the same notes.
- `pivx-wallet`: same-height chain reorgs are now detected. Each sync
  revalidates the last-scanned block hash; the transparent wallet walks a
  persisted hash window to the true fork and self-heals (re-scanning), or
  raises `ScanDivergedError` when the reorg is deeper than the window rather
  than silently retaining orphaned UTXOs. The shield wallet raises
  `ScanDivergedError` on a tip sapling-root mismatch (recover with
  `reloadFromCheckpoint`). Require confirmations before crediting.

## [0.6.0] - 2026-07-04

### Added

- `pivx-rpc`: ZMQ push notifications. `parseZmqFrame` is a pure, dependency-free
  decoder for pivxd's 3-part multipart message (topics `hashblock`, `hashtx`,
  `rawblock`, `rawtx`) — bring your own socket. `ZmqSubscriber` is a convenience
  over the `zeromq` package: `await ZmqSubscriber.connect(endpoint, topics)`
  yields typed events via async iteration. `zeromq` is NOT a runtime dependency
  — install it yourself (`npm install zeromq`); it is imported dynamically only
  when `connect()` runs, so pivx-rpc stays zero-runtime-deps and
  browser-importable. Typical use: trigger a wallet sync on each new block.

## [0.5.0] - 2026-07-03

### Added

- `pivx-rpc`: typed return values for 12 methods that previously returned raw
  JSON — `getNetworkInfo`, `getPeerInfo`, `getMempoolInfo`, `getRawMempool`
  (overloaded: `string[]`, or a typed entry map when verbose), `getSupplyInfo`,
  `getBlockIndexStats`, `getMiningInfo`, `estimateSmartFee`, `getBudgetInfo`,
  `getBudgetProjection`, `getStakingStatus`, `listStakingAddresses`. Each type
  keeps an open index signature so unmodeled node fields are preserved.

### Changed

- `pivx-rpc`: the three masternode methods (`getMasternodeStatus`,
  `masternodeCurrent`, `listMasternodes`) stay raw JSON on purpose — their
  shape is polymorphic (object, array, or a bare string) and cannot be typed
  safely.

### Notes

- `pivx-rpc` is at 0.4.0 (its own semver); `pivx-wallet` 0.3.2 tracks the rpc
  dependency bump. Return-type changes are breaking, hence the rpc minor bump.

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
