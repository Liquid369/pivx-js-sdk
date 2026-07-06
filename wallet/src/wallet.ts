import { RpcError, type PivxClient } from 'pivx-rpc';
import { sha256 } from '@noble/hashes/sha2.js';
import { loadShield, type ProvingOptions, type Shield } from './shield-bindings.js';
import type {
  BuiltTransaction,
  CreateTransactionOptions,
  CreateWalletOptions,
  SpendableNote,
  SyncOptions,
  TransparentInput,
  WalletBlock,
  WalletState,
} from './types.js';

/** PIVX BIP44 coin types. */
const COIN_TYPE = { mainnet: 119, testnet: 1 } as const;

/** SHA256 of the sapling proving parameters, pinned identically to the Rust
 * SDK's prover.rs (OUTPUT_SHA256 / SPEND_SHA256). loadProver verifies every
 * source (bytes, path, and url-fetched bytes) against these before handing
 * them to the WASM. */
const OUTPUT_SHA256 = '2f0ebbcbb9bb0bcffe95a397e7eba89c29eb4dde6191c339db88570e3f3fb0e4';
const SPEND_SHA256 = '8e48ffd23abb3a5fd9c5589204f32d9c31285a04b78096ba40a79b75677efc13';

const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Reject sapling proving params whose SHA256 does not match the pinned hash. */
function verifyProvingParams(output: Uint8Array, spend: Uint8Array): void {
  if (toHex(sha256(output)) !== OUTPUT_SHA256) {
    throw new Error('sapling output parameters failed SHA256 verification');
  }
  if (toHex(sha256(spend)) !== SPEND_SHA256) {
    throw new Error('sapling spend parameters failed SHA256 verification');
  }
}

/** Threshold at/above which the sapling root check runs; below it we skip. These
 * are the exact UPGRADE_V5_0 activation heights (inclusive) from PIVX consensus,
 * so at/above them an honest node always reports a real, matchable
 * finalsaplingroot, and below them (no shielded txs yet) there is nothing to
 * verify. Mainnet V5_0 is 2_700_500; testnet is 201. */
const SAPLING_ACTIVATION = { mainnet: 2_700_500, testnet: 201 } as const;

/** A note worth no more than its own input fee (sapling input 384 bytes ×
 * 1000 sats/byte) never helps cover amount+fee, so it is never spent. */
const DUST_NOTE_SATS = 384_000;

/**
 * Mirror of the Rust/WASM note selection and fee model: consume notes
 * smallest-first, growing the fee per sapling input, and report whether the
 * inputs cover amount + fee. Used to refuse a send that would otherwise have
 * the fee silently taken from the recipient.
 */
function estimateShieldSelection(
  notes: SpendableNote[],
  amount: number,
  toIsShield: boolean,
): { fee: number; sufficient: boolean } {
  const tOut = toIsShield ? 0 : 1;
  const feeFor = (sIn: number) => 1000 * (2 * 948 + sIn * 384 + tOut * 34 + 85);
  const sorted = [...notes].sort((a, b) => a.note.value - b.note.value);
  let total = 0;
  let sIn = 0;
  let fee = feeFor(0);
  for (const n of sorted) {
    sIn++;
    fee = feeFor(sIn);
    total += n.note.value;
    if (total >= amount + fee) break;
  }
  return { fee, sufficient: total >= amount + fee };
}

/**
 * Same model for the transparent-input (shielding) path: consume UTXOs
 * smallest-first with a per-transparent-input fee and a transparent change
 * output, and report whether they cover amount + fee. The WASM's utxo
 * selection has the same silent-underpay behavior as its note path.
 */
function estimateTransparentSelection(
  utxos: TransparentInput[],
  amount: number,
  toIsShield: boolean,
): { fee: number; sufficient: boolean } {
  // Recipient (shield → 0 transparent outputs, else 1) plus a transparent change output.
  const tOut = (toIsShield ? 0 : 1) + 1;
  const feeFor = (tIn: number) => 1000 * (2 * 948 + tIn * 150 + tOut * 34 + 85);
  const sorted = [...utxos].sort((a, b) => a.amount - b.amount);
  let total = 0;
  let tIn = 0;
  let fee = feeFor(0);
  for (const u of sorted) {
    tIn++;
    fee = feeFor(tIn);
    total += u.amount;
    if (total >= amount + fee) break;
  }
  return { fee, sufficient: total >= amount + fee };
}

/** Thrown when a watch-only wallet is asked to spend. */
export class NoSpendAuthorityError extends Error {
  constructor() {
    super('wallet is watch-only (viewing key): load a spending key to spend');
    this.name = 'NoSpendAuthorityError';
  }
}

/** Thrown when the selected inputs can't cover the amount plus fee (and the
 * caller did not opt into paying the fee out of the recipient's amount).
 * Subclasses Error, so `catch (e) { if (e instanceof Error) … }` still works. */
export class InsufficientFundsError extends Error {
  constructor() {
    super(
      'insufficient input value to cover amount + fee; lower the amount, ' +
        'add inputs, or pass subtractFeeFromAmount:true to deduct the fee from the recipient',
    );
    this.name = 'InsufficientFundsError';
  }
}

/** Thrown when a state-mutating call (sync, spend, handleBlocks,
 * reloadFromCheckpoint) races another one already in progress. Subclasses
 * Error so existing `instanceof Error` catches keep working. */
export class WalletBusyError extends Error {
  constructor() {
    super('wallet is busy: another sync or spend is in progress');
    this.name = 'WalletBusyError';
  }
}

