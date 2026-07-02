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
