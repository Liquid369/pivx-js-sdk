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
  /** PIV money STRING — the node emits FormatMoney output (e.g. "0.00010000"),
   * not a JSON number. Prefer the integer `valueSat` fields for arithmetic. */
  fee: string;
  spends: {
    spend: number;
    txidPrev: string;
    outputPrev: number;
    address: string;
    /** PIV amount, or the string "unknown" when the wallet cannot recover the
     * note amount (`valueSat` is 0 in that case). */
    value: number | 'unknown';
    valueSat: number;
  }[];
  outputs: {
    output: number;
    outgoing: boolean;
    address: string;
    /** PIV amount, or the string "unknown" when the wallet cannot recover the
     * note amount (`valueSat` is 0 in that case). */
    value: number | 'unknown';
    valueSat: number;
    memo: string;
    memoStr?: string;
  }[];
}

/** `getmasternodecount` result. When the node has no chain tip yet (fresh
 * datadir, still syncing headers) pivxd returns the bare string "unknown"
 * instead of this object; the client surfaces that as a thrown error. */
export interface MasternodeCount {
  total: number;
  stable: number;
  enabled: number;
  inqueue: number;
  ipv4: number;
  ipv6: number;
  onion: number;
  [key: string]: unknown;
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

/** Verbose `getblockheader` result. `previousblockhash`/`nextblockhash` are
 * absent at the genesis block / chain tip respectively; `confirmations` is -1
 * when the header is off the active chain. */
export interface BlockHeader {
  hash: string;
  confirmations: number;
  height: number;
  version: number;
  merkleroot: string;
  time: number;
  mediantime: number;
  nonce: number;
  bits: string;
  difficulty: number;
  chainwork: string;
  acc_checkpoint: string;
  shield_pool_value: { chainValue: number; valueDelta: number };
  previousblockhash?: string;
  nextblockhash?: string;
  chainlock: boolean;
  [key: string]: unknown;
}

/** One entry from `getchaintips`. */
export interface ChainTip {
  height: number;
  hash: string;
  branchlen: number;
  status:
    | 'active'
    | 'invalid'
    | 'headers-only'
    | 'valid-fork'
    | 'valid-headers'
    | 'unknown'
    | (string & {});
  [key: string]: unknown;
}

/** Output script, as embedded in `gettxout` and decoded-tx vouts. `reqSigs`
 * and `addresses` are absent for non-standard / unspendable scripts. */
export interface ScriptPubKey {
  asm: string;
  hex: string;
  reqSigs?: number;
  type: string;
  addresses?: string[];
  [key: string]: unknown;
}

/** `gettxout` result. The node returns `null` (not this object) when the
 * output is spent or not found. */
export interface TxOut {
  bestblock: string;
  /** 0 when the output is only in the mempool. */
  confirmations: number;
  value: number;
  scriptPubKey: ScriptPubKey;
  coinbase: boolean;
  [key: string]: unknown;
}

/** A decoded transaction input. Coinbase inputs carry `coinbase`; all others
 * carry `txid`/`vout`/`scriptSig`. `sequence` is always present. */
export interface TxVin {
  coinbase?: string;
  txid?: string;
  vout?: number;
  scriptSig?: { asm: string; hex: string };
  sequence: number;
  [key: string]: unknown;
}

/** A decoded transaction output. */
export interface TxVout {
  value: number;
  n: number;
  scriptPubKey: ScriptPubKey;
  [key: string]: unknown;
}

/** Decoded transaction (`decoderawtransaction`, and `getrawtransaction`
 * verbose). The block-context fields (`blockhash`/`confirmations`/`time`/
 * `blocktime`) appear only for a confirmed tx on the active chain (requires
 * -txindex for non-wallet txids); a mempool tx has none of them and only
 * `chainlock: false`. `in_active_chain` appears only when a `blockhash`
 * argument was supplied to `getrawtransaction`. */
export interface DecodedTransaction {
  txid: string;
  version: number;
  type: number;
  size: number;
  locktime: number;
  vin: TxVin[];
  vout: TxVout[];
  hex: string;
  chainlock?: boolean;
  in_active_chain?: boolean;
  blockhash?: string;
  confirmations?: number;
  time?: number;
  blocktime?: number;
  [key: string]: unknown;
}

/** Input entry for `createrawtransaction`. */
export interface TxInput {
  txid: string;
  vout: number;
  sequence?: number;
}

/** Previous-output entry for `signrawtransaction`. */
export interface PrevTx {
  txid: string;
  vout: number;
  scriptPubKey: string;
  redeemScript?: string;
  amount: number;
}

/** A per-input signing error from `signrawtransaction`. */
export interface SignError {
  txid: string;
  vout: number;
  scriptSig: string;
  sequence: number;
  error: string;
}

/** `signrawtransaction` result. `errors` is present only when non-empty. */
export interface SignRawTransactionResult {
  hex: string;
  complete: boolean;
  errors?: SignError[];
  [key: string]: unknown;
}

/** One entry from `listtransactions` / `listsinceblock`, or an element of
 * `gettransaction.details`. `category`, `amount` and `vout` are always
 * present; the embedded wallet-tx fields (`txid`, `confirmations`, `time`, …)
 * appear in the long form only, so they are all optional here. */
export interface WalletTransaction {
  involvesWatchonly?: boolean;
  address?: string;
  category: 'send' | 'receive' | 'generate' | 'immature' | 'orphan' | (string & {});
  amount: number;
  label?: string;
  vout: number;
  /** Present for `send` entries. */
  fee?: number;
  confirmations?: number;
  bcconfirmations?: number;
  generated?: boolean;
  blockhash?: string;
  blockindex?: number;
  blocktime?: number;
  trusted?: boolean;
  txid?: string;
  walletconflicts?: string[];
  time?: number;
  timereceived?: number;
  [key: string]: unknown;
}

/** `listsinceblock` result (PIVX has no `removed` array). */
export interface ListSinceBlock {
  transactions: WalletTransaction[];
  lastblock: string;
  [key: string]: unknown;
}

/** `gettransaction` result: the wallet-tx summary plus per-recipient
 * `details`. `fee` is present only when the wallet sent the tx; block-context
 * fields appear only once confirmed. */
export interface TransactionInfo {
  amount: number;
  fee?: number;
  confirmations: number;
  bcconfirmations: number;
  generated?: boolean;
  blockhash?: string;
  blockindex?: number;
  blocktime?: number;
  trusted?: boolean;
  txid: string;
  walletconflicts: string[];
  time: number;
  timereceived: number;
  details: WalletTransaction[];
  hex: string;
  [key: string]: unknown;
}

/** `validateaddress` result. When `isvalid` is false it is the only field.
 * The transparent and shield field sets are mutually exclusive, so both are
 * typed optional; most callers read `isvalid`/`address`/`ismine`. */
export interface ValidateAddress {
  isvalid: boolean;
  address?: string;
  scriptPubKey?: string;
  ismine?: boolean;
  isstaking?: boolean;
  iswatchonly?: boolean;
  isscript?: boolean;
  pubkey?: string;
  iscompressed?: boolean;
  exchangepubkey?: string;
  script?: string;
  hex?: string;
  addresses?: string[];
  sigsrequired?: number;
  label?: string;
  diversifier?: string;
  diversifiedtransmissionkey?: string;
  [key: string]: unknown;
}

/** One network's reachability, from `getnetworkinfo.networks`. */
export interface NetworkEntry {
  name: string;
  limited: boolean;
  reachable: boolean;
  proxy: string;
  proxy_randomize_credentials: boolean;
  [key: string]: unknown;
}

/** A discovered local address, from `getnetworkinfo.localaddresses`. */
export interface LocalAddress {
  address: string;
  port: number;
  score: number;
  [key: string]: unknown;
}

/** `getnetworkinfo` result. `localservices`/`networkactive`/`connections` are
 * absent on some builds; the shape is volatile so unknown fields pass through. */
export interface NetworkInfo {
  version: number;
  subversion: string;
  protocolversion: number;
  localservices?: string;
  timeoffset: number;
  networkactive?: boolean;
  connections?: number;
  networks: NetworkEntry[];
  relayfee: number;
  localaddresses: LocalAddress[];
  warnings: string;
  [key: string]: unknown;
}

/** One peer entry from `getpeerinfo`. Many fields appear only in some
 * connection states (`addrlocal`, `synced_*`, `inflight`, the `verif_mn_*`
 * masternode-verification fields, …), so they are all optional. */
export interface PeerInfo {
  id: number;
  addr: string;
  addrlocal?: string;
  mapped_as?: number;
  services: string;
  lastsend: number;
  lastrecv: number;
  bytessent: number;
  bytesrecv: number;
  conntime: number;
  timeoffset: number;
  pingtime: number;
  pingwait?: number;
  version: number;
  subver: string;
  inbound: boolean;
  addnode: boolean;
  masternode: boolean;
  startingheight: number;
  banscore?: number;
  synced_headers?: number;
  synced_blocks?: number;
  inflight?: number[];
  addr_processed?: number;
  addr_rate_limited?: number;
  whitelisted: boolean;
  bytessent_per_msg: Record<string, number>;
  bytesrecv_per_msg: Record<string, number>;
  masternode_iqr_conn?: boolean;
  verif_mn_proreg_tx_hash?: string;
  verif_mn_operator_pubkey_hash?: string;
  [key: string]: unknown;
}

/** `getmempoolinfo` result. */
export interface MempoolInfo {
  loaded: boolean;
  size: number;
  bytes: number;
  usage: number;
  mempoolminfee: number;
  minrelaytxfee: number;
  [key: string]: unknown;
}

/** One entry from verbose `getrawmempool`. Amounts (`fee`/`modifiedfee`) are
 * PIV numbers, but `descendantfees` is RAW satoshis (an integer), not PIV. */
export interface MempoolEntry {
  size: number;
  fee: number;
  modifiedfee: number;
  time: number;
  height: number;
  descendantcount: number;
  descendantsize: number;
  /** Raw satoshis, not PIV. As with any JS JSON number, values above
   * 2^53 lose precision here; realistic mempool fees stay well below that. */
  descendantfees: number;
  depends: string[];
  [key: string]: unknown;
}

/** `getsupplyinfo` result (PIVX-specific coin-supply totals). */
export interface SupplyInfo {
  updateheight: number;
  transparentsupply: number;
  shieldsupply: number;
  totalsupply: number;
  [key: string]: unknown;
}

/** `getblockindexstats` result. Note the space-separated keys, and that
 * `ttlfee`/`feeperkb` are money STRINGS (FormatMoney), not numbers. */
export interface BlockIndexStats {
  'Starting block': number;
  'Ending block': number;
  txcount: number;
  txcount_all: number;
  txbytes: number;
  /** Money string (FormatMoney), not a number. */
  ttlfee: string;
  /** Money string (FormatMoney), not a number. */
  feeperkb: string;
  [key: string]: unknown;
}

/** `getmininginfo` result. Normal mode emits BOTH `errors` and `warnings`;
 * `generate`/`hashespersec` appear only while the node is generating. */
export interface MiningInfo {
  blocks: number;
  currentblocksize: number;
  currentblocktx: number;
  difficulty: number;
  genproclimit: number;
  networkhashps: number;
  pooledtx: number;
  testnet: boolean;
  chain: string;
  errors: string;
  warnings?: string;
  generate?: boolean;
  hashespersec?: number;
  [key: string]: unknown;
}

/** `estimatesmartfee` result. `feerate` is -1 when there is not enough data
 * to make an estimate. (No `errors` array, unlike Bitcoin Core.) */
export interface EstimateSmartFee {
  feerate: number;
  blocks: number;
  [key: string]: unknown;
}

/** One budget proposal from `getbudgetinfo`. Keys are PascalCase, exactly as
 * the node emits them. `IsInvalidReason` is present only when invalid. */
export interface BudgetProposal {
  Name: string;
  URL: string;
  Hash: string;
  FeeHash: string;
  BlockStart: number;
  BlockEnd: number;
  TotalPaymentCount: number;
  RemainingPaymentCount: number;
  PaymentAddress: string;
  Ratio: number;
  Yeas: number;
  Nays: number;
  Abstains: number;
  TotalPayment: number;
  MonthlyPayment: number;
  IsEstablished: boolean;
  IsValid: boolean;
  IsInvalidReason?: string;
  Allotted: number;
  [key: string]: unknown;
}

/** One entry from `getbudgetprojection`: a proposal plus the running total of
 * budget allotted through it. */
export interface BudgetProjection extends BudgetProposal {
  TotalBudgetAllotted: number;
}

/** `getstakingstatus` result. The `lastattempt_*` fields appear only once the
 * node has attempted to stake. */
export interface StakingStatus {
  staking_status: boolean;
  staking_enabled: boolean;
  coldstaking_enabled: boolean;
  haveconnections: boolean;
  mnsync: boolean;
  walletunlocked: boolean;
  stakeablecoins: number;
  stakingbalance: number;
  stakesplitthreshold: number;
  lastattempt_age?: number;
  lastattempt_depth?: number;
  lastattempt_hash?: string;
  lastattempt_coins?: number;
  lastattempt_tries?: number;
  [key: string]: unknown;
}

/** One entry from `liststakingaddresses`. */
export interface StakingAddress {
  label: string;
  address: string;
  [key: string]: unknown;
}
