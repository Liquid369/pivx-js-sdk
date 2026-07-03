/** Amounts in this package are integer satoshis (1 PIV = 1e8), the unit of
 * the underlying shield library — unlike the `pivx-rpc` layer, which uses
 * PIV floats as the node emits them. */

/** A decrypted shielded note the wallet can track (and spend, with a spending key). */
export interface SpendableNote {
  /** Opaque note object from the shield library (JSON-serializable). */
  note: { value: number; recipient: number[]; rseed: unknown };
  /** Hex-serialized incremental merkle witness. */
  witness: string;
  /** Hex nullifier — how spends of this note are recognized on-chain. */
  nullifier: string;
  /** Decoded text memo, when the note carried one. */
  memo?: string | null;
}

/** A block to scan: raw tx hexes plus the block height. */
export interface WalletBlock {
  height: number;
  txs: { hex: string; txid: string }[];
}

/** Transparent UTXO used as input when shielding funds. */
export interface TransparentInput {
  txid: string;
  vout: number;
  amount: number;
  /** 32-byte private key controlling the UTXO. */
  private_key: Uint8Array;
  /** scriptPubKey bytes of the UTXO. */
  script: Uint8Array;
}

export interface CreateWalletOptions {
  /** 32 bytes of seed entropy (derives the spending key; full capability). */
  seed?: Uint8Array;
  /** Bech32 extended spending key (`p-secret-spending-key-…`; full capability). */
  spendingKey?: string;
  /** Bech32 extended full viewing key (watch-only: scan/receive, no spending). */
  viewingKey?: string;
  network?: 'mainnet' | 'testnet';
  /** Wallet birth height: scanning starts at the nearest checkpoint at or below it. */
  birthHeight: number;
  /** ZIP32 account index under the seed. Default 0. */
  accountIndex?: number;
  /**
   * Proving backend. Defaults to single-core WASM. Set `multicore: true` to
   * use the parallel WASM build (browser only, needs cross-origin isolation).
   * For server-side proving, use the native Rust SDK instead.
   */
  proving?: import('./shield-bindings.js').ProvingOptions;
}

export interface CreateTransactionOptions {
  /** Recipient: shield (ps1…) or transparent address. */
  to: string;
  /** Amount in satoshis. */
  amount: number;
  /** UTF-8 memo (shield recipients only, max 512 bytes). */
  memo?: string;
  /**
   * Inputs: 'shield' (default) spends the wallet's notes; pass transparent
   * UTXOs instead to shield transparent funds.
   */
  inputs?: 'shield' | TransparentInput[];
  /** Required when spending transparent inputs (change must stay transparent). */
  transparentChangeAddress?: string;
  /**
   * Opt in to sweep semantics: allow the amount to consume the entire
   * spendable balance, paying the fee out of the recipient's amount.
   * Without this, an amount that leaves no room for the fee is rejected.
   */
  sweep?: boolean;
}

export interface BuiltTransaction {
  txid: string;
  /** Fully-proved raw transaction hex, ready for `sendrawtransaction`. */
  hex: string;
  /** Nullifiers this tx spends (tracked as pending until finalize/discard). */
  nullifiers: string[];
}

export interface SyncOptions {
  /** Blocks per root-check batch. Default 100. */
  batchSize?: number;
  /**
   * Max concurrent block fetches. Default 8. Keep well under the node's
   * rpcworkqueue (default 16) — a full batch fired at once returns 500s.
   */
  rpcConcurrency?: number;
  onProgress?: (height: number, tip: number) => void;
  /**
   * Abort the sync. Checked at every batch and concurrency-chunk boundary,
   * before the next round of RPCs is issued; when set, sync throws
   * `signal.reason` (an `AbortError` DOMException by default). State stays
   * consistent: only fully applied, root-verified batches are kept, and the
   * busy guard is released so a follow-up sync can resume where it stopped.
   */
  signal?: AbortSignal;
}

/** Serialized wallet state (spending key deliberately excluded). */
export interface WalletState {
  version: 1;
  network: 'mainnet' | 'testnet';
  extfvk: string;
  lastProcessedBlock: number;
  commitmentTree: string;
  diversifierIndex: number[];
  notes: SpendableNote[];
  nullifierMap: Record<string, { recipient: string; value: number }>;
  /** txid → nullifiers for broadcast-but-unconfirmed spends. */
  pendingSpends?: Record<string, string[]>;
}
