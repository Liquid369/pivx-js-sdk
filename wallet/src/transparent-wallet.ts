/**
 * Transparent wallet: HD address management, UTXO tracking (from a block scan
 * or caller-supplied), coin selection, and sending. Complements the shielded
 * PivxWallet; both derive from the seed.
 *
 * PIVX has no address index, so UTXOs are discovered either by scanning blocks
 * ({@link scan}) or supplied by the caller ({@link addUtxo}).
 *
 * Output recognition is deliberately narrow: only standard P2PKH outputs (and
 * the OP_EXCHANGEADDR-prefixed EXM encoding, which pays the same key) are
 * credited. P2PK outputs and cold-staking (P2CS) delegations paying our keys
 * are NOT detected — this wallet's transaction builder can only spend
 * P2PKH/EXM inputs, so crediting them would create unspendable balance.
 */
import type { PivxClient } from 'pivx-rpc';
import { decodeAddress, deriveKey, encodeAddress, hash160, type Network } from './transparent.js';
import { buildTransparentTx, scriptPubKeyForAddress, type TxInput } from './transparent-tx.js';
import { InsufficientFundsError, ScanDivergedError, WalletBusyError } from './wallet.js';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (s: string): Uint8Array => Uint8Array.from((s.match(/../g) ?? []).map((b) => parseInt(b, 16)));
const isHex = (s: string): boolean => /^(?:[0-9a-fA-F]{2})+$/.test(s);
const isTxid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v);

/**
 * PIVX dust threshold (sats) for an output whose scriptPubKey is `scriptLen`
 * bytes. Matches `GetDustThreshold` in src/policy/policy.cpp: the output plus
 * the 148-byte input to spend it, priced at dustRelayFee = 30000 sat/kB. For
 * our scripts (< 253 bytes) the length prefix is one byte, so the serialized
 * output is `8 + 1 + scriptLen`; a 25-byte P2PKH gives 5460.
 */
const dustThreshold = (scriptLen: number): number => Math.floor((30_000 * (8 + 1 + scriptLen + 148)) / 1000);

/** Coinbase/coinstake maturity in blocks (nCoinbaseMaturity): mainnet 100, testnet 15. */
const coinbaseMaturity = (network: Network): number => (network === 'mainnet' ? 100 : 15);

/**
 * Depth of the rolling (height, hash) window kept for reorg recovery. On a
 * detected same-height tip reorg, sync walks this window newest→oldest to find
 * the true fork and resets there; a reorg deeper than the window cannot be
 * located safely and fails loud instead of silently retaining orphaned UTXOs.
 * Identical in the Rust SDK.
 */
const REORG_WINDOW = 100;

/** A tracked unspent transparent output we can spend. */
export interface OwnedUtxo {
  txid: string;
  vout: number;
  amount: number;
  scriptPubKey: Uint8Array;
  keyHash: string; // hex hash160 of the controlling key
  coinbase: boolean; // coinbase/coinstake output — spend-gated by maturity
  height: number; // block height confirmed at (0 if caller-supplied)
}

export interface ScannedOutput {
  txid: string;
  vout: number;
  amount: number;
  scriptPubKey: Uint8Array;
}

export interface ScannedInput {
  txid: string;
  vout: number;
}

/**
 * hash160 of a scriptPubKey we know how to spend, if it is one: a standard
 * 25-byte P2PKH (76a914<20>88ac) or the 26-byte exchange form with an
 * OP_EXCHANGEADDR prefix (e076a914<20>88ac) — per Solver's TX_EXCHANGEADDR in
 * PIVX src/script/standard.cpp. Both encodings pay the same key.
 */
function ownedScriptHash(script: Uint8Array): string | undefined {
  if (
    script.length === 25 &&
    script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 &&
    script[23] === 0x88 && script[24] === 0xac
  ) {
    return hex(script.slice(3, 23));
  }
  if (
    script.length === 26 && script[0] === 0xe0 &&
    script[1] === 0x76 && script[2] === 0xa9 && script[3] === 0x14 &&
    script[24] === 0x88 && script[25] === 0xac
  ) {
    return hex(script.slice(4, 24));
  }
  return undefined;
}