/** Thrown when the local commitment tree diverges from the node's sapling root. */
export class ScanDivergedError extends Error {
  constructor(
    public readonly height: number,
    public readonly localRoot: string,
    public readonly nodeRoot: string,
  ) {
    super(
      `scan diverged at height ${height}: wallet state is corrupt or the node is on another chain; ` +
        'call reloadFromCheckpoint() (or resetScan for a transparent wallet) and resync',
    );
    this.name = 'ScanDivergedError';
  }
}

/** Reverse hex byte order (node displays sapling roots like txids, byte-reversed). */
const reverseHex = (hex: string) => (hex.match(/../g) ?? []).reverse().join('');

/** Guard the money path against non-numeric note values from tampered state. */
const assertSats = (v: unknown): number => {
  if (!Number.isSafeInteger(v)) throw new Error(`note value is not a valid satoshi amount: ${v}`);
  return v as number;
};

// Only sapling-capable (version 3) transactions carry shield outputs. Feeding
// anything else to the scanner is wasted work, and the parser rejects some
// legacy transactions outright. PIVX sapling txs serialize with a 4-byte
// little-endian version of 3, so the hex starts with "03". This assumes
// version 3 is the only shielded version; revisit if that ever changes.
const isSaplingTx = (hex: string): boolean => hex.startsWith('03');

/** RPC errors that mean the node ALREADY HAS this transaction (or a
 * conflicting one in its mempool), so the spend may still confirm: -27 =
 * transaction already in chain (PIVX rpc/protocol.h), the reject reasons
 * txn-already-in-mempool / txn-already-known / txn-mempool-conflict, and the
 * shield-specific bad-txns-nullifier-double-spent (a mempool tx already
 * spends a nullifier of ours — possibly this very tx, rebroadcast or raced)
 * and bad-txns-shielded-requirements-not-met (HaveShieldedRequirements: an
 * anchor/nullifier already spent on-chain) — all PIVX validation.cpp. The
 * -27 already-in-chain probe scans vout only (rawtransaction.cpp), so it can
 * never fire for a z→z spend; the shield-specific reasons are what fire
 * instead. Treated like a transport error: keep the spend pending. */
const txMayBeAccepted = (err: RpcError): boolean =>
  err.code === -27 ||
  /txn-already-in-mempool|txn-already-known|txn-mempool-conflict|bad-txns-nullifier-double-spent|bad-txns-shielded-requirements-not-met/.test(
    err.message,
  );

/**
 * Standalone PIVX wallet: owns keys, scans blocks, tracks shielded notes,
 * and builds fully-proved transactions locally. A node (via `pivx-rpc`) is
 * only used as a chain-data source and broadcast endpoint.
 *
 * Capabilities follow the key material: constructed from a seed or spending
 * key the wallet can spend; from a viewing key it can scan, derive receive
 * addresses, and track balance (watch-only) — and can be upgraded in place
 * with {@link loadSpendingKey}.
 */
export class PivxWallet {
  private extsk?: string;
  private notes: SpendableNote[] = [];
  private nullifierMap = new Map<string, { recipient: string; value: number }>();
  /** txid → nullifiers awaiting broadcast confirmation. Persisted, so a
   * crash between broadcast and finalize can't resurrect spent notes. */
  private pendingSpends = new Map<string, string[]>();
  private diversifierIndex: number[];
  /** One writer at a time: block state-mutating operations from racing. */
  private busy = false;
  /** Whether the starting checkpoint has been confirmed against the node. */
  private startValidated = false;

  private constructor(
    private readonly shield: Shield,
    public readonly network: 'mainnet' | 'testnet',
    private readonly extfvk: string,
    private commitmentTree: string,
    private lastProcessedBlock: number,
    diversifierIndex: number[],
    extsk?: string,
  ) {
    this.extsk = extsk;
    this.diversifierIndex = diversifierIndex;
  }

  private get isTestnet(): boolean {
    return this.network === 'testnet';
  }

  /** True when the wallet holds spend authority. */
  get canSpend(): boolean {
    return this.extsk !== undefined;
  }

  static async create(opts: CreateWalletOptions): Promise<PivxWallet> {
    const network = opts.network ?? 'mainnet';
    const provided = [opts.seed, opts.spendingKey, opts.viewingKey].filter((k) => k !== undefined);
    if (provided.length !== 1) {
      throw new Error('provide exactly one of: seed, spendingKey, viewingKey');
    }
    const shield = await loadShield(opts.proving);
    const isTestnet = network === 'testnet';

    let extsk: string | undefined;
    if (opts.seed) {
      // Accept a 32-byte raw seed OR a 64-byte BIP39 seed (MyPIVXWallet /
      // BIP39 seed-phrase wallets). ZIP32 shield derivation uses only the
      // first 32 bytes; the pivx-shield WASM truncates whatever it's given, so
      // pass the seed through unchanged — a 64-byte seed and its first 32 bytes
      // yield the same spending key.
      if (opts.seed.length !== 32 && opts.seed.length !== 64) {
        throw new Error('seed must be 32 bytes (raw) or 64 bytes (BIP39)');
      }
      extsk = shield.generate_extended_spending_key_from_seed({
        seed: Array.from(opts.seed),
        coin_type: COIN_TYPE[network],
        account_index: opts.accountIndex ?? 0,
      }) as string;
    } else if (opts.spendingKey) {
      extsk = opts.spendingKey;
    }
    const extfvk = extsk
      ? (shield.generate_extended_full_viewing_key(extsk, isTestnet) as string)
      : opts.viewingKey!;

    // The WASM converts birthHeight to i32, wrapping silently: 2^40 -> 0
    // (rescan from genesis), 1e20 -> a near-tip skip past real deposits.
    // Require a non-negative integer within i32 range so get_closest_checkpoint
    // sees the height the caller meant (the Rust twin clamps at the same bound).
    if (!Number.isSafeInteger(opts.birthHeight) || opts.birthHeight < 0 || opts.birthHeight > 0x7fff_ffff) {
      throw new Error(`birthHeight must be an integer in [0, 2^31-1], got ${opts.birthHeight}`);
    }
    // Resume from the checkpoint's own height, not birthHeight: the loaded
    // tree is the committed state AT the checkpoint, so scanning must start
    // at checkpointHeight + 1. Starting higher would leave the tree missing
    // every shield output in the gap and diverge on the first real block.
    const [checkpointHeight, checkpointTree] = shield.get_closest_checkpoint(
      opts.birthHeight,
      isTestnet,
    ) as [number, string];
    const { diversifier_index } = shield.generate_default_payment_address(extfvk, isTestnet) as {
      address: string;
      diversifier_index: number[];
    };

    return new PivxWallet(
      shield,
      network,
      extfvk,
      checkpointTree,
      checkpointHeight,
      diversifier_index,
      extsk,
    );
  }

