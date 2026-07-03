import type {
  BlockchainInfo,
  ReceivedShieldNote,
  ShieldNote,
  ShieldRecipient,
  ShieldSendSource,
  ShieldTxView,
  Unspent,
  WalletInfo,
} from './types.js';

export interface PivxClientOptions {
  /** Full URL, e.g. "http://127.0.0.1:51473". Overrides host/port. */
  url?: string;
  host?: string;
  /** Default 51473 (mainnet). Testnet is 51475. */
  port?: number;
  user?: string;
  pass?: string;
  /** Multiwallet: routes calls to /wallet/<name>. */
  wallet?: string;
  /** Request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Reject responses whose Content-Length exceeds this. Default 64 MiB. */
  maxResponseBytes?: number;
}

/** Error returned by the node's JSON-RPC layer (has the node's error code). */
export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly method: string,
  ) {
    super(`${method}: ${message} (code ${code})`);
    this.name = 'RpcError';
  }
}

/** HTTP-layer authentication failure (401/403 from the node). */
export class AuthError extends Error {
  constructor(
    method: string,
    public readonly status: number,
  ) {
    super(
      `${method}: authentication failed (HTTP ${status}); check rpcuser/rpcpassword or the cookie file`,
    );
    this.name = 'AuthError';
  }
}

let nextId = 0;

export class PivxClient {
  private readonly url: string;
  private authHeader?: string;
  /** Set when built via {@link fromCookie}; enables the 401 refresh-and-retry. */
  private cookiePath?: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(opts: PivxClientOptions = {}) {
    const base = opts.url ?? `http://${opts.host ?? '127.0.0.1'}:${opts.port ?? 51473}`;
    this.url = opts.wallet ? `${base.replace(/\/$/, '')}/wallet/${opts.wallet}` : base;
    if (opts.user !== undefined) {
      this.authHeader = PivxClient.basicAuth(opts.user, opts.pass ?? '');
    }
    this.timeoutMs = opts.timeoutMs ?? 30000;
    // Big enough for a full verbosity-2 block; blocks getblock spam only.
    this.maxResponseBytes = opts.maxResponseBytes ?? 64 * 1024 * 1024;
  }

  /** Runtime-agnostic base64 of the UTF-8 credential bytes (no Buffer, so
   * browser bundles work; btoa exists in Node >= 16 and all browsers). */
  private static basicAuth(user: string, pass: string): string {
    const bytes = new TextEncoder().encode(`${user}:${pass}`);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return 'Basic ' + btoa(bin);
  }

  /**
   * Build a client authenticated by a pivxd `.cookie` file (written to the
   * node's datadir on startup; a single `user:pass` line). Node-only: the
   * file is read via a dynamic `node:fs` import that only executes here, so
   * the package stays browser-importable.
   *
   * When a request later gets HTTP 401/403, the cookie file is re-read; if
   * its credentials changed (pivxd rewrites the cookie on restart) the
   * request is retried once, otherwise an {@link AuthError} is thrown.
   */
  static async fromCookie(
    cookiePath: string,
    opts: Omit<PivxClientOptions, 'user' | 'pass'> = {},
  ): Promise<PivxClient> {
    const client = new PivxClient(opts);
    client.cookiePath = cookiePath;
    client.authHeader = await PivxClient.readCookie(cookiePath);
    return client;
  }

  /** Read and encode `.cookie` credentials. Splits on the FIRST colon only —
   * passwords may contain colons. A real `.cookie` is `__cookie__:<hex>`, well
   * under 4 KiB; a larger file is a wrong path, not a cookie. */
  private static async readCookie(path: string): Promise<string> {
    const { readFile } = await import('node:fs/promises');
    const contents = await readFile(path, 'utf8');
    if (contents.length > 4096) throw new Error(`cookie file ${path} is too large`);
    const line = contents.trim();
    const sep = line.indexOf(':');
    if (sep < 0) throw new Error(`cookie file ${path} is not in user:pass format`);
    return PivxClient.basicAuth(line.slice(0, sep), line.slice(sep + 1));
  }