export class TransparentWallet {
  #keys = new Map<string, Uint8Array>(); // hex hash160 → privkey
  private external: { hash: string; address: string }[] = [];
  private change: string[] = [];
  private nextExternal = 0;
  private nextChange = 0;
  private utxos = new Map<string, OwnedUtxo>(); // "txid:vout" → utxo
  private lastScanned = 0; // height of the last block passed to scanBlock
  private lastScannedHash: string | null = null; // hash of that block, for reorg detection
  private scannedHashes: { height: number; hash: string }[] = []; // rolling window of recent (height, hash) for the reorg walk-back
  private pending = new Set<string>(); // "txid:vout" reserved by buildSend until markSpent/release
  /** One sync at a time (mirrors the shield wallet's busy guard). */
  private busy = false;
  private account = 0;
  private gap = 0;

  private constructor(private readonly network: Network) {}

  /**
   * Derive `gap` external and `gap` change addresses from `seed` under
   * `account`. Only outputs to these addresses are recognized.
   */
  static create(seed: Uint8Array, network: Network, account = 0, gap = 100): TransparentWallet {
    // Accept a 32-byte raw seed OR a 64-byte BIP39 seed (MyPIVXWallet / BIP39
    // seed-phrase wallets). BIP32 transparent derivation uses the FULL seed, so
    // a 64-byte BIP39 seed reproduces MyPIVXWallet (MPW) / BIP39 seed-phrase wallet addresses.
    if (seed.length !== 32 && seed.length !== 64) {
      throw new Error('seed must be 32 bytes (raw) or 64 bytes (BIP39)');
    }
    const w = new TransparentWallet(network);
    w.account = account;
    w.gap = gap;
    for (let i = 0; i < gap; i++) {
      const ext = deriveKey(seed, network, account, 0, i);
      const eh = hex(hash160(ext.publicKey));
      w.external.push({ hash: eh, address: ext.address });
      w.#keys.set(eh, ext.privateKey);
      const ch = deriveKey(seed, network, account, 1, i);
      const chh = hex(hash160(ch.publicKey));
      w.change.push(chh);
      w.#keys.set(chh, ch.privateKey);
    }
    return w;
  }

  /** Next unused external receive address. */
  newAddress(): string {
    const e = this.external[this.nextExternal];
    if (!e) throw new Error('address gap limit reached; increase gap');
    this.nextExternal++;
    return e.address;
  }

  /**
   * Next unused external receive address, encoded as an exchange (EXM)
   * address. Shares the address cursor with {@link newAddress}: it hands out
   * the same underlying key as the next {@link newAddress} would, so the same
   * index's P2PKH encoding also pays this wallet — the two forms differ only
   * in their scriptPubKey encoding.
   */
  newExchangeAddress(): string {
    const e = this.external[this.nextExternal];
    if (!e) throw new Error('address gap limit reached; increase gap');
    this.nextExternal++;
    return encodeAddress(fromHex(e.hash), this.network, 'exchange');
  }

  private nextChangeHash(): string {
    const h = this.change[this.nextChange];
    if (!h) throw new Error('change gap limit reached; increase gap');
    this.nextChange++;
    return h;
  }

  /**
   * Add a caller-supplied UTXO if it pays one of our addresses. Returns true if
   * ours. Assumed a normal (non-coinbase) spendable output; use {@link scanBlock}
   * for chain data where coinbase maturity is tracked.
   *
   * Returns false (not ours / not accepted) for values {@link save}'s state
   * format cannot round-trip: a non-64-hex txid, a non-integer or out-of-u32
   * vout, or a negative or unsafe-integer amount. Accepting them would brick
   * a later {@link load}.
   */
  addUtxo(txid: string, vout: number, amount: number, scriptPubKey: Uint8Array): boolean {
    return this.insertUtxo(txid, vout, amount, scriptPubKey, false, 0);
  }