  /** Upgrade a watch-only wallet. The key must match the stored viewing key. */
  loadSpendingKey(spendingKey: string): void {
    if (this.extsk) throw new Error('wallet already has a spending key');
    const derived = this.shield.generate_extended_full_viewing_key(
      spendingKey,
      this.isTestnet,
    ) as string;
    if (derived !== this.extfvk) {
      throw new Error('spending key does not match this wallet\'s viewing key');
    }
    this.extsk = spendingKey;
  }

  // ── Addresses & balance ───────────────────────────────────────────────────

  /** Next diversified shield receive address. */
  getNewAddress(): string {
    const { address, diversifier_index } = this.shield.generate_next_shielding_payment_address(
      this.extfvk,
      new Uint8Array(this.diversifierIndex),
      this.isTestnet,
    ) as { address: string; diversifier_index: number[] };
    this.diversifierIndex = diversifier_index;
    return address;
  }

  /** Confirmed shielded balance in satoshis (scanned notes, minus pending spends). */
  getBalance(): number {
    const pending = new Set([...this.pendingSpends.values()].flat());
    return this.notes
      .filter((n) => !pending.has(n.nullifier))
      .reduce((sum, n) => sum + assertSats(n.note.value), 0);
  }

  /** Whether `address` is a shield (Sapling) address on this wallet's network. */
  private isShieldAddress(address: string): boolean {
    return address.startsWith(this.isTestnet ? 'ptestsapling1' : 'ps1');
  }

  /** Currently tracked unspent notes. */
  getNotes(): readonly SpendableNote[] {
    return this.notes;
  }

  getLastSyncedBlock(): number {
    return this.lastProcessedBlock;
  }

  /** Look up a note by its on-chain nullifier (payment attribution for spends). */
  getNoteFromNullifier(nullifier: string): { recipient: string; value: number } | undefined {
    return this.nullifierMap.get(nullifier);
  }

  /**
   * Remove every nullifier-map entry that is no longer referenced by a
   * currently tracked unspent note or by a pending spend, and return the
   * number removed. Explicit and opt-in: the map is what powers
   * {@link getNoteFromNullifier}, so callers using nullifier → note
   * attribution should call this only after reconciling the spends they
   * care about. Deterministic; the save/load format is unchanged.
   */
  pruneNullifiers(): number {
    const live = new Set(this.notes.map((n) => n.nullifier));
    for (const nulls of this.pendingSpends.values()) for (const n of nulls) live.add(n);
    let removed = 0;
    for (const nullifier of this.nullifierMap.keys()) {
      if (!live.has(nullifier)) {
        this.nullifierMap.delete(nullifier);
        removed++;
      }
    }
    return removed;
  }

  // ── Scanning ──────────────────────────────────────────────────────────────

  /**
   * Scan blocks (strictly ascending heights, all above the last synced
   * block). Returns the raw hexes of transactions relevant to this wallet.
   * Use this directly when you have your own block feed; otherwise see
   * {@link sync}.
   */
  handleBlocks(blocks: WalletBlock[]): string[] {
    if (this.busy) throw new WalletBusyError();
    return this.applyBlocks(blocks);
  }

