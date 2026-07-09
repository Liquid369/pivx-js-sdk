/**
 * Build and sign transparent PIVX transactions in the SAPLING (v3) format.
 *
 * PIVX serializes int16 nVersion, int16 nType, vin, vout, nLockTime, then
 * (sapling versions only) sapData — see src/primitives/transaction.h. A v3
 * transparent tx (nVersion=3, nType=0) carries an EMPTY-but-present sapData
 * block and is signed with SIGVERSION_SAPLING, whose sighash COMMITS the input
 * amount (src/script/interpreter.cpp SignatureHash). Committing the amount
 * closes S1: a node that misreports a UTXO's value can no longer trick us into
 * signing it away as fee — the wrong amount yields a signature the network
 * rejects instead of a valid tx that burns funds.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { blake2b } from '@noble/hashes/blake2.js';
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

// BLAKE2b personalizations (16 bytes each: ascii, zero-padded). The main one is
// "PIVXSigHash" (11 bytes) + 0x00 + le32(consensusBranchId=0) — and since the
// branch id is currently 0, bytes 11..15 are all zero, exactly what a
// zero-padded "PIVXSigHash" produces. See interpreter.cpp:1106-1232.
const perso = (s: string): Uint8Array => {
  const p = new Uint8Array(16);
  p.set(new TextEncoder().encode(s));
  return p;
};
const PERSO_PREVOUTS = perso('PIVXPrevoutHash');
const PERSO_SEQUENCE = perso('PIVXSequencHash'); // note: "Sequenc", not "Sequence"
const PERSO_OUTPUTS = perso('PIVXOutputsHash');
const PERSO_SIGHASH = perso('PIVXSigHash');
const blake2bPerso = (data: Uint8Array, personalization: Uint8Array): Uint8Array =>
  blake2b(data, { dkLen: 32, personalization });

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

// Empty-but-present sapData for a transparent v3 tx: Optional discriminant 0x01
// || valueBalance(i64=0) || vShieldedSpend count(0) || vShieldedOutput count(0)
// || bindingSig(64 zero bytes). 75 bytes total. From serialize.h:857 Optional +
// sapling_transaction.h:120 SaplingTxData SERIALIZE_METHODS.
const EMPTY_SAPDATA = (() => {
  const w = new Writer();
  w.varint(0x01); // Optional<SaplingTxData> = Some
  w.u64le(0); // valueBalance
  w.varint(0); // vShieldedSpend count
  w.varint(0); // vShieldedOutput count
  w.bytes(new Uint8Array(64)); // bindingSig, all zero
  return w.done();
})();

// nSequence: 0xffffffff marks the tx final, which makes the node IGNORE
// nLockTime (IsFinalTx, src/consensus/tx_verify.cpp). A non-zero locktime
// therefore needs a non-final sequence; 0xfffffffe keeps the locktime
// enforceable without opting in to replacement. The sighash and the broadcast
// serialization MUST agree on this, so both go through here.
const sequenceFor = (locktime: number): number => (locktime !== 0 ? 0xfffffffe : 0xffffffff);

const prevout = (w: Writer, input: TxInput) => {
  const txid = hexToBytes(input.txid);
  if (txid.length !== 32) throw new Error('txid must be 32 bytes');
  w.bytes(txid.reverse()); // internal/LE byte order = reversed display txid
  w.u32le(input.vout);
};

/**
 * scriptPubKey for a destination address (P2PKH, P2SH, or exchange).
 *
 * An exchange address is NOT a plain P2PKH: PIVX prefixes the P2PKH script
 * with OP_EXCHANGEADDR (0xe0) — see GetScriptForDestination in
 * src/script/standard.cpp. Emitting a plain P2PKH would send to the wrong script.
 */
