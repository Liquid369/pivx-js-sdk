/**
 * Transparent wallet: HD address management, UTXO tracking (from a block scan
 * or caller-supplied), coin selection, and sending. Complements the shielded
 * PivxWallet; both derive from the seed.
 *
 * PIVX has no address index, so UTXOs are discovered either by scanning blocks
 * ({@link scan}) or supplied by the caller ({@link addUtxo}).
 */
import type { PivxClient } from 'pivx-rpc';
import { deriveKey, encodeAddress, hash160, type Network } from './transparent.js';
import { buildTransparentTx, scriptPubKeyForAddress, type TxInput } from './transparent-tx.js';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A tracked unspent transparent output we can spend. */
export interface OwnedUtxo {
  txid: string;
  vout: number;
  amount: number;
  scriptPubKey: Uint8Array;
  keyHash: string; // hex hash160 of the controlling key
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

/** hash160 of a standard P2PKH scriptPubKey (76a914<20>88ac), if it is one. */
function p2pkhHash(script: Uint8Array): string | undefined {
  if (
    script.length === 25 &&
    script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 &&
    script[23] === 0x88 && script[24] === 0xac
  ) {
    return hex(script.slice(3, 23));
  }
  return undefined;
}

export class TransparentWallet {
  private keys = new Map<string, Uint8Array>(); // hex hash160 → privkey
  private external: { hash: string; address: string }[] = [];
  private change: string[] = [];
  private nextExternal = 0;
  private nextChange = 0;
  private utxos = new Map<string, OwnedUtxo>(); // "txid:vout" → utxo
  private lastScanned = 0; // height of the last block passed to scanBlock

  private constructor(private readonly network: Network) {}

