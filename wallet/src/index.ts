export { PivxWallet, NoSpendAuthorityError, ScanDivergedError } from './wallet.js';
export {
  deriveKey,
  p2pkhAddress,
  encodeAddress,
  decodeAddress,
  isValidAddress,
  hash160,
  type AddressKind,
  type DecodedAddress,
  type TransparentKey,
} from './transparent.js';
export {
  buildTransparentTx,
  scriptPubKeyForAddress,
  type TxInput,
  type TxOutput,
} from './transparent-tx.js';
export {
  TransparentWallet,
  type OwnedUtxo,
  type ScannedOutput,
  type ScannedInput,
} from './transparent-wallet.js';
export type { ProvingOptions } from './shield-bindings.js';
export type {
  SpendableNote,
  WalletBlock,
  TransparentInput,
  CreateWalletOptions,
  CreateTransactionOptions,
  BuiltTransaction,
  SyncOptions,
  WalletState,
} from './types.js';