export function scriptPubKeyForAddress(address: string): Uint8Array {
  const d = decodeAddress(address);
  if (d.kind === 'p2pkh') {
    return Uint8Array.from([0x76, 0xa9, 0x14, ...d.hash, 0x88, 0xac]);
  }
  if (d.kind === 'exchange') {
    return Uint8Array.from([0xe0, 0x76, 0xa9, 0x14, ...d.hash, 0x88, 0xac]);
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
  w.u16le(3); // nVersion = 3 (SAPLING)
  w.u16le(0); // nType = 0 (NORMAL)
  w.varint(inputs.length);
  inputs.forEach((input, i) => {
    prevout(w, input);
    w.script(scriptSigs[i]);
    w.u32le(sequenceFor(locktime));
  });
  w.varint(outputs.length);
  for (const [script, value] of outputs) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('output amount must be a non-negative integer (satoshis)');
    w.u64le(value);
    w.script(script);
  }
  w.u32le(locktime);
  w.bytes(EMPTY_SAPDATA);
  return w.done();
}

/**
 * SIGVERSION_SAPLING sighash for one input — the 32-byte BLAKE2b digest that IS
 * the message to sign (NOT double-SHA256). Per interpreter.cpp:1191-1274 for
 * SIGHASH_ALL, no ANYONECANPAY, no sapData. `amount` is committed into the
 * digest: this is the fix for S1.
 */
function sighashDigest(
  inputs: TxInput[],
  outputs: [Uint8Array, number][],
  locktime: number,
  nIn: number,
  scriptCode: Uint8Array,
  amount: number,
): Uint8Array {
  const pw = new Writer();
  for (const input of inputs) prevout(pw, input);
  const hashPrevouts = blake2bPerso(pw.done(), PERSO_PREVOUTS);

  const sw = new Writer();
  for (let i = 0; i < inputs.length; i++) sw.u32le(sequenceFor(locktime));
  const hashSequence = blake2bPerso(sw.done(), PERSO_SEQUENCE);

  const ow = new Writer();
  for (const [script, value] of outputs) { ow.u64le(value); ow.script(script); }
  const hashOutputs = blake2bPerso(ow.done(), PERSO_OUTPUTS);

  const m = new Writer();
  m.u16le(3); // nVersion
  m.u16le(0); // nType
  m.bytes(hashPrevouts);
  m.bytes(hashSequence);
  m.bytes(hashOutputs);
  // No hashShieldedSpends/Outputs/valueBalance: hasSapData is false here.
  // The input being signed: prevout || scriptCode || amount || nSequence.
  prevout(m, inputs[nIn]);
  m.script(scriptCode);
  m.u64le(amount);
  m.u32le(sequenceFor(locktime));
  m.u32le(locktime);
  m.u32le(SIGHASH_ALL); // nHashType (int32 LE)
  return blake2bPerso(m.done(), PERSO_SIGHASH);
}

/** Sapling (v3) sighash for `inputs[inputIndex]`, as hex. Amount-committing. */
export function transparentSighash(inputs: TxInput[], outputs: TxOutput[], inputIndex: number, locktime = 0): string {
  const outScripts: [Uint8Array, number][] = outputs.map((o) => [scriptPubKeyForAddress(o.address), o.amount]);
  const input = inputs[inputIndex];
  return bytesToHex(sighashDigest(inputs, outScripts, locktime, inputIndex, input.scriptPubKey, input.amount));
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
  const scriptSigs: Uint8Array[] = inputs.map(() => new Uint8Array(0));

  inputs.forEach((input, i) => {
    // scriptCode = the prevout's scriptPubKey; the amount is committed.
    const digest = sighashDigest(inputs, outScripts, locktime, i, input.scriptPubKey, input.amount);

    // prehash: false — sign the BLAKE2b sighash directly. Without it, @noble
    // applies its own SHA-256, signing the wrong (re-hashed) value.
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

  const raw = serialize(inputs, scriptSigs, outScripts, locktime);
  // PIVX policy rejects any tx AT or above MAX_STANDARD_TX_SIZE (`sz >=
  // 100000`, src/policy/policy.cpp IsStandardTx), so never return one.
  // Callers estimate sizes before selecting inputs; this re-checks the ACTUAL
  // serialized size as insurance against estimator drift, and runs before the
  // wallet's buildSend reserves anything (it reserves only after this returns).
  if (raw.length >= 100_000) {
    throw new Error(
      'transaction would exceed the 100kB standard size (too many small inputs); consolidate UTXOs first',
    );
  }
  return bytesToHex(raw);
}
