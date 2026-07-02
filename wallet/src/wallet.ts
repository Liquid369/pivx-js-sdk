import type { PivxClient } from 'pivx-rpc';
import { loadShield, type Shield } from './shield-bindings.js';
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

/** Thrown when a watch-only wallet is asked to spend. */
export class NoSpendAuthorityError extends Error {
  constructor() {
    super('wallet is watch-only (viewing key): load a spending key to spend');
    this.name = 'NoSpendAuthorityError';
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
      `sapling root mismatch at height ${height}: wallet state is corrupt or the node is on another chain; ` +
        'recreate the wallet from its keys and resync',
    );
    this.name = 'ScanDivergedError';
  }
}

/** Reverse hex byte order (node displays sapling roots like txids, byte-reversed). */
const reverseHex = (hex: string) => (hex.match(/../g) ?? []).reverse().join('');

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
  /** txid → nullifiers awaiting broadcast confirmation. */
  private pendingSpends = new Map<string, string[]>();
  private diversifierIndex: number[];

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
    const shield = await loadShield();
    const isTestnet = network === 'testnet';

    let extsk: string | undefined;
    if (opts.seed) {
      if (opts.seed.length !== 32) throw new Error('seed must be 32 bytes');
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

    const [, checkpointTree] = shield.get_closest_checkpoint(opts.birthHeight, isTestnet) as [
      number,
      string,
    ];
    const { diversifier_index } = shield.generate_default_payment_address(extfvk, isTestnet) as {
      address: string;
      diversifier_index: number[];
    };

    return new PivxWallet(
      shield,
      network,
      extfvk,
      checkpointTree,
      opts.birthHeight,
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
      .reduce((sum, n) => sum + n.note.value, 0);
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

  // ── Scanning ──────────────────────────────────────────────────────────────

  /**
   * Scan blocks (strictly ascending heights, all above the last synced
   * block). Returns the raw hexes of transactions relevant to this wallet.
   * Use this directly when you have your own block feed; otherwise see
   * {@link sync}.
   */
  handleBlocks(blocks: WalletBlock[]): string[] {
    let prev = this.lastProcessedBlock;
    for (const b of blocks) {
      if (b.height <= prev) {
        throw new Error(`blocks must be strictly ascending and above ${this.lastProcessedBlock}`);
      }
      prev = b.height;
    }
    if (blocks.length === 0) return [];

    const result = this.shield.handle_blocks(
      this.commitmentTree,
      blocks.map((b) => ({ txs: b.txs.map((t) => t.hex) })),
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
    this.notes = [...result.decrypted_notes, ...result.decrypted_new_notes];
    for (const { note, nullifier } of result.decrypted_new_notes) {
      this.nullifierMap.set(nullifier, {
        recipient: this.encodeRecipient(note.recipient),
        value: note.value,
      });
    }
    const spent = new Set(result.nullifiers);
    this.notes = this.notes.filter((n) => !spent.has(n.nullifier));
    this.lastProcessedBlock = blocks[blocks.length - 1].height;
    return result.wallet_transactions;
  }

  /**
   * Decrypt a single transaction's outputs for this wallet without touching
   * wallet state — e.g. 0-conf payment detection from the mempool.
   */
  previewTransaction(hex: string): { recipient: string; value: number; memo?: string | null }[] {
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
   * Sync from the node up to its current tip, verifying the local tree
   * against the node's `finalsaplingroot` each batch.
   */
  async sync(client: PivxClient, opts: SyncOptions = {}): Promise<void> {
    const batchSize = opts.batchSize ?? 100;
    const tip = await client.getBlockCount();
    while (this.lastProcessedBlock < tip) {
      const from = this.lastProcessedBlock + 1;
      const to = Math.min(from + batchSize - 1, tip);
      const heights = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      const blocks = await Promise.all(
        heights.map(async (h) => {
          const hash = await client.getBlockHash(h);
          return client.getBlock(hash, 2) as Promise<{
            height: number;
            finalsaplingroot?: string;
            tx: { hex: string; txid: string }[];
          }>;
        }),
      );
      this.handleBlocks(
        blocks.map((b) => ({ height: b.height, txs: b.tx.map(({ hex, txid }) => ({ hex, txid })) })),
      );

      const nodeRoot = blocks[blocks.length - 1].finalsaplingroot;
      if (nodeRoot) {
        const localRoot = reverseHex(this.shield.get_sapling_root(this.commitmentTree) as string);
        if (localRoot !== nodeRoot) throw new ScanDivergedError(to, localRoot, nodeRoot);
      }
      opts.onProgress?.(to, tip);
    }
  }

  // ── Spending ──────────────────────────────────────────────────────────────

  /** Load sapling proving parameters (required once before building transactions). */
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
      ok = await this.shield.load_prover_with_bytes(output, spend);
    } else if ('url' in source) {
      ok = await this.shield.load_prover_with_url(source.url);
    } else {
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
    if (!(await this.shield.prover_is_loaded())) {
      throw new Error('sapling prover not loaded: call loadProver() first');
    }
    const useShield = opts.inputs === undefined || opts.inputs === 'shield';
    if (!useShield && !opts.transparentChangeAddress) {
      throw new Error('transparentChangeAddress is required when spending transparent inputs');
    }
    const pending = new Set([...this.pendingSpends.values()].flat());
    const changeAddress = useShield ? this.getNewAddress() : opts.transparentChangeAddress!;

    const result = (await this.shield.create_transaction({
      notes: useShield ? this.notes.filter((n) => !pending.has(n.nullifier)) : null,
      utxos: useShield ? null : (opts.inputs as TransparentInput[]),
      extsk: this.extsk,
      to_address: opts.to,
      change_address: changeAddress,
      amount: opts.amount,
      block_height: this.lastProcessedBlock + 1,
      is_testnet: this.isTestnet,
      memo: opts.memo ?? '',
    })) as { txid: string; txhex: string; nullifiers: string[] };

    if (useShield) this.pendingSpends.set(result.txid, result.nullifiers);
    return { txid: result.txid, hex: result.txhex, nullifiers: result.nullifiers };
  }

  /** Build, broadcast, and finalize in one step. */
  async send(client: PivxClient, opts: CreateTransactionOptions): Promise<string> {
    const tx = await this.createTransaction(opts);
    try {
      const txid = await client.sendRawTransaction(tx.hex);
      this.finalizeTransaction(tx.txid);
      return txid;
    } catch (err) {
      this.discardTransaction(tx.txid);
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
    };
    return JSON.stringify(state);
  }

  static async load(json: string): Promise<PivxWallet> {
    const state = JSON.parse(json) as WalletState;
    if (state.version !== 1) {
      throw new Error(`unsupported wallet state version ${state.version}`);
    }
    const shield = await loadShield();
    const wallet = new PivxWallet(
      shield,
      state.network,
      state.extfvk,
      state.commitmentTree,
      state.lastProcessedBlock,
      state.diversifierIndex,
    );
    wallet.notes = state.notes;
    wallet.nullifierMap = new Map(Object.entries(state.nullifierMap));
    return wallet;
  }

  private encodeRecipient(recipient: number[]): string {
    return this.shield.encode_payment_address(
      this.isTestnet,
      new Uint8Array(recipient),
    ) as string;
  }
}
