/** Amounts are JSON numbers in PIV (8 decimal places), exactly as the node emits them. */

/** Unspent shielded note, as returned by `listshieldunspent`. */
export interface ShieldNote {
  txid: string;
  outindex: number;
  confirmations: number;
  /** True if the wallet holds the spending key (false for watch-only viewing keys). */
  spendable: boolean;
  address: string;
  amount: number;
  /** Hex-encoded memo, trailing zero bytes trimmed. */
  memo: string;
  /** Present when the wallet can determine change status. */
  change?: boolean;
  nullifier?: string;
}

/** Received note, as returned by `listreceivedbyshieldaddress`. */
export interface ReceivedShieldNote {
  txid: string;
  amount: number;
  memo: string;
  outindex: number;
  confirmations: number;
  blockheight: number;
  blockindex: number;
  blocktime: number;
  change?: boolean;
}

/** Recipient entry for `shieldsendmany` / `rawshieldsendmany`. */
export interface ShieldRecipient {
  address: string;
  amount: number;
  /** UTF-8 message, max 512 bytes. Only valid for shield addresses. */
  memo?: string;
}

/** Decrypted view of a shielded transaction (`viewshieldtransaction`). */
export interface ShieldTxView {
  txid: string;
  fee: number;
  spends: {
    spend: number;
    txidPrev: string;
    outputPrev: number;
    address: string;
    value: number;
    valueSat: number;
  }[];
  outputs: {
    output: number;
    outgoing: boolean;
    address: string;
    value: number;
    valueSat: number;
    memo: string;
    memoStr?: string;
  }[];
}

/** Source for `shieldsendmany`: an address, or one of the selector strings. */
export type ShieldSendSource =
  | 'from_transparent'
  | 'from_shield'
  | 'from_trans_cold'
  | (string & {});

export interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  difficulty: number;
  verificationprogress: number;
  initial_block_downloading: boolean;
  [key: string]: unknown;
}

export interface WalletInfo {
  walletname: string;
  walletversion: number;
  balance: number;
  delegated_balance: number;
  cold_staking_balance: number;
  shield_balance?: number;
  unconfirmed_balance: number;
  immature_balance: number;
  txcount: number;
  [key: string]: unknown;
}

export interface Unspent {
  txid: string;
  vout: number;
  address: string;
  amount: number;
  confirmations: number;
  spendable: boolean;
  scriptPubKey: string;
  [key: string]: unknown;
}