  private insertUtxo(
    txid: string,
    vout: number,
    amount: number,
    scriptPubKey: Uint8Array,
    coinbase: boolean,
    height: number,
  ): boolean {
    // Apply load()'s validation predicates at insertion: anything the state
    // format cannot round-trip is rejected here instead of bricking a later
    // load(). vout is additionally capped at u32 so the saved state also
    // loads in the Rust SDK.
    if (!isTxid(txid)) return false;
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) return false;
    if (!Number.isSafeInteger(amount) || amount < 0) return false;
    const h = ownedScriptHash(scriptPubKey);
    if (h && this.#keys.has(h)) {
      this.utxos.set(`${txid}:${vout}`, { txid, vout, amount, scriptPubKey, keyHash: h, coinbase, height });
      return true;
    }
    return false;
  }

  /** Apply a scanned block's transparent outputs (added if ours) and spent inputs (removed). */
  scan(outputs: ScannedOutput[], spent: ScannedInput[]): void {
    for (const o of outputs) this.addUtxo(o.txid, o.vout, o.amount, o.scriptPubKey);
    for (const s of spent) this.removeUtxo(`${s.txid}:${s.vout}`);
  }

  /** Drop a UTXO and any reservation on it (spent on-chain — nothing left to reserve). */
  private removeUtxo(key: string): void {
    this.utxos.delete(key);
    this.pending.delete(key);
  }

  /**
   * Scan one decoded block (`getblock <hash> 2`): credit every output that
   * pays us and remove every tracked UTXO the block spends. Coinbase vins (no
   * prevout `txid`) are skipped. Records the block's height and hash as last
   * scanned.
   *
   * Throws {@link ScanDivergedError} — before mutating any state — when the
   * block claims to extend the last scanned block (height + 1) but its
   * `previousblockhash` does not match the last scanned hash: the chain
   * reorganized under us. Recover with {@link resetScan} below the fork point
   * and re-sync. Also throws (state untouched) when `block.height` is not an
   * integer in [0, 2^53-1] — the bound both SDKs' state formats round-trip.
   */
  scanBlock(block: any): void {
    // A NaN/negative/fractional/oversized height would poison lastScanned and
    // brick the next load() (JSON NaN serializes to null; the counters fail
    // load's checks). Both SDKs bound heights to [0, 2^53-1] so a saved state
    // loads in both or neither. Reject before mutating anything.
    if (!Number.isSafeInteger(block?.height) || block.height < 0) {
      throw new Error(
        `scanBlock: block height must be an integer in [0, 2^53-1], got ${block?.height}`,
      );
    }
    if (
      this.lastScannedHash !== null &&
      block.height === this.lastScanned + 1 &&
      typeof block.previousblockhash === 'string' &&
      block.previousblockhash !== this.lastScannedHash
    ) {
      throw new ScanDivergedError(block.height, this.lastScannedHash, block.previousblockhash);
    }
    this.lastScanned = block.height;
    const height = this.lastScanned;
    for (const tx of block.tx ?? []) {
      if (typeof tx.txid !== 'string') continue;
      // Coinbase: first vin carries `coinbase` and no prevout. Coinstake (PoS):
      // a spending vin plus an EMPTY vout[0] — zero value AND empty script,
      // per CTxOut::IsEmpty (src/primitives/transaction.h). Checking value
      // alone would maturity-gate e.g. a zero-value OP_RETURN tx paying us.
      // Both are maturity-gated for spending (src/txmempool.cpp).
      const firstVin = tx.vin?.[0];
      const isCoinbase = firstVin?.coinbase !== undefined;
      const isCoinstake =
        firstVin?.txid !== undefined && tx.vout?.[0]?.value === 0 && tx.vout?.[0]?.scriptPubKey?.hex === '';
      const coinbase = isCoinbase || isCoinstake;
      for (const o of tx.vout ?? []) {
        const hexStr = o?.scriptPubKey?.hex;
        // Skip malformed vouts rather than poisoning balance with NaN or
        // throwing mid-sync: n must be an integer and value non-negative
        // (same skip semantics as the Rust scanner).
        if (!Number.isInteger(o?.n) || typeof o?.value !== 'number' || o.value < 0 || typeof hexStr !== 'string') continue;
        const script = Uint8Array.from((hexStr.match(/../g) ?? []).map((b: string) => parseInt(b, 16)));
        this.insertUtxo(tx.txid, o.n, Math.round(o.value * 1e8), script, coinbase, height);
      }
      for (const i of tx.vin ?? []) {
        if (i.txid !== undefined) this.removeUtxo(`${i.txid}:${i.vout}`);
      }
    }
    this.lastScannedHash = typeof block.hash === 'string' ? block.hash : null;
    // Record this block into the rolling reorg window (same usable-hash guard as
    // lastScannedHash), keeping only the last REORG_WINDOW entries. Re-scanning
    // an already-recorded height (e.g. replaying a block after a manual reset)
    // first drops stale entries at/above it — mirroring resetScan's trim — so
    // the window stays strictly ascending, which load() requires.
    if (typeof block.hash === 'string') {
      while (this.scannedHashes.length > 0 && this.scannedHashes[this.scannedHashes.length - 1].height >= height) {
        this.scannedHashes.pop();
      }
      this.scannedHashes.push({ height, hash: block.hash });
      if (this.scannedHashes.length > REORG_WINDOW) {
        this.scannedHashes.splice(0, this.scannedHashes.length - REORG_WINDOW);
      }
    }
  }

  /** Height of the last block passed to {@link scanBlock} (0 if none). */
  lastScannedBlock(): number {
    return this.lastScanned;
  }

  /**
   * Recovery path after {@link ScanDivergedError}: reset the scan position to
   * `height` (choose one below the fork point) and re-sync. Every scanned UTXO
   * above that height is dropped; caller-supplied UTXOs (tracked at height 0)
   * are kept. Reservations made by {@link buildSend} are PRESERVED: the
   * re-scan may re-credit the same outpoints, and releasing them here would
   * let a second send double-select inputs of a still-in-flight transaction.
   * A reservation to an outpoint that never comes back is inert; a scan that
   * observes the spend clears it, as do {@link markSpent} and {@link release}.
   *
   * Throws if `height` is above the last scanned block: resetScan can only
   * rewind — "resetting" forward would silently skip the blocks in between.
   */
  resetScan(height: number): void {
    // A negative or non-integer reset height would poison lastScanned (and
    // drop UTXOs) before bricking the next load(). Reject before mutating.
    if (!Number.isInteger(height) || height < 0) {
      throw new Error(`resetScan height must be a non-negative integer, got ${height}`);
    }
    if (height > this.lastScanned) {
      throw new Error(`resetScan height ${height} is above the last scanned block ${this.lastScanned}`);
    }
    for (const [k, u] of this.utxos) {
      if (u.height > height && u.height > 0) {
        this.utxos.delete(k);
      }
    }
    // Trim the reorg window to the retained span; if the reset height is itself a
    // known window entry (a true fork), restore its hash so scan continuity is
    // preserved — otherwise (a manual reset to an unknown height) leave it null.
    this.scannedHashes = this.scannedHashes.filter((e) => e.height <= height);
    const retained = this.scannedHashes.find((e) => e.height === height);
    this.lastScanned = height;
    this.lastScannedHash = retained ? retained.hash : null;
  }

  /**
   * Sync from the node into the wallet, from `max(fromHeight, lastScanned+1)`
   * up to the current tip, fetching each block with getBlockHash +
   * getBlock(hash, 2) and feeding it to {@link scanBlock}. Blocks are fetched
   * with bounded concurrency but scanned in ascending order. Only one sync may
   * run at a time; a concurrent call throws. A {@link ScanDivergedError} from
   * {@link scanBlock} (reorg) propagates to the caller.
   *
   * Like the shield wallet's sync this is a chain-data pull, not chain
   * authentication: point it at a node you trust. See SECURITY.md.
   */
  async sync(
    client: PivxClient,
    { fromHeight = 0, batchSize = 100, onProgress, signal }: {
      fromHeight?: number;
      batchSize?: number;
      onProgress?: (height: number, tip: number) => void;
      /**
       * Abort the sync. Checked at every batch and concurrency-chunk
       * boundary, before the next round of RPCs is issued; when set, sync
       * throws `signal.reason` (an `AbortError` DOMException by default).
       * Fully scanned blocks are kept and the busy guard is released, so a
       * follow-up sync resumes where this one stopped.
       */
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    if (this.busy) throw new WalletBusyError();
    this.busy = true;
    try {
      const throwIfAborted = () => {
        if (signal?.aborted) throw signal.reason ?? new DOMException('sync aborted', 'AbortError');
      };
      const concurrency = 8;
      const tip = await client.getBlockCount();
      // Stale-tip reorg detection: the forward scan only checks parent-hash
      // continuity for blocks above lastScanned, so a same-height reorg (block N
      // replaced while the tip stays N) leaves lastScanned == tip and is missed.
      // Any reorg at/below lastScanned changes that block's hash, so re-verify
      // the node's current hash for it. On a mismatch, walk the recorded window
      // newest→oldest to find the true fork (the highest stored height whose
      // hash the node still confirms) and reset there; the UTXO model self-heals
      // (resetScan drops UTXOs above the fork and the re-scan re-credits the
      // survivors). If the reorg is deeper than the window we cannot locate the
      // fork safely, so fail loud rather than silently retain orphaned UTXOs.
      // Honest chain = 1 getBlockHash (tip matches → skip the walk).
      if (this.lastScanned > 0 && this.lastScannedHash !== null) {
        const nodeTip = await client.getBlockHash(this.lastScanned);
        if (nodeTip !== this.lastScannedHash) {
          let fork: number | undefined;
          for (let i = this.scannedHashes.length - 1; i >= 0; i--) {
            const entry = this.scannedHashes[i];
            if ((await client.getBlockHash(entry.height)) === entry.hash) {
              fork = entry.height;
              break;
            }
          }
          if (fork !== undefined) {
            this.resetScan(fork);
          } else {
            throw new ScanDivergedError(this.lastScanned, this.lastScannedHash, nodeTip);
          }
        }
      }
      const fetchBlock = async (h: number) => client.getBlock(await client.getBlockHash(h), 2);
      // NaN/0/fractional → sane integer: 0 would loop forever and fractional
      // heights would skip blocks (matches Rust batch.max(1)).
      const batch = Math.max(1, Math.floor(batchSize) || 1);
      let from = Math.max(fromHeight, this.lastScanned + 1);
      while (from <= tip) {
        throwIfAborted(); // batch boundary: before issuing the next round of RPCs
        const to = Math.min(from + batch - 1, tip);
        const heights = Array.from({ length: to - from + 1 }, (_, i) => from + i);
        for (let i = 0; i < heights.length; i += concurrency) {
          throwIfAborted(); // chunk boundary: previous chunk fully scanned
          const blocks = await Promise.all(heights.slice(i, i + concurrency).map(fetchBlock));
          for (const b of blocks) {
            // getblock verbosity 2 always carries these; a block without them
            // would silently disable the reorg continuity check, so treat it
            // as a malformed node response rather than scanning past it.
            const block = b as any;
            if (typeof block?.hash !== 'string' || typeof block?.previousblockhash !== 'string') {
              throw new Error(`node returned a block without hash/previousblockhash at height ${block?.height}`);
            }
            this.scanBlock(block);
          }
        }
        onProgress?.(to, tip);
        from = to + 1;
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Total transparent balance in satoshis. Outputs reserved by
   * {@link buildSend} are excluded (like the shield wallet's pending-note
   * exclusion); {@link getUtxos} still lists them. Immature coinbase/
   * coinstake outputs ARE counted here even though {@link buildSend} cannot
   * spend them yet — use {@link spendableBalance} for what a send can use.
   */
  balance(): number {
    return [...this.utxos.values()].reduce(
      (s, u) => (this.pending.has(`${u.txid}:${u.vout}`) ? s : s + u.amount),
      0,
    );
  }

  /**
   * Balance actually selectable by {@link buildSend} right now: like
   * {@link balance} but also excluding immature coinbase/coinstake outputs
   * (the same maturity filter buildSend applies).
   */
  spendableBalance(): number {
    const maturity = coinbaseMaturity(this.network);
    return [...this.utxos.values()]
      .filter((u) => !this.pending.has(`${u.txid}:${u.vout}`))
      .filter((u) => !(u.coinbase && this.lastScanned - u.height + 1 < maturity))
      .reduce((s, u) => s + u.amount, 0);
  }

  /**
   * All tracked UTXOs, including ones reserved by {@link buildSend} (unlike
   * {@link balance}). Returns copies: mutating them does not affect the wallet.
   */
  getUtxos(): readonly OwnedUtxo[] {
    return [...this.utxos.values()].map((u) => ({ ...u, scriptPubKey: new Uint8Array(u.scriptPubKey) }));
  }

  /** Serialized size of one output: 8-byte value + scriptPubKey varint + script.
   * An EXM output is a 26-byte script (35 bytes total), not the 34 a flat
   * P2PKH assumes — undercounting it makes min-feerate exchange sends underpay. */
  private static outputSize(scriptLen: number): number {
    return 8 + (scriptLen < 0xfd ? 1 : 3) + scriptLen;
  }

  private static estSize(nIn: number, outBytes: number): number {
    // +2: the input-count varint grows from 1 to 3 bytes at 253 inputs.
    return nIn * 148 + outBytes + 10 + (nIn >= 253 ? 2 : 0);
  }

  /**
   * Build and sign a transparent send of `amount` sats to `to`, selecting
   * UTXOs largest-first with change to a fresh change address. `feePerByte`
   * defaults to 100 sats/byte. Returns the raw tx hex and the spent inputs.
   *
   * The selected inputs are reserved: a later buildSend will not select them
   * again until {@link markSpent} (broadcast succeeded) or {@link release}
   * (broadcast definitively rejected) resolves them.
   */
  buildSend(
    to: string,
    amount: number,
    feePerByte = 100,
  ): { hex: string; spent: { txid: string; vout: number }[] } {
    // A sync running in the event-loop gap (suspended on an RPC await) may be
    // mid-reorg reset; selecting/reserving a UTXO now risks spending an output
    // resetScan is about to drop. Refuse until the sync releases the guard.
    // (markSpent/release stay unguarded: removal-only finalization must always
    // complete, or a reservation leaks.)
    if (this.busy) throw new WalletBusyError();
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer (satoshis)');
    // Below 10 sat/byte the node will not relay the tx: minRelayTxFee is
    // 10000 sat/kB (PIVX src/validation.cpp).
    if (!Number.isInteger(feePerByte) || feePerByte < 10) {
      throw new Error('feePerByte must be an integer of at least 10 sat/byte (node minRelayTxFee = 10000 sat/kB)');
    }
    const dest = decodeAddress(to); // throws on an invalid address
    // A mainnet wallet must not send to a testnet-encoded address (or vice
    // versa): the hash would be spent to this network's equivalent — a silent
    // loss. Reject the mismatch up front.
    if (dest.network !== this.network) throw new Error('destination address is for a different network');
    if (dest.kind === 'staking') throw new Error('sending to a cold-staking address is not supported');
    // Reject a recipient amount the node would drop as dust.
    const toScript = scriptPubKeyForAddress(to);
    if (amount < dustThreshold(toScript.length)) throw new Error('amount is below the dust threshold');
    const feerate = feePerByte;
    // Size outputs by their real scriptPubKey length: the recipient's actual
    // script (P2PKH 25, EXM 26, P2SH 23) plus a P2PKH change output (25).
    // Selection conservatively assumes change is emitted (2 outputs).
    const outBytes =
      TransparentWallet.outputSize(toScript.length) + TransparentWallet.outputSize(25);
    // Exclude reserved outpoints (awaiting markSpent/release) and immature
    // coinbase/coinstake outputs: the node rejects a spend of one before
    // nCoinbaseMaturity confirmations (depth vs. last scanned block).
    const maturity = coinbaseMaturity(this.network);
    const avail = [...this.utxos.values()]
      .filter((u) => !this.pending.has(`${u.txid}:${u.vout}`))
      .filter((u) => !(u.coinbase && this.lastScanned - u.height + 1 < maturity))
      .sort((a, b) => b.amount - a.amount);
    const selected: OwnedUtxo[] = [];
    let total = 0;
    for (const u of avail) {
      selected.push(u);
      total += u.amount;
      // At/above MAX_STANDARD_TX_SIZE (100000, PIVX src/validation.h) the
      // node will never relay or mine the tx — policy rejects at `sz >=
      // 100000` (src/policy/policy.cpp) — so building it would only doom it.
      if (TransparentWallet.estSize(selected.length, outBytes) >= 100_000) {
        throw new Error(
          'transaction would exceed the 100kB standard size (too many small inputs); consolidate UTXOs first',
        );
      }
      if (total >= amount + feerate * TransparentWallet.estSize(selected.length, outBytes)) break;
    }
    const fee = feerate * TransparentWallet.estSize(selected.length, outBytes);
    // An absurd feePerByte can push the fee past exact-integer range, making
    // every later comparison unreliable (the Rust SDK errors on u64 overflow).
    if (!Number.isSafeInteger(fee)) throw new Error('fee computation overflows: feePerByte is too large');
    if (total < amount + fee) throw new InsufficientFundsError();
    const changeVal = total - amount - fee;

    const outputs = [{ address: to, amount }];
    // Emit change only above both floors: the node's fixed dust threshold (else
    // the tx is rejected as dust) and the fee to later spend the change input.
    // Change is always P2PKH (25-byte script).
    if (changeVal > Math.max(feerate * 148, dustThreshold(25))) {
      const chAddr = encodeAddress(fromHex(this.nextChangeHash()), this.network, 'p2pkh');
      outputs.push({ address: chAddr, amount: changeVal });
    }

    const inputs: TxInput[] = selected.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      amount: u.amount,
      scriptPubKey: u.scriptPubKey,
      privateKey: this.#keys.get(u.keyHash)!,
    }));
    const spent = selected.map((u) => ({ txid: u.txid, vout: u.vout }));
    const rawHex = buildTransparentTx(inputs, outputs, 0);
    for (const s of spent) this.pending.add(`${s.txid}:${s.vout}`);
    return { hex: rawHex, spent };
  }

  /** Mark inputs spent after a successful broadcast (drops them and their reservation). */
  markSpent(spent: { txid: string; vout: number }[]): void {
    for (const s of spent) {
      this.utxos.delete(`${s.txid}:${s.vout}`);
      this.pending.delete(`${s.txid}:${s.vout}`);
    }
  }

  /**
   * Release inputs reserved by {@link buildSend} after a definitively
   * rejected broadcast: they become selectable again. On an ambiguous failure
   * (timeout), keep them reserved until the transaction confirms or clearly
   * disappears.
   */
  release(spent: { txid: string; vout: number }[]): void {
    for (const s of spent) this.pending.delete(`${s.txid}:${s.vout}`);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Serialize wallet state to JSON (cross-SDK state format, version 1). No
   * key material is included — restore with {@link load} and the seed.
   */
  save(): string {
    return JSON.stringify({
      version: 1,
      network: this.network,
      account: this.account,
      gap: this.gap,
      nextExternal: this.nextExternal,
      nextChange: this.nextChange,
      lastScanned: this.lastScanned,
      lastScannedHash: this.lastScannedHash,
      // Rolling reorg window (ascending by height, newest last). Emitted here —
      // after lastScannedHash, before utxos — for byte parity with the Rust SDK.
      scannedHashes: this.scannedHashes.map((e) => ({ height: e.height, hash: e.hash })),
      // Sorted by (txid, vout) so save() output is deterministic and
      // byte-comparable with the Rust SDK's.
      utxos: [...this.utxos.values()]
        .sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout))
        .map((u) => ({
          txid: u.txid,
          vout: u.vout,
          amount: u.amount,
          scriptPubKey: hex(u.scriptPubKey),
          keyHash: u.keyHash,
          coinbase: u.coinbase,
          height: u.height,
        })),
      pending: [...this.pending]
        .map((k) => {
          const [txid, vout] = k.split(':');
          return { txid, vout: Number(vout) };
        })
        .sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : a.vout - b.vout)),
    });
  }

  /**
   * Restore a wallet from {@link save} output: re-derives keys from `seed`
   * (same network/account/gap as saved) and restores scan position, UTXOs,
   * and reservations. Throws if the state is malformed or does not belong to
   * this seed.
   */
  static load(seed: Uint8Array, state: string): TransparentWallet {
    let s: any;
    try {
      s = JSON.parse(state);
    } catch {
      throw new Error('wallet state is not valid JSON');
    }
    if (s === null || typeof s !== 'object') throw new Error('wallet state is not an object');
    if (s.version !== 1) throw new Error(`unsupported wallet state version ${s.version}`);
    if (s.network !== 'mainnet' && s.network !== 'testnet') {
      throw new Error('wallet state has an invalid network');
    }
    const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
    if (!isCount(s.account) || !isCount(s.gap) || !isCount(s.nextExternal) || !isCount(s.nextChange) || !isCount(s.lastScanned)) {
      throw new Error('wallet state has invalid counters');
    }
    // Bound attacker-controlled derivation work: load() re-derives 2*gap keys,
    // so an oversized gap in a hostile state file is a hang-on-load DoS.
    // account must fit a hardened BIP32 index.
    if (s.gap > 10_000) throw new Error('wallet state gap exceeds the supported maximum (10000)');
    if (s.account >= 0x80000000) throw new Error('wallet state account exceeds the BIP32 hardened range');
    if (s.lastScannedHash !== null && typeof s.lastScannedHash !== 'string') {
      throw new Error('wallet state has an invalid last-scanned hash');
    }
    if (!Array.isArray(s.utxos) || !Array.isArray(s.pending)) {
      throw new Error('wallet state has invalid utxo or pending lists');
    }
    // Backward-compatible: older states have no window → treat as empty.
    if (s.scannedHashes !== undefined && !Array.isArray(s.scannedHashes)) {
      throw new Error('wallet state has an invalid scanned-hash window');
    }
    const w = TransparentWallet.create(seed, s.network, s.account, s.gap);
    w.nextExternal = s.nextExternal;
    w.nextChange = s.nextChange;
    w.lastScanned = s.lastScanned;
    w.lastScannedHash = s.lastScannedHash;
    for (const u of s.utxos) {
      if (
        !isTxid(u?.txid) || !isCount(u.vout) || u.vout > 0xffffffff ||
        !Number.isSafeInteger(u.amount) || u.amount < 0 ||
        typeof u.scriptPubKey !== 'string' || !isHex(u.scriptPubKey) ||
        typeof u.keyHash !== 'string' || typeof u.coinbase !== 'boolean' || !isCount(u.height)
      ) {
        throw new Error('wallet state contains a malformed utxo');
      }
      if (!w.#keys.has(u.keyHash)) {
        throw new Error('wallet state does not match seed: utxo key hash is not derived from it');
      }
      const script = fromHex(u.scriptPubKey);
      // The scriptPubKey must actually pay the claimed key: otherwise a
      // hostile state file could make buildSend sign an arbitrary foreign
      // script (used verbatim as the sighash scriptCode) with our key.
      if (ownedScriptHash(script) !== u.keyHash) {
        throw new Error('wallet state contains a utxo whose script does not pay its key hash');
      }
      w.utxos.set(`${u.txid}:${u.vout}`, {
        txid: u.txid,
        vout: u.vout,
        amount: u.amount,
        scriptPubKey: script,
        keyHash: u.keyHash,
        coinbase: u.coinbase,
        height: u.height,
      });
    }
    for (const p of s.pending) {
      // Cap vout at 0xffffffff to match the Rust SDK's u32 (a state loads in
      // both or neither); isCount alone would accept up to 2^53-1.
      if (!isTxid(p?.txid) || !isCount(p.vout) || p.vout > 0xffffffff) {
        throw new Error('wallet state contains a malformed pending entry');
      }
      w.pending.add(`${p.txid}:${p.vout}`);
    }
    for (const e of s.scannedHashes ?? []) {
      // hash is string-checked (not hex-validated), matching lastScannedHash
      // and the Rust SDK so a state loads in both or neither.
      if (!isCount(e?.height) || typeof e.hash !== 'string') {
        throw new Error('wallet state contains a malformed scanned-hash entry');
      }
      w.scannedHashes.push({ height: e.height, hash: e.hash });
    }
    // Honest save() output is ascending, unique, ≤ REORG_WINDOW entries, all
    // heights ≤ lastScanned. The reorg walk-back trusts array order and entry
    // heights, so reject anything else rather than let a hostile or corrupt
    // state mislead it (this also keeps duplicates out of resetScan).
    if (
      w.scannedHashes.length > REORG_WINDOW ||
      w.scannedHashes.some(
        (e, i) => e.height > w.lastScanned || (i > 0 && e.height <= w.scannedHashes[i - 1].height),
      )
    ) {
      throw new Error('wallet state contains an invalid scanned-hash window');
    }
    return w;
  }
}

export { scriptPubKeyForAddress };