  /**
   * Derive `gap` external and `gap` change addresses from `seed` under
   * `account`. Only outputs to these addresses are recognized.
   */
  static create(seed: Uint8Array, network: Network, account = 0, gap = 100): TransparentWallet {
    const w = new TransparentWallet(network);
    for (let i = 0; i < gap; i++) {
      const ext = deriveKey(seed, network, account, 0, i);
      const eh = hex(hash160(ext.publicKey));
      w.external.push({ hash: eh, address: ext.address });
      w.keys.set(eh, ext.privateKey);
      const ch = deriveKey(seed, network, account, 1, i);
      const chh = hex(hash160(ch.publicKey));
      w.change.push(chh);
      w.keys.set(chh, ch.privateKey);
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

  private nextChangeHash(): string {
    const h = this.change[this.nextChange];
    if (!h) throw new Error('change gap limit reached; increase gap');
    this.nextChange++;
    return h;
  }

  /** Add a caller-supplied UTXO if it pays one of our addresses. Returns true if ours. */
  addUtxo(txid: string, vout: number, amount: number, scriptPubKey: Uint8Array): boolean {
    const h = p2pkhHash(scriptPubKey);
    if (h && this.keys.has(h)) {
      this.utxos.set(`${txid}:${vout}`, { txid, vout, amount, scriptPubKey, keyHash: h });
      return true;
    }
    return false;
  }

  /** Apply a scanned block's transparent outputs (added if ours) and spent inputs (removed). */
  scan(outputs: ScannedOutput[], spent: ScannedInput[]): void {
    for (const o of outputs) this.addUtxo(o.txid, o.vout, o.amount, o.scriptPubKey);
    for (const s of spent) this.utxos.delete(`${s.txid}:${s.vout}`);
  }

  /**
   * Scan one decoded block (`getblock <hash> 2`): credit every output that
   * pays us and remove every tracked UTXO the block spends. Coinbase vins (no
   * prevout `txid`) are skipped. Records the block's height as last scanned.
   */
  scanBlock(block: any): void {
    if (typeof block.height === 'number') this.lastScanned = block.height;
    for (const tx of block.tx ?? []) {
      for (const o of tx.vout ?? []) {
        const script = Uint8Array.from((o.scriptPubKey.hex.match(/../g) ?? []).map((b: string) => parseInt(b, 16)));
        this.addUtxo(tx.txid, o.n, Math.round(o.value * 1e8), script);
      }
      for (const i of tx.vin ?? []) {
        if (i.txid !== undefined) this.utxos.delete(`${i.txid}:${i.vout}`);
      }
    }
  }

  /** Height of the last block passed to {@link scanBlock} (0 if none). */
  lastScannedBlock(): number {
    return this.lastScanned;
  }

  /**
   * Sync from the node into the wallet, from `max(fromHeight, lastScanned+1)`
   * up to the current tip, fetching each block with getBlockHash +
   * getBlock(hash, 2) and feeding it to {@link scanBlock}. Blocks are fetched
   * with bounded concurrency but scanned in ascending order.
   *
   * Like the shield wallet's sync this is a chain-data pull, not chain
   * authentication: point it at a node you trust. See SECURITY.md.
   */
  async sync(
    client: PivxClient,
    { fromHeight = 0, batchSize = 100, onProgress }: {
      fromHeight?: number;
      batchSize?: number;
      onProgress?: (height: number, tip: number) => void;
    } = {},
  ): Promise<void> {
    const concurrency = 8;
    const tip = await client.getBlockCount();
    const fetchBlock = async (h: number) => client.getBlock(await client.getBlockHash(h), 2);
    let from = Math.max(fromHeight, this.lastScanned + 1);
    while (from <= tip) {
      const to = Math.min(from + batchSize - 1, tip);
      const heights = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      for (let i = 0; i < heights.length; i += concurrency) {
        const blocks = await Promise.all(heights.slice(i, i + concurrency).map(fetchBlock));
        for (const block of blocks) this.scanBlock(block);
      }
      onProgress?.(to, tip);
      from = to + 1;
    }
  }

  /** Total tracked transparent balance in satoshis. */
  balance(): number {
    return [...this.utxos.values()].reduce((s, u) => s + u.amount, 0);
  }

  getUtxos(): readonly OwnedUtxo[] {
    return [...this.utxos.values()];
  }

  private static estSize(nIn: number, nOut: number): number {
    return nIn * 148 + nOut * 34 + 10;
  }

  /**
   * Build and sign a transparent send of `amount` sats to `to`, selecting
   * UTXOs largest-first with change to a fresh change address. `feePerByte`
   * defaults to 100 sats/byte. Returns the raw tx hex and the spent inputs.
   */
  buildSend(
    to: string,
    amount: number,
    feePerByte = 100,
  ): { hex: string; spent: { txid: string; vout: number }[] } {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount must be a positive integer (satoshis)');
    const feerate = feePerByte;
    const avail = [...this.utxos.values()].sort((a, b) => b.amount - a.amount);
    const selected: OwnedUtxo[] = [];
    let total = 0;
    for (const u of avail) {
      selected.push(u);
      total += u.amount;
      if (total >= amount + feerate * TransparentWallet.estSize(selected.length, 2)) break;
    }
    const fee = feerate * TransparentWallet.estSize(selected.length, 2);
    if (total < amount + fee) throw new Error('insufficient transparent balance to cover amount + fee');
    const changeVal = total - amount - fee;

    const outputs = [{ address: to, amount }];
    if (changeVal > feerate * 148) {
      const chAddr = encodeAddress(
        Uint8Array.from(this.nextChangeHash().match(/../g)!.map((b) => parseInt(b, 16))),
        this.network,
        'p2pkh',
      );
      outputs.push({ address: chAddr, amount: changeVal });
    }

    const inputs: TxInput[] = selected.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      amount: u.amount,
      scriptPubKey: u.scriptPubKey,
      privateKey: this.keys.get(u.keyHash)!,
    }));
    const spent = selected.map((u) => ({ txid: u.txid, vout: u.vout }));
    return { hex: buildTransparentTx(inputs, outputs, 0), spent };
  }

  /** Mark inputs spent after a successful broadcast. */
  markSpent(spent: { txid: string; vout: number }[]): void {
    for (const s of spent) this.utxos.delete(`${s.txid}:${s.vout}`);
  }
}

export { scriptPubKeyForAddress };
