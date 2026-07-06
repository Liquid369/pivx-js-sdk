/**
 * Transparent (non-shielded) HD wallet: BIP32/44 key derivation and PIVX
 * address encoding/decoding for P2PKH, cold-staking, and exchange addresses.
 *
 * Keys derive under BIP44 m/44'/119'/account'/change/index (coin type 119
 * mainnet, 1 testnet). Addresses are base58check with network-specific
 * version prefixes (from chainparams).
 */
import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

export type Network = 'mainnet' | 'testnet';
export type AddressKind = 'p2pkh' | 'p2sh' | 'staking' | 'exchange';

const b58c = base58check(sha256);

/** base58 version prefix bytes per network + kind (from chainparams.cpp). */
const PREFIX: Record<Network, Record<AddressKind, number[]>> = {
  mainnet: { p2pkh: [30], p2sh: [13], staking: [63], exchange: [0x01, 0xb9, 0xa2] },
  testnet: { p2pkh: [139], p2sh: [19], staking: [73], exchange: [0x01, 0xb9, 0xb1] },
};
const COIN_TYPE: Record<Network, number> = { mainnet: 119, testnet: 1 };
const WIF_PREFIX: Record<Network, number> = { mainnet: 212, testnet: 239 };

/** hash160 = RIPEMD160(SHA256(data)). */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/** Encode a 20-byte hash as a PIVX base58check address of the given kind. */
export function encodeAddress(hash: Uint8Array, network: Network, kind: AddressKind): string {
  if (hash.length !== 20) throw new Error('hash must be 20 bytes');
  const prefix = PREFIX[network][kind];
  return b58c.encode(Uint8Array.from([...prefix, ...hash]));
}

/** P2PKH address for a compressed public key. */
export function p2pkhAddress(pubkey: Uint8Array, network: Network): string {
  return encodeAddress(hash160(pubkey), network, 'p2pkh');
}

export interface DecodedAddress {
  hash: Uint8Array;
  kind: AddressKind;
  network: Network;
}

/** Decode and validate a PIVX transparent address, identifying kind + network. */
export function decodeAddress(address: string): DecodedAddress {
  let data: Uint8Array;
  try {
    data = b58c.decode(address);
  } catch {
    throw new Error(`invalid address: ${address}`);
  }
  for (const network of ['mainnet', 'testnet'] as Network[]) {
    for (const kind of ['p2pkh', 'p2sh', 'staking', 'exchange'] as AddressKind[]) {
      const prefix = PREFIX[network][kind];
      if (data.length === prefix.length + 20 && prefix.every((b, i) => data[i] === b)) {
        return { hash: data.slice(prefix.length), kind, network };
      }
    }
  }
  throw new Error(`invalid address: ${address}`);
}

/** True if `address` is a well-formed PIVX transparent address. */
export function isValidAddress(address: string): boolean {
  try {
    decodeAddress(address);
    return true;
  } catch {
    return false;
  }
}

/** A derived transparent key. */
export interface TransparentKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  network: Network;
  address: string;
  /** WIF (compressed) encoding, for import into other tools. */
  wif: string;
}

/**
 * Derive the BIP44 transparent key at m/44'/coin'/account'/change/index.
 * `change` is 0 for external (receive) addresses, 1 for internal (change).
 */
export function deriveKey(
  seed: Uint8Array,
  network: Network,
  account: number,
  change: number,
  index: number,
): TransparentKey {
  // Root-cause seed-length gate: the transparent constructors route through
  // here, so validating the 32/64-byte contract at the top of deriveKey covers
  // every caller (BIP32 uses the FULL seed). Same text as the constructors.
  if (seed.length !== 32 && seed.length !== 64) {
    throw new Error('seed must be 32 bytes (raw) or 64 bytes (BIP39)');
  }
  // Range-check before derivation: `account` is hardened, so a value >= 2^31
  // would (in the Rust twin's `account | HARDENED`) alias a lower account and
  // emit a state load() rejects; change/index are non-hardened u32. Reject
  // out-of-range or non-integer values with a labeled error rather than
  // deriving a silently-wrong key.
  if (!Number.isInteger(account) || account < 0 || account >= 0x8000_0000) {
    throw new Error(`account must be an integer in [0, 2^31-1] (BIP32 hardened range), got ${account}`);
  }
  if (!Number.isInteger(change) || change < 0 || change > 0xffff_ffff) {
    throw new Error(`change must be an integer in [0, 2^32-1], got ${change}`);
  }
  if (!Number.isInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new Error(`index must be an integer in [0, 2^32-1], got ${index}`);
  }
  const master = HDKey.fromMasterSeed(seed);
  const child = master.derive(`m/44'/${COIN_TYPE[network]}'/${account}'/${change}/${index}`);
  if (!child.privateKey || !child.publicKey) throw new Error('key derivation failed');
  const wif = b58c.encode(Uint8Array.from([WIF_PREFIX[network], ...child.privateKey, 0x01]));
  return {
    privateKey: child.privateKey,
    publicKey: child.publicKey, // compressed
    network,
    address: p2pkhAddress(child.publicKey, network),
    wif,
  };
}