  /** handleBlocks without the busy guard, for internal use by sync (which
   * already holds the guard). */
  private applyBlocks(blocks: WalletBlock[]): string[] {
    let prev = this.lastProcessedBlock;
    const activation = SAPLING_ACTIVATION[this.network];
    for (const b of blocks) {
      // A NaN/undefined/fractional height would bypass the ascending guard
      // below (NaN <= prev is false) and the below-activation filter, and
      // poison lastProcessedBlock. Reject before any state is touched.
      if (!Number.isSafeInteger(b.height)) {
        throw new Error(`block height must be a safe integer, got ${b.height}`);
      }
      if (b.height <= prev) {
        throw new Error(`blocks must be strictly ascending and above ${this.lastProcessedBlock}`);
      }
      prev = b.height;
      for (const t of b.txs) {
        // A tx object without hex is malformed block data: fail with the
        // block named (matches the Rust SDK) rather than a bare TypeError.
        if (typeof t.hex !== 'string') {
          throw new Error(`block ${b.height} has a tx without hex`);
        }
      }
    }
    if (blocks.length === 0) return [];

    // Below SAPLING_ACTIVATION, '03'-prefixed txs are SKIPPED rather than
    // scanned: consensus forbids shielded DATA below activation (IsShieldedTx
    // = sapling version AND sapling data, PIVX transaction.h /
    // sapling_validation.cpp), not the version byte itself, so a bare-v3
    // empty-sapdata tx is consensus-legal and must not fail the sync. Bare v3
    // is excluded from real chains by serialization history and carries no
    // shield data, so skipping loses nothing; fabricated sapling data below
    // activation is unverifiable (the root check is skipped down there) and
    // stays uncredited because it never reaches the scanner.
    const result = this.shield.handle_blocks(
      this.commitmentTree,
      blocks.map((b) => ({
        txs: b.height >= activation ? b.txs.map((t) => t.hex).filter(isSaplingTx) : [],
      })),
      this.extfvk,
      this.isTestnet,
      this.notes,
    ) as {
      decrypted_notes: SpendableNote[];
      decrypted_new_notes: SpendableNote[];
      nullifiers: string[];
      commitment_tree: string;
      wallet_transactions: string[];
    };

    this.commitmentTree = result.commitment_tree;
    const spent = new Set(result.nullifiers);
    // Do not retain sub-dust notes: they are never spendable (below their own
    // input fee), so keeping them would let a dust flood grow state and
    // per-block scan cost without bound. Their commitment is still in the tree
    // (appended for every output during the scan), so the root stays correct.
    this.notes = [...result.decrypted_notes, ...result.decrypted_new_notes].filter(
      (n) => !spent.has(n.nullifier) && n.note.value > DUST_NOTE_SATS,
    );
    for (const { note, nullifier } of result.decrypted_new_notes) {
      if (note.value > DUST_NOTE_SATS) {
        this.nullifierMap.set(nullifier, {
          recipient: this.encodeRecipient(note.recipient),
          value: note.value,
        });
      }
    }
    // Drop pending-spend entries whose notes are now gone (the transaction
    // confirmed and its notes were scanned out), so pendingSpends can't leak.
    const tracked = new Set(this.notes.map((n) => n.nullifier));
    for (const [txid, nulls] of this.pendingSpends) {
      if (!nulls.some((n) => tracked.has(n))) this.pendingSpends.delete(txid);
    }
    this.lastProcessedBlock = blocks[blocks.length - 1].height;
    return result.wallet_transactions;
  }

  /**
   * Decrypt a single transaction's outputs for this wallet without touching
   * wallet state — a hint for 0-conf payment detection from the mempool.
   *
   * This only trial-decrypts; it does NOT validate the transaction (proof,
   * double-spend, or whether it will ever confirm). Do not credit funds
   * from a preview: dedupe on the caller's own txid and credit only from
   * confirmed notes returned by {@link getNotes} after {@link sync}.
   */
  previewTransaction(hex: string): { recipient: string; value: number; memo?: string | null }[] {
    if (!isSaplingTx(hex)) return []; // non-sapling tx has no shield outputs (and would panic the scanner)
    const result = this.shield.handle_blocks(
      this.commitmentTree,
      [{ txs: [hex] }],
      this.extfvk,
      this.isTestnet,
      [],
    ) as { decrypted_new_notes: SpendableNote[] };
    return result.decrypted_new_notes.map(({ note, memo }) => ({
      recipient: this.encodeRecipient(note.recipient),
      value: note.value,
      memo,
    }));
  }

