/**
 * Build and sign transparent (LEGACY, v1) PIVX transactions.
 *
 * PIVX serializes int16 nVersion, int16 nType, vin, vout, nLockTime, then
 * (sapling versions only) sapData — see src/primitives/transaction.h. For a
 * legacy transparent tx (nVersion=1, nType=0) the leading four bytes are
 * `01 00 00 00` with no sapData, i.e. a standard Bitcoin v1 transaction.
 * Signing is legacy P2PKH SIGHASH_ALL.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeAddress } from './transparent.js';

const SIGHASH_ALL = 1;

export interface TxInput {
  txid: string;
  vout: number;
  amount: number;
  /** scriptPubKey of the output being spent (bytes, as from listunspent hex). */
  scriptPubKey: Uint8Array;
  /** 32-byte private key controlling the input. */
  privateKey: Uint8Array;
}

export interface TxOutput {
  address: string;
  amount: number;
}

const hexToBytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const bytesToHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const doubleSha256 = (d: Uint8Array): Uint8Array => sha256(sha256(d));

class Writer {
  private parts: number[] = [];
  u16le(n: number) { this.parts.push(n & 0xff, (n >> 8) & 0xff); }
  u32le(n: number) { for (let i = 0; i < 4; i++) this.parts.push((n >>> (8 * i)) & 0xff); }
  u64le(n: number) {
    let v = BigInt(n);
    for (let i = 0; i < 8; i++) { this.parts.push(Number(v & 0xffn)); v >>= 8n; }
  }
  varint(n: number) {
    if (n < 0xfd) this.parts.push(n);
    else if (n <= 0xffff) { this.parts.push(0xfd); this.u16le(n); }
    else { this.parts.push(0xfe); this.u32le(n); }
  }
  bytes(b: Uint8Array) { for (const x of b) this.parts.push(x); }
  script(s: Uint8Array) { this.varint(s.length); this.bytes(s); }
  done(): Uint8Array { return Uint8Array.from(this.parts); }
}

/** scriptPubKey for a destination address (P2PKH/exchange, or P2SH). */
export function scriptPubKeyForAddress(address: string): Uint8Array {
  const d = decodeAddress(address);
  if (d.kind === 'p2pkh' || d.kind === 'exchange') {
    return Uint8Array.from([0x76, 0xa9, 0x14, ...d.hash, 0x88, 0xac]);
  }
  if (d.kind === 'p2sh') {
    return Uint8Array.from([0xa9, 0x14, ...d.hash, 0x87]);
  }
  throw new Error('sending to a cold-staking address is not supported');
}

function serialize(
  inputs: TxInput[],
  scriptSigs: Uint8Array[],
  outputs: [Uint8Array, number][],
  locktime: number,
): Uint8Array {
  const w = new Writer();
  w.u16le(1); // nVersion = 1 (LEGACY)
  w.u16le(0); // nType = 0 (NORMAL)
  w.varint(inputs.length);
  inputs.forEach((input, i) => {
    const txid = hexToBytes(input.txid);
    if (txid.length !== 32) throw new Error('txid must be 32 bytes');
    w.bytes(txid.reverse()); // little-endian prevout hash
    w.u32le(input.vout);
    w.script(scriptSigs[i]);
    w.u32le(0xffffffff); // nSequence
  });
  w.varint(outputs.length);
  for (const [script, value] of outputs) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('output amount must be a non-negative integer (satoshis)');
    w.u64le(value);
    w.script(script);
  }
  w.u32le(locktime);
  return w.done();
}

/**
 * Build and sign a transparent transaction; returns raw tx hex for
 * `sendrawtransaction`. Caller selects inputs and includes change as an
 * explicit output; no coin selection or fee computation is done here.
 */
export function buildTransparentTx(inputs: TxInput[], outputs: TxOutput[], locktime = 0): string {
  if (inputs.length === 0) throw new Error('transaction has no inputs');
  for (const input of inputs) {
    if (input.privateKey.length !== 32) throw new Error('private key must be 32 bytes');
    if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
      throw new Error('input amount must be a non-negative integer (satoshis)');
    }
  }
  const outScripts: [Uint8Array, number][] = outputs.map((o) => [scriptPubKeyForAddress(o.address), o.amount]);
  const empty: Uint8Array[] = inputs.map(() => new Uint8Array(0));
  const scriptSigs: Uint8Array[] = inputs.map(() => new Uint8Array(0));

  inputs.forEach((input, i) => {
    // Legacy SIGHASH_ALL preimage: this input's scriptSig = its prevout
    // scriptPubKey, all others empty; append the 4-byte sighash type.
    const preimageSigs = empty.slice();
    preimageSigs[i] = input.scriptPubKey;
    const preimage = serialize(inputs, preimageSigs, outScripts, locktime);
    const w = new Writer();
    w.bytes(preimage);
    w.u32le(SIGHASH_ALL);
    const digest = doubleSha256(w.done());

    // prehash: false — sign the double-SHA256 sighash directly. Without it,
    // @noble applies its own SHA-256 to the input, producing a signature over
    // the wrong (triple-hashed) value that the node rejects.
    const der = secp256k1.sign(digest, input.privateKey, { lowS: true, format: 'der', prehash: false });
    const pubkey = secp256k1.getPublicKey(input.privateKey, true); // compressed
    const ss = new Writer();
    ss.varint(der.length + 1);
    ss.bytes(der);
    ss.bytes(Uint8Array.from([SIGHASH_ALL]));
    ss.varint(pubkey.length);
    ss.bytes(pubkey);
    scriptSigs[i] = ss.done();
  });

  return bytesToHex(serialize(inputs, scriptSigs, outScripts, locktime));
}
