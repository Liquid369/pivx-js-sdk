import type { PivxClient } from './client.js';
import type { ShieldNote } from './types.js';

export interface ShieldWatcherOptions {
  /** Poll interval in ms. PIVX targets 60s blocks; default 15000. */
  pollIntervalMs?: number;
  /** Only consider notes with at least this many confirmations. Default 1. */
  minConf?: number;
  /** Restrict watching to these shield addresses. Default: all wallet addresses. */
  addresses?: string[];
  /** Include watch-only (viewing key) addresses. Default true — that's the point. */
  includeWatchOnly?: boolean;
}

export interface ShieldWatcherEvents {
  /** A shielded note appeared (incoming funds, or change). */
  note: (note: ShieldNote) => void;
  /** A previously-seen note is no longer unspent. */
  spent: (note: ShieldNote) => void;
  /** Total shield balance changed. */
  balance: (balance: number, previous: number) => void;
  /** A new best block was processed. */
  block: (hash: string) => void;
  error: (err: Error) => void;
}

/**
 * Minimal typed event emitter (the subset of node:events the watcher needs)
 * so importing this package does not pull in Node built-ins — browser
 * bundlers can consume it as-is. Unlike node's EventEmitter it never throws
 * on an unhandled 'error' event.
 */
class Emitter<Events extends { [E in keyof Events]: (...args: never[]) => void }> {
  private listeners = new Map<keyof Events, Events[keyof Events][]>();

  on<E extends keyof Events>(event: E, listener: Events[E]): this {
    const list = this.listeners.get(event);
    if (list) list.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  once<E extends keyof Events>(event: E, listener: Events[E]): this {
    const wrap = ((...args: Parameters<Events[E]>) => {
      this.off(event, wrap);
      (listener as (...a: Parameters<Events[E]>) => void)(...args);
    }) as Events[E];
    // Back-reference so off(listener) also removes a once(listener)
    // registration, matching node's EventEmitter.
    (wrap as { listener?: Events[E] }).listener = listener;
    return this.on(event, wrap);
  }

  off<E extends keyof Events>(event: E, listener: Events[E]): this {
    const list = this.listeners.get(event);
    const i =
      list?.findIndex((l) => l === listener || (l as { listener?: Events[E] }).listener === listener) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
    return this;
  }

  emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): boolean {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return false;
    for (const l of [...list]) (l as (...a: Parameters<Events[E]>) => void)(...args);
    return true;
  }

  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

const noteKey = (n: ShieldNote) => `${n.txid}:${n.outindex}`;

/**
 * Polls the node and emits events when shielded notes appear, are spent,
 * or the total shield balance changes.
 *
 * Watch-only caveat (from the node itself): with only incoming viewing keys
 * imported, spends cannot be detected, so `spent` events and balance
 * decreases only fire for addresses whose spending key is in the wallet.
 */
export class ShieldWatcher extends Emitter<ShieldWatcherEvents> {
  private notes = new Map<string, ShieldNote>();
  private lastHash = '';
  private lastBalance = NaN;
  /** Integer-satoshi mirror of lastBalance: change detection must not fire on
   * FP noise in the PIV-float sum (0.1 + 0.2 !== 0.3). */
  private lastBalanceSats = NaN;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private primed = false;

  constructor(
    private readonly client: PivxClient,
    private readonly opts: ShieldWatcherOptions = {},
  ) {
    super();
  }

  /** Begin polling. The first poll primes state without emitting note events. */
  start(): this {
    if (this.timer) return this;
    const interval = this.opts.pollIntervalMs ?? 15000;
    this.timer = setInterval(() => void this.poll(), interval);
    this.timer.unref?.();
    void this.poll();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One polling pass. Exposed for callers that want their own scheduling. */
  async poll(): Promise<void> {
    if (this.polling) return; // skip overlapping polls rather than queueing them
    this.polling = true;
    try {
      const hash = await this.client.getBestBlockHash();
      if (hash === this.lastHash) return;

      const notes = await this.client.listShieldUnspent(
        this.opts.minConf ?? 1,
        9999999,
        this.opts.includeWatchOnly ?? true,
        this.opts.addresses,
      );

      const current = new Map(notes.map((n) => [noteKey(n), n]));
      if (this.primed) {
        for (const [key, note] of current) {
          if (!this.notes.has(key)) this.emit('note', note);
        }
        for (const [key, note] of this.notes) {
          if (!current.has(key)) this.emit('spent', note);
        }
      }
      this.notes = current;

      const balance = notes.reduce((sum, n) => sum + n.amount, 0);
      // Detect change on the true satoshi sum; the event payload stays PIV.
      const balanceSats = notes.reduce((sum, n) => sum + Math.round(n.amount * 1e8), 0);
      if (this.primed && balanceSats !== this.lastBalanceSats) {
        this.emit('balance', balance, this.lastBalance);
      }
      this.lastBalance = balance;
      this.lastBalanceSats = balanceSats;
      this.lastHash = hash;
      this.primed = true;
      this.emit('block', hash);
    } catch (err) {
      // A poller must not crash the process on a transient RPC blip, so only
      // emit when someone is listening; otherwise swallow (the next poll
      // retries).
      if (this.listenerCount('error') > 0) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.polling = false;
    }
  }

  /** Currently-known unspent shielded notes. */
  get unspent(): ShieldNote[] {
    return [...this.notes.values()];
  }

  /** Sum of currently-known unspent notes (PIV). */
  get balance(): number {
    return Number.isNaN(this.lastBalance) ? 0 : this.lastBalance;
  }
}

/**
 * Convenience: import a Sapling incoming viewing key and return a started
 * watcher for its address. `height` limits the rescan range (faster).
 */
export async function watchViewingKey(
  client: PivxClient,
  vkey: string,
  opts: ShieldWatcherOptions & { rescan?: 'yes' | 'no' | 'whenkeyisnew'; height?: number } = {},
): Promise<{ address: string; watcher: ShieldWatcher }> {
  const { rescan, height, ...watcherOpts } = opts;
  const { address } = await client.importSaplingViewingKey(vkey, rescan ?? 'whenkeyisnew', height);
  const watcher = new ShieldWatcher(client, {
    ...watcherOpts,
    addresses: watcherOpts.addresses ?? [address],
  }).start();
  return { address, watcher };
}