  /**
   * Sync from the node up to its current tip.
   *
   * Each batch checks the locally-built tree against the node's own
   * `finalsaplingroot`. That catches malformed or mis-ordered data from the
   * node, but it is a self-consistency check, not chain authentication: the
   * SDK does not validate proof-of-stake, so a dishonest node can still serve
   * a self-consistent fabricated chain. Point this at a node you trust. See
   * SECURITY.md.
   */
  async sync(client: PivxClient, opts: SyncOptions = {}): Promise<void> {
    if (this.busy) throw new WalletBusyError();
    this.busy = true;
    try {
      const throwIfAborted = () => {
        if (opts.signal?.aborted) {
          throw opts.signal.reason ?? new DOMException('sync aborted', 'AbortError');
        }
      };
      // NaN/0/fractional → sane integer; 0 would loop forever.
      const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 100) || 1);
      // getblock verbosity 2 is heavy. A default node has 4 RPC threads and a
      // work queue of 16, so firing a whole batch at once gets 500s. Keep the
      // concurrent fetches well under that.
      const concurrency = Math.max(1, opts.rpcConcurrency ?? 8);
      const tip = await client.getBlockCount();
      await this.ensureValidCheckpoint(client);
      const fetchBlock = async (h: number) => {
        const hash = await client.getBlockHash(h);
        const block = (await client.getBlock(hash, 2)) as {
          height: number;
          finalsaplingroot?: string;
          tx: { hex: string; txid: string }[];
        };
        // Trust the height we asked for, not the one the node echoes, and
        // reject a mismatch outright — otherwise a lying node can
        // fast-forward lastProcessedBlock past real deposits.
        if (block.height !== h) {
          throw new Error(`node returned block height ${block.height} for requested height ${h}`);
        }
        // A block without a tx array is malformed node data: dropping it would
        // desync the commitment tree. Fail with the block named, matching the
        // transparent side's hash/previousblockhash guards and the Rust twin.
        if (!Array.isArray(block.tx)) {
          throw new Error(`node returned a malformed block: missing tx array at height ${h}`);
        }
        return block;
      };
      // Stale-tip reorg detection: when lastProcessedBlock === tip the batch
      // loop below never runs, so its per-batch root check never fires. A
      // same-height reorg (block N replaced while the tip stays N) changes the
      // shielded set's root but not the height. The tree can't be cheaply
      // rewound, so re-verify the tip's finalsaplingroot against our local
      // commitment root — the same localRoot-vs-nodeRoot check the batch loop
      // does — and diverge on mismatch (caller recovers via reloadFromCheckpoint).
      // Runs even at an exact checkpoint height: a fresh wallet still on its
      // bundled checkpoint matches the node's finalsaplingroot there (that is
      // what a checkpoint is, and ensureValidCheckpoint already confirmed it),
      // so it is a clean no-op — while a wallet that scanned up to a checkpoint
      // height and was then same-height reorged finally gets the check it was
      // missing. Route the fetch through nodeSaplingRoot so it is skipped below
      // the SAPLING_ACTIVATION threshold: below real V5_0 the node reports a
      // zero root our non-zero empty tree can't match, so an honest wallet would
      // false-diverge — the same activation exception ensureValidCheckpoint
      // relies on. nodeSaplingRoot's verbosity-1 getblock returns
      // finalsaplingroot without the full tx list the batch fetchBlock needs.
      if (this.lastProcessedBlock === tip) {
        const nodeRoot = await this.nodeSaplingRoot(client, tip);
        if (nodeRoot !== null) {
          const localRoot = reverseHex(this.shield.get_sapling_root(this.commitmentTree) as string);
          if (localRoot !== nodeRoot) throw new ScanDivergedError(tip, localRoot, nodeRoot);
        }
      }
      while (this.lastProcessedBlock < tip) {
        throwIfAborted(); // batch boundary: nothing applied yet, state consistent
        const from = this.lastProcessedBlock + 1;
        const to = Math.min(from + batchSize - 1, tip);
        const heights = Array.from({ length: to - from + 1 }, (_, i) => from + i);
        const blocks: Awaited<ReturnType<typeof fetchBlock>>[] = [];
        for (let i = 0; i < heights.length; i += concurrency) {
          throwIfAborted(); // chunk boundary: before issuing the next RPCs
          blocks.push(...(await Promise.all(heights.slice(i, i + concurrency).map(fetchBlock))));
        }

        // Snapshot so a failed root check can't leave partial state behind.
        // Includes pendingSpends because applyBlocks reconciles it.
        const snapshot = {
          tree: this.commitmentTree,
          last: this.lastProcessedBlock,
          notes: this.notes,
          nmap: new Map(this.nullifierMap),
          pending: new Map(this.pendingSpends),
        };
        try {
          this.applyBlocks(
            heights.map((h, i) => ({
              height: h,
              txs: blocks[i].tx.map(({ hex, txid }) => ({ hex, txid })),
            })),
          );

          // Verify the locally-built tree against the node's finalsaplingroot,
          // except below the SAPLING_ACTIVATION threshold, where we skip: below
          // real V5_0 the node reports a zero root our non-zero empty tree can't
          // match, and no shielded txs exist below activation anyway, so there
          // is nothing to verify. Both networks can scan into the skip window: a
          // testnet wallet with a below-activation birth height resumes from the
          // height-0 empty-tree checkpoint, and a mainnet wallet resumes from
          // checkpoint 2_700_000 and scans the empty [2_700_001, 2_700_500) gap
          // below its real activation. Same exception nodeSaplingRoot encodes.
          if (to >= SAPLING_ACTIVATION[this.network]) {
            const nodeRoot = blocks[blocks.length - 1].finalsaplingroot;
            // A shielded chain always has a sapling root; a missing one past
            // activation means the node is lying. Refuse to advance unverified.
            if (!nodeRoot) throw new Error(`node omitted finalsaplingroot at height ${to}`);
            const localRoot = reverseHex(this.shield.get_sapling_root(this.commitmentTree) as string);
            if (localRoot !== nodeRoot) throw new ScanDivergedError(to, localRoot, nodeRoot);
          }
        } catch (err) {
          this.commitmentTree = snapshot.tree;
          this.lastProcessedBlock = snapshot.last;
          this.notes = snapshot.notes;
          this.nullifierMap = snapshot.nmap;
          this.pendingSpends = snapshot.pending;
          throw err;
        }
        opts.onProgress?.(to, tip);
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * The node's finalsaplingroot at height h, or null below the SAPLING_ACTIVATION
   * threshold — below real V5_0 the node reports a zero root our non-zero empty
   * tree can't match, so returning null signals "skip the check". At/above the
   * threshold the node must report one; treating an omitted root as "no root"
   * would let a node suppress the check or force an all-the-way rewind by simply
   * withholding the field.
   */
  private async nodeSaplingRoot(client: PivxClient, h: number): Promise<string | null> {
    if (h < SAPLING_ACTIVATION[this.network]) return null;
    const block = (await client.getBlock(await client.getBlockHash(h), 1)) as {
      finalsaplingroot?: string;
    };
    if (!block.finalsaplingroot) {
      throw new Error(`node omitted finalsaplingroot at height ${h} (past sapling activation)`);
    }
    return block.finalsaplingroot;
  }

  /**
   * Confirm the starting commitment tree against the node before scanning
   * forward. A fresh wallet begins at a bundled checkpoint; if that
   * checkpoint's tree does not match the node's sapling root at that height
   * (some near-tip checkpoints in the shield library are captured on stale
   * blocks), walk back to the newest checkpoint the node does confirm. A
   * wallet that already holds scanned notes and no longer matches is treated
   * as diverged rather than silently rewound.
   */
  private async ensureValidCheckpoint(client: PivxClient): Promise<void> {
    if (this.startValidated) return;
    const localRoot = () => reverseHex(this.shield.get_sapling_root(this.commitmentTree) as string);

    const node = await this.nodeSaplingRoot(client, this.lastProcessedBlock);
    if (node === null || localRoot() === node) {
      this.startValidated = true;
      return;
    }
    // A rewind is only appropriate for a fresh wallet still sitting on a
    // bundled checkpoint. A wallet that has scanned forward (past a
    // checkpoint, or holding notes) and no longer matches is diverged —
    // rewinding would silently discard correct progress.
    const [nearest] = this.shield.get_closest_checkpoint(this.lastProcessedBlock, this.isTestnet) as [
      number,
      string,
    ];
    const atCheckpoint = nearest === this.lastProcessedBlock;
    if (this.notes.length > 0 || this.pendingSpends.size > 0 || !atCheckpoint) {
      throw new ScanDivergedError(this.lastProcessedBlock, localRoot(), node);
    }

    let probe = this.lastProcessedBlock - 1;
    let lastCp = this.lastProcessedBlock;
    let adopted = false;
    while (probe > 0) {
      const [cpHeight, cpTree] = this.shield.get_closest_checkpoint(probe, this.isTestnet) as [
        number,
        string,
      ];
      if (cpHeight >= lastCp) break; // no older checkpoint available
      lastCp = cpHeight;
      const nodeRoot = await this.nodeSaplingRoot(client, cpHeight);
      const cpRoot = reverseHex(this.shield.get_sapling_root(cpTree) as string);
      if (nodeRoot === null || cpRoot === nodeRoot) {
        this.commitmentTree = cpTree;
        this.lastProcessedBlock = cpHeight;
        adopted = true;
        break;
      }
      probe = cpHeight - 1;
    }
    // No bundled checkpoint matched the node: do not proceed on an unconfirmed
    // tree. Surface it rather than silently "validating".
    if (!adopted) throw new ScanDivergedError(this.lastProcessedBlock, localRoot(), node);
    this.startValidated = true;
  }

  /**
   * Reset scan state to the checkpoint at or below `height` and drop all
   * tracked notes. This is the recovery path after a divergence error: call
   * it, then sync again. It needs no keys.
   */
  reloadFromCheckpoint(height: number): void {
    if (this.busy) throw new WalletBusyError();
    // get_closest_checkpoint takes an i32 in the WASM, which wraps silently: a
    // NaN/negative/out-of-range height would pick a wrong checkpoint and clear
    // notes/pending into a stuck resync. Apply the same guard create() applies
    // to birthHeight, and throw BEFORE any state is cleared.
    if (!Number.isSafeInteger(height) || height < 0 || height > 0x7fff_ffff) {
      throw new Error(`height must be an integer in [0, 2^31-1], got ${height}`);
    }
    const [cpHeight, cpTree] = this.shield.get_closest_checkpoint(height, this.isTestnet) as [
      number,
      string,
    ];
    this.commitmentTree = cpTree;
    this.lastProcessedBlock = cpHeight;
    this.notes = [];
    this.nullifierMap = new Map();
    this.pendingSpends = new Map();
    this.startValidated = false; // re-confirm the checkpoint on the next sync
  }

  // ── Spending ──────────────────────────────────────────────────────────────

  /**
   * Load sapling proving parameters (required once before building
   * transactions). All three inputs are SHA256-verified against the pinned
   * parameter hashes before use (the same integrity check the Rust SDK pins in
   * prover.rs), so corrupt or substituted params are rejected. For `url`, the
   * SDK fetches `<url>/sapling-output.params` and `<url>/sapling-spend.params`,
   * hashes them, and loads via the verified-bytes path — matching Rust's
   * load_prover_from_url; the raw URL is never handed to the WASM unverified.
   */
  async loadProver(
    source: { path: string } | { url: string } | { spend: Uint8Array; output: Uint8Array },
  ): Promise<void> {
    let ok: boolean;
    if ('path' in source) {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const [output, spend] = await Promise.all([
        readFile(join(source.path, 'sapling-output.params')),
        readFile(join(source.path, 'sapling-spend.params')),
      ]);
      verifyProvingParams(output, spend);
      ok = await this.shield.load_prover_with_bytes(output, spend);
    } else if ('url' in source) {
      // Fetch the same two params Rust's load_prover_from_url pulls, SHA256-pin
      // them, then load via the verified-bytes path (never the unpinned WASM URL).
      const fetchParam = async (name: string): Promise<Uint8Array> => {
        const res = await fetch(`${source.url}/${name}`);
        if (!res.ok) throw new Error(`failed to fetch ${name}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      };
      const [output, spend] = await Promise.all([
        fetchParam('sapling-output.params'),
        fetchParam('sapling-spend.params'),
      ]);
      verifyProvingParams(output, spend);
      ok = await this.shield.load_prover_with_bytes(output, spend);
    } else {
      verifyProvingParams(source.output, source.spend);
      ok = await this.shield.load_prover_with_bytes(source.output, source.spend);
    }
    if (!ok) throw new Error('failed to load sapling proving parameters');
  }

  /**
   * Build and prove a transaction locally. Nothing is broadcast; the spent
   * notes are held as pending until {@link finalizeTransaction} or
   * {@link discardTransaction}.
   */
  async createTransaction(opts: CreateTransactionOptions): Promise<BuiltTransaction> {
    if (!this.extsk) throw new NoSpendAuthorityError();
    if (!Number.isSafeInteger(opts.amount) || opts.amount <= 0) {
      throw new Error('amount must be a positive integer number of satoshis');
    }
    if (opts.memo !== undefined && new TextEncoder().encode(opts.memo).length > 512) {
      throw new Error('memo must be at most 512 bytes');
    }
    const useShield = opts.inputs === undefined || opts.inputs === 'shield';
    if (!useShield && !opts.transparentChangeAddress) {
      throw new Error('transparentChangeAddress is required when spending transparent inputs');
    }
    // Validate transparent inputs. Amounts are satoshis here; a caller wiring
    // pivx-rpc's PIV-float listUnspent straight in (a natural mistake) would
    // otherwise donate the difference to fees.
    if (!useShield) {
      for (const u of opts.inputs as TransparentInput[]) {
        if (!Number.isSafeInteger(u.amount) || u.amount < 0) {
          throw new Error('transparent input amount must be a non-negative integer (satoshis)');
        }
      }
    }

    // Acquire the single-writer guard BEFORE snapshotting spendable notes or
    // awaiting anything. Otherwise two concurrent createTransaction calls could
    // each snapshot the same notes before either set `busy`, then serialize on
    // the guard and both build with the same inputs — a double-spend.
    if (this.busy) throw new WalletBusyError();
    this.busy = true;
    try {
      // Spendable notes, minus pending spends and dust. Dust notes (worth no
      // more than their own input fee) can never help cover amount+fee and only
      // let an attacker inflate the fee, so they are excluded from spending.
      const pending = new Set([...this.pendingSpends.values()].flat());
      const spendable = this.notes.filter(
        (n) => !pending.has(n.nullifier) && n.note.value > DUST_NOTE_SATS,
      );

      // Refuse a send the inputs can't cover including the fee, unless the
      // caller opts into paying the fee out of the recipient's amount. Both
      // branches mirror the Rust selection so the WASM can't silently pay the
      // fee out of the recipient's amount — the WASM shares the same fee model
      // but has no such guard. `sweep` is the deprecated alias for
      // `subtractFeeFromAmount` (same flag; see types.ts).
      const subtractFeeFromAmount = opts.subtractFeeFromAmount ?? opts.sweep ?? false;
      const sufficient = useShield
        ? estimateShieldSelection(spendable, opts.amount, this.isShieldAddress(opts.to)).sufficient
        : estimateTransparentSelection(
            opts.inputs as TransparentInput[],
            opts.amount,
            this.isShieldAddress(opts.to),
          ).sufficient;
      if (!sufficient && !subtractFeeFromAmount) {
        throw new InsufficientFundsError();
      }

      // Prover is only needed to build; check it after the cheap validations
      // so callers get input errors without loading ~50MB of parameters.
      if (!(await this.shield.prover_is_loaded())) {
        throw new Error('sapling prover not loaded: call loadProver() first');
      }
      // getNewAddress() advances the shield diversifier cursor, but the
      // create_transaction call below can still throw (prover/recipient error).
      // Snapshot the cursor and restore it on failure so a failed send does not
      // burn an internal address — the Rust twin's plan_transaction does the
      // same. (Transparent change comes from the caller, no cursor to restore.)
      const savedDiversifierIndex = this.diversifierIndex;
      const changeAddress = useShield ? this.getNewAddress() : opts.transparentChangeAddress!;

      let result: { txid: string; txhex: string; nullifiers: string[] };
      try {
        result = (await this.shield.create_transaction({
          notes: useShield ? spendable : null,
          utxos: useShield ? null : (opts.inputs as TransparentInput[]),
          extsk: this.extsk,
          to_address: opts.to,
          change_address: changeAddress,
          amount: opts.amount,
          block_height: this.lastProcessedBlock + 1,
          is_testnet: this.isTestnet,
          memo: opts.memo ?? '',
        })) as { txid: string; txhex: string; nullifiers: string[] };
      } catch (err) {
        if (useShield) this.diversifierIndex = savedDiversifierIndex;
        throw err;
      }

      if (useShield) this.pendingSpends.set(result.txid, result.nullifiers);
      return { txid: result.txid, hex: result.txhex, nullifiers: result.nullifiers };
    } finally {
      this.busy = false;
    }
  }

  /** Build, broadcast, and finalize in one step. */
  async send(client: PivxClient, opts: CreateTransactionOptions): Promise<string> {
    const tx = await this.createTransaction(opts);
    try {
      const txid = await client.sendRawTransaction(tx.hex);
      this.finalizeTransaction(tx.txid);
      return txid;
    } catch (err) {
      // Only release the notes when the node definitively rejected the
      // transaction. On a transport/timeout error the node may have accepted
      // it — and some RPC "errors" mean the node already HAS it (see
      // txMayBeAccepted) — so in both cases keep the spend pending:
      // discarding here could let a retry (or an operator reacting to a
      // false "failed") double-spend or double-pay. Recover per
      // docs/deployment.md: wait for the txid to confirm or clearly
      // disappear, then finalize/discard.
      if (err instanceof RpcError && !txMayBeAccepted(err)) {
        this.discardTransaction(tx.txid);
      } else if (err && typeof err === 'object') {
        // Ambiguous failure: the notes stay pending. Attach the txid so the
        // operator can reconcile (confirm on-chain, then finalize/discard).
        (err as { txid?: string }).txid = tx.txid;
      }
      throw err;
    }
  }

  /** Mark a broadcast transaction's notes as spent. */
  finalizeTransaction(txid: string): void {
    const nullifiers = this.pendingSpends.get(txid);
    if (!nullifiers) return;
    const spent = new Set(nullifiers);
    this.notes = this.notes.filter((n) => !spent.has(n.nullifier));
    this.pendingSpends.delete(txid);
  }

  /** Release a failed transaction's notes back to the spendable set. */
  discardTransaction(txid: string): void {
    this.pendingSpends.delete(txid);
  }

  /**
   * Transactions built and broadcast but not yet finalized or discarded
   * (txid → the nullifiers they spend). After a broadcast error left a spend
   * ambiguous, use this to find the txid, confirm it on-chain, then
   * {@link finalizeTransaction} or {@link discardTransaction}.
   */
  pendingTransactions(): Record<string, string[]> {
    return Object.fromEntries(this.pendingSpends);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Serialize wallet state to JSON. The spending key is deliberately
   * excluded — persist it separately (encrypted) and restore with
   * {@link loadSpendingKey}.
   */
  save(): string {
    const state: WalletState = {
      version: 1,
      network: this.network,
      extfvk: this.extfvk,
      lastProcessedBlock: this.lastProcessedBlock,
      commitmentTree: this.commitmentTree,
      diversifierIndex: this.diversifierIndex,
      notes: this.notes,
      nullifierMap: Object.fromEntries(this.nullifierMap),
      pendingSpends: Object.fromEntries(this.pendingSpends),
    };
    return JSON.stringify(state);
  }

  /**
   * Restore a wallet from {@link save} output.
   *
   * For a watch-only deposit scanner, pass `opts.expectedViewingKey` (the key
   * you know this wallet should have): a tampered state file that swapped in
   * an attacker's viewing key would otherwise silently repoint deposit
   * addresses to the attacker. Saved-state integrity is theft-critical here.
   */
  static async load(
    json: string,
    opts: { proving?: ProvingOptions; expectedViewingKey?: string } = {},
  ): Promise<PivxWallet> {
    let state: WalletState;
    try {
      state = JSON.parse(json) as WalletState;
    } catch {
      throw new Error('wallet state is not valid JSON');
    }
    if (state === null || typeof state !== 'object') throw new Error('wallet state is not an object');
    if (state.version !== 1) throw new Error(`unsupported wallet state version ${state.version}`);
    if (state.network !== 'mainnet' && state.network !== 'testnet') {
      throw new Error('wallet state has an invalid network');
    }
    if (typeof state.extfvk !== 'string' || typeof state.commitmentTree !== 'string') {
      throw new Error('wallet state is missing keys or commitment tree');
    }
    if (opts.expectedViewingKey !== undefined && opts.expectedViewingKey !== state.extfvk) {
      throw new Error('wallet state viewing key does not match the expected key');
    }
    // Bound the sync position to [0, 2^53-1] (isSafeInteger caps the top;
    // reject negatives), symmetric with scan/handleBlocks height bounds so
    // downstream block_height math can't underflow on a tampered state.
    if (!Number.isSafeInteger(state.lastProcessedBlock) || state.lastProcessedBlock < 0 || !Array.isArray(state.notes)) {
      throw new Error('wallet state has an invalid sync position or notes');
    }
    for (const n of state.notes) {
      if (typeof n?.nullifier !== 'string' || !Number.isSafeInteger(n?.note?.value) || n.note.value < 0) {
        throw new Error('wallet state contains a malformed note');
      }
    }
    if (
      !Array.isArray(state.diversifierIndex) ||
      state.diversifierIndex.length !== 11 ||
      !state.diversifierIndex.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
    ) {
      throw new Error('wallet state has an invalid diversifier index');
    }
    if (state.pendingSpends !== undefined && (typeof state.pendingSpends !== 'object' || state.pendingSpends === null)) {
      throw new Error('wallet state has an invalid pending-spends map');
    }
    // Shape-check the entries too (the Rust SDK's typed deserialization
    // rejects these for free): pendingSpends values are arrays of nullifier
    // strings, nullifierMap values carry a recipient string and a sat value.
    for (const [txid, nulls] of Object.entries(state.pendingSpends ?? {})) {
      if (!Array.isArray(nulls) || !nulls.every((n) => typeof n === 'string')) {
        throw new Error(`wallet state has a malformed pending-spends entry: ${txid}`);
      }
    }
    if (state.nullifierMap !== undefined && (typeof state.nullifierMap !== 'object' || state.nullifierMap === null)) {
      throw new Error('wallet state has an invalid nullifier map');
    }
    for (const [nf, entry] of Object.entries(state.nullifierMap ?? {})) {
      if (
        typeof entry?.recipient !== 'string' ||
        !Number.isSafeInteger(entry?.value) ||
        entry.value < 0
      ) {
        throw new Error(`wallet state has a malformed nullifier-map entry: ${nf}`);
      }
    }
    const shield = await loadShield(opts.proving);
    // Confirm the viewing key decodes for this network before trusting it to
    // derive receive addresses (a tampered state could otherwise repoint
    // deposits to an attacker's key).
    try {
      shield.generate_default_payment_address(state.extfvk, state.network === 'testnet');
    } catch {
      throw new Error('wallet state has an invalid viewing key for its network');
    }
    const wallet = new PivxWallet(
      shield,
      state.network,
      state.extfvk,
      state.commitmentTree,
      state.lastProcessedBlock,
      state.diversifierIndex,
    );
    wallet.notes = state.notes;
    wallet.nullifierMap = new Map(Object.entries(state.nullifierMap ?? {}));
    wallet.pendingSpends = new Map(Object.entries(state.pendingSpends ?? {}));
    return wallet;
  }

  private encodeRecipient(recipient: number[]): string {
    return this.shield.encode_payment_address(
      this.isTestnet,
      new Uint8Array(recipient),
    ) as string;
  }
}