  private post(body: string): Promise<Response> {
    return fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.authHeader ? { authorization: this.authHeader } : {}),
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /** Raw JSON-RPC call. Trailing undefined params are trimmed. */
  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    while (params.length > 0 && params[params.length - 1] === undefined) params.pop();
    const payload = JSON.stringify({ jsonrpc: '1.0', id: ++nextId, method, params });
    let res = await this.post(payload);
    // pivxd rewrites .cookie on restart: on 401, re-read it and retry once when
    // the credentials actually changed (same contract as the Rust SDK). A 403
    // is an IP/ACL denial a cookie can't fix, so it is not retried. An
    // unreadable cookie counts as unchanged and falls through to AuthError.
    if (res.status === 401 && this.cookiePath) {
      const fresh = await PivxClient.readCookie(this.cookiePath).catch(() => undefined);
      if (fresh !== undefined && fresh !== this.authHeader) {
        this.authHeader = fresh;
        await res.body?.cancel().catch(() => {});
        res = await this.post(payload);
      }
    }
    if (res.status === 401 || res.status === 403) throw new AuthError(method, res.status);
    // Read the body with a hard byte cap so a hostile node can't exhaust
    // memory. Streaming means the cap holds even without a Content-Length.
    const raw = await this.readCapped(res, method);
    let body: { result?: T; error?: { code: number; message: string } | null };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new Error(`${method}: HTTP ${res.status} ${res.statusText} (non-JSON response)`);
    }
    if (body.error) throw new RpcError(body.error.code, body.error.message, method);
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${res.statusText}`);
    return body.result as T;
  }

  /** Read a response body as text, aborting once it exceeds maxResponseBytes. */
  private async readCapped(res: Response, method: string): Promise<string> {
    const tooBig = () => new Error(`${method}: response exceeds ${this.maxResponseBytes} bytes`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) throw tooBig();
    if (!res.body) {
      // No stream (some fetch implementations): fall back to buffered text.
      const text = await res.text();
      if (text.length > this.maxResponseBytes) throw tooBig();
      return text;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > this.maxResponseBytes) {
        await reader.cancel();
        throw tooBig();
      }
      out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  }

  // ── Blockchain ────────────────────────────────────────────────────────────

  getBlockCount() {
    return this.call<number>('getblockcount');
  }

  getBestBlockHash() {
    return this.call<string>('getbestblockhash');
  }

  getBlockHash(height: number) {
    return this.call<string>('getblockhash', height);
  }

  /** verbosity: 0/false = hex, 1/true = json (default), 2 = json with full tx objects. */
  getBlock(hash: string, verbosity: 0 | 1 | 2 | boolean = 1) {
    return this.call<Record<string, unknown> | string>('getblock', hash, verbosity);
  }

  getBlockchainInfo() {
    return this.call<BlockchainInfo>('getblockchaininfo');
  }

  getRawTransaction(txid: string, verbose = false) {
    return this.call<string | Record<string, unknown>>('getrawtransaction', txid, verbose ? 1 : 0);
  }

  sendRawTransaction(hex: string) {
    return this.call<string>('sendrawtransaction', hex);
  }

  // ── Transparent wallet ────────────────────────────────────────────────────

  getBalance() {
    return this.call<number>('getbalance');
  }

  getNewAddress(label?: string) {
    return this.call<string>('getnewaddress', label);
  }

  listUnspent(minConf = 1, maxConf = 9999999, addresses?: string[]) {
    return this.call<Unspent[]>('listunspent', minConf, maxConf, addresses);
  }

  sendToAddress(address: string, amount: number, comment?: string) {
    return this.call<string>('sendtoaddress', address, amount, comment);
  }

  getTransaction(txid: string) {
    return this.call<Record<string, unknown>>('gettransaction', txid);
  }

  getWalletInfo() {
    return this.call<WalletInfo>('getwalletinfo');
  }

  validateAddress(address: string) {
    return this.call<Record<string, unknown>>('validateaddress', address);
  }

  // ── Shield (SHIELD/Sapling) ───────────────────────────────────────────────

  getNewShieldAddress(label?: string) {
    return this.call<string>('getnewshieldaddress', label);
  }

  listShieldAddresses(includeWatchOnly = false) {
    return this.call<string[]>('listshieldaddresses', includeWatchOnly);
  }

  /** Total shield balance, or the balance of one shield address ("*" = all). */
  getShieldBalance(address = '*', minConf = 1, includeWatchOnly = false) {
    return this.call<number>('getshieldbalance', address, minConf, includeWatchOnly);
  }

  listShieldUnspent(
    minConf = 1,
    maxConf = 9999999,
    includeWatchOnly = false,
    addresses?: string[],
  ) {
    return this.call<ShieldNote[]>('listshieldunspent', minConf, maxConf, includeWatchOnly, addresses);
  }

  listReceivedByShieldAddress(address: string, minConf = 1) {
    return this.call<ReceivedShieldNote[]>('listreceivedbyshieldaddress', address, minConf);
  }

  /**
   * Build, prove, and broadcast a shielded transaction from the node wallet.
   * Synchronous in PIVX: resolves with the txid once accepted.
   */
  shieldSendMany(
    from: ShieldSendSource,
    recipients: ShieldRecipient[],
    minConf?: number,
    fee?: number,
    subtractFeeFrom?: string[],
  ) {
    return this.call<string>('shieldsendmany', from, recipients, minConf, fee, subtractFeeFrom);
  }

  /** Build and prove a shielded transaction but do not broadcast; returns raw hex. */
  rawShieldSendMany(
    from: ShieldSendSource,
    recipients: ShieldRecipient[],
    minConf?: number,
    fee?: number,
  ) {
    return this.call<string>('rawshieldsendmany', from, recipients, minConf, fee);
  }

  /** Decrypted view of a wallet shielded transaction (amounts, memos). */
  viewShieldTransaction(txid: string) {
    return this.call<ShieldTxView>('viewshieldtransaction', txid);
  }

  getSaplingNotesCount(minConf?: number) {
    return this.call<number>('getsaplingnotescount', minConf);
  }

  // ── Sapling keys ──────────────────────────────────────────────────────────

  exportSaplingKey(shieldAddr: string) {
    return this.call<string>('exportsaplingkey', shieldAddr);
  }

  importSaplingKey(key: string, rescan?: 'yes' | 'no' | 'whenkeyisnew', height?: number) {
    return this.call<{ address: string }>('importsaplingkey', key, rescan, height);
  }

  exportSaplingViewingKey(shieldAddr: string) {
    return this.call<string>('exportsaplingviewingkey', shieldAddr);
  }

  /** Import an incoming viewing key for watch-only shield balance tracking. */
  importSaplingViewingKey(vkey: string, rescan?: 'yes' | 'no' | 'whenkeyisnew', height?: number) {
    return this.call<{ address: string }>('importsaplingviewingkey', vkey, rescan, height);
  }

  // ── Masternode ──────────────────────────────────────────────────────────────

  getMasternodeCount() {
    return this.call<number>('getmasternodecount');
  }

  /** Legacy masternode list; filter matches address/txhash/status/etc. */
  listMasternodes(filter?: string) {
    return this.call<unknown[]>('listmasternodes', filter);
  }

  /** This node's masternode status (errors if the node isn't a masternode). */
  getMasternodeStatus() {
    return this.call<Record<string, unknown>>('getmasternodestatus');
  }

  /** The masternode currently scheduled to be paid. */
  masternodeCurrent() {
    return this.call<Record<string, unknown>>('masternodecurrent');
  }

  // ── Deterministic MN (evo) ────────────────────────────────────────────────────

  /** Deterministic masternode list. All args optional (node defaults). */
  protxList(detailed?: boolean, walletOnly?: boolean, validOnly?: boolean, height?: number) {
    return this.call<unknown[]>('protx_list', detailed, walletOnly, validOnly, height);
  }

  // ── Budget / governance ───────────────────────────────────────────────────────

  /** Budget proposal(s); name limits the result to one proposal. */
  getBudgetInfo(name?: string) {
    return this.call<unknown[]>('getbudgetinfo', name);
  }

  getBudgetProjection() {
    return this.call<unknown[]>('getbudgetprojection');
  }

  // ── Staking / cold-staking ──────────────────────────────────────────────────────

  getStakingStatus() {
    return this.call<Record<string, unknown>>('getstakingstatus');
  }

  listStakingAddresses() {
    return this.call<unknown[]>('liststakingaddresses');
  }

  getColdStakingBalance() {
    return this.call<number>('getcoldstakingbalance');
  }

  // ── Network / mempool / mining / util ─────────────────────────────────────────

  getPeerInfo() {
    return this.call<unknown[]>('getpeerinfo');
  }

  getConnectionCount() {
    return this.call<number>('getconnectioncount');
  }

  getNetworkInfo() {
    return this.call<Record<string, unknown>>('getnetworkinfo');
  }

  getMempoolInfo() {
    return this.call<Record<string, unknown>>('getmempoolinfo');
  }

  /** verbose false = array of txids, true = object keyed by txid. */
  getRawMempool(verbose?: boolean) {
    return this.call<string[] | Record<string, unknown>>('getrawmempool', verbose);
  }

  /** Estimated fee-per-kB for confirmation within nblocks; -1 if unknown. */
  estimateFee(nblocks: number) {
    return this.call<number>('estimatefee', nblocks);
  }

  /** { feerate, blocks }; feerate is -1 if not enough data. */
  estimateSmartFee(nblocks: number) {
    return this.call<Record<string, unknown>>('estimatesmartfee', nblocks);
  }

  getMiningInfo() {
    return this.call<Record<string, unknown>>('getmininginfo');
  }

  /** True if signature is a valid signing of message by address. */
  verifyMessage(address: string, signature: string, message: string) {
    return this.call<boolean>('verifymessage', address, signature, message);
  }

  /** Coin supply totals (transparent + shield). forceUpdate recomputes. */
  getSupplyInfo(forceUpdate?: boolean) {
    return this.call<Record<string, unknown>>('getsupplyinfo', forceUpdate);
  }

  /** Aggregate stats over `range` blocks ending at `height`. */
  getBlockIndexStats(height: number, range: number) {
    return this.call<Record<string, unknown>>('getblockindexstats', height, range);
  }
}
