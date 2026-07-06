import type {
  BlockchainInfo,
  BlockHeader,
  BlockIndexStats,
  BudgetProjection,
  BudgetProposal,
  ChainTip,
  DecodedTransaction,
  EstimateSmartFee,
  ListSinceBlock,
  MasternodeCount,
  MempoolEntry,
  MempoolInfo,
  MiningInfo,
  NetworkInfo,
  PeerInfo,
  PrevTx,
  ReceivedShieldNote,
  ShieldNote,
  ShieldRecipient,
  ShieldSendSource,
  ShieldTxView,
  SignRawTransactionResult,
  StakingAddress,
  StakingStatus,
  SupplyInfo,
  TransactionInfo,
  TxInput,
  TxOut,
  Unspent,
  ValidateAddress,
  WalletInfo,
  WalletTransaction,
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

/** Response envelope was not a well-formed JSON-RPC object (non-JSON body,
 * null/primitive/array, a malformed batch element, or a mismatched id).
 * Parity with the Rust SDK's `Error::Json`. */
export class MalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedResponseError';
  }
}

/** Response body exceeded the configured size cap
 * ({@link PivxClientOptions.maxResponseBytes}). Parity with the Rust SDK's
 * `Error::ResponseTooLarge`. */
export class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseTooLargeError';
  }
}

/** Network/transport failure reaching the node (fetch rejected, timeout
 * abort). The original error is kept as `cause`. Parity with the Rust SDK's
 * `Error::Transport`. */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransportError';
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
    if (opts.url !== undefined) {
      // fetch() rejects URLs carrying userinfo, so catch it early with a
      // pointer to the supported mechanism (same contract as the Rust SDK).
      let parsed: URL | undefined;
      try {
        parsed = new URL(opts.url);
      } catch {
        /* a malformed URL fails in fetch() with the method-labeled wrapper */
      }
      if (parsed && (parsed.username !== '' || parsed.password !== '')) {
        throw new Error(
          'credentials in the URL are not supported; use the user/pass options instead',
        );
      }
    }
    const base = opts.url ?? `http://${opts.host ?? '127.0.0.1'}:${opts.port ?? 51473}`;
    this.url = opts.wallet
      ? `${base.replace(/\/$/, '')}/wallet/${encodeURIComponent(opts.wallet)}`
      : base;
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

  private async post(body: string, label: string, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authHeader ? { authorization: this.authHeader } : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A bare "fetch failed" / timeout abort says nothing about which RPC was
      // in flight; label it with the method (original error kept as cause).
      const msg = err instanceof Error ? err.message : String(err);
      throw new TransportError(`${label}: transport failure: ${msg}`, { cause: err });
    }
  }

  /**
   * POST a JSON-RPC payload and return the auth-checked {@link Response}.
   * `label` names the call in error messages. Shared by {@link call} and
   * {@link batch} so both get the same cookie-refresh and auth handling.
   *
   * pivxd rewrites .cookie on restart: on 401, re-read it and retry once when
   * the credentials actually changed (same contract as the Rust SDK). A 403
   * is an IP/ACL denial a cookie can't fix, so it is not retried. An
   * unreadable cookie counts as unchanged and falls through to AuthError.
   */
  private async send(payload: string, label: string, timeoutMs = this.timeoutMs): Promise<Response> {
    let res = await this.post(payload, label, timeoutMs);
    if (res.status === 401 && this.cookiePath) {
      const fresh = await PivxClient.readCookie(this.cookiePath).catch(() => undefined);
      if (fresh !== undefined && fresh !== this.authHeader) {
        this.authHeader = fresh;
        await res.body?.cancel().catch(() => {});
        res = await this.post(payload, label, timeoutMs);
      }
    }
    if (res.status === 401 || res.status === 403) throw new AuthError(label, res.status);
    return res;
  }

  /** Raw JSON-RPC call. Trailing undefined params are trimmed. */
  call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    return this.callWithTimeout<T>(this.timeoutMs, method, params);
  }

  /** {@link call} with a per-request timeout (rescanning key imports run far
   * longer than the default request timeout). */
  private async callWithTimeout<T>(timeoutMs: number, method: string, params: unknown[]): Promise<T> {
    while (params.length > 0 && params[params.length - 1] === undefined) params.pop();
    const id = ++nextId;
    const payload = JSON.stringify({ jsonrpc: '1.0', id, method, params });
    const res = await this.send(payload, method, timeoutMs);
    // Read the body with a hard byte cap so a hostile node can't exhaust
    // memory. Streaming means the cap holds even without a Content-Length.
    const raw = await this.readCapped(res, method);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MalformedResponseError(`${method}: HTTP ${res.status} ${res.statusText} (non-JSON response)`);
    }
    // A JSON-RPC response is one object; a hostile/broken endpoint can hand
    // back null, a bare primitive, or an array — fail with a labeled error
    // instead of crashing on property access.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new MalformedResponseError(`${method}: malformed response (expected a JSON object)`);
    }
    const body = parsed as { result?: T; error?: { code: number; message: string } | null; id?: unknown };
    // pivxd echoes the request id on BOTH success and error replies, so verify
    // it before either branch: a wrong-id reply is not this call's result *or*
    // error and must be rejected rather than mis-attributed.
    if (body.id !== id) {
      throw new MalformedResponseError(
        `${method}: response id mismatch (sent ${id}, got ${String(body.id)})`,
      );
    }
    if (body.error) throw new RpcError(body.error.code, body.error.message, method);
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${res.statusText}`);
    return body.result as T;
  }

  /**
   * Execute several calls in a single JSON-RPC batch (one HTTP round-trip).
   * Returns one element per call, in request order: `{ result }` when the
   * node reported no error for that call, otherwise `{ error: { code,
   * message } }`. A per-call error does not fail the batch; a transport/auth
   * failure rejects the whole promise. Rejects an empty `calls` array.
   */
  async batch(
    calls: { method: string; params?: unknown[] }[],
  ): Promise<Array<{ result: unknown } | { error: { code: number; message: string } }>> {
    if (calls.length === 0) throw new Error('batch: no calls provided');
    // Capture each sub-request's id so responses can be matched by id, not
    // array position (pivxd preserves order, but a broken proxy could not).
    const ids = calls.map(() => ++nextId);
    const payload = JSON.stringify(
      calls.map((c, i) => ({ jsonrpc: '1.0', id: ids[i], method: c.method, params: c.params ?? [] })),
    );
    const res = await this.send(payload, 'batch');
    const raw = await this.readCapped(res, 'batch');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MalformedResponseError(`batch: HTTP ${res.status} ${res.statusText} (non-JSON response)`);
    }
    if (!Array.isArray(parsed)) {
      // A whole-request failure (parse error, oversized batch, …) comes back
      // as a single error object — surface the node's code/message. Check that
      // first (it rides on HTTP 500) so it stays an RpcError, then fall through
      // to the status check for a non-array, non-error body.
      const whole =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { error?: { code: number; message: string } | null }).error
          : undefined;
      if (whole) throw new RpcError(whole.code, whole.message, 'batch');
      if (!res.ok) throw new Error(`batch: HTTP ${res.status} ${res.statusText}`);
      throw new MalformedResponseError(`batch: expected a JSON array response`);
    }
    // A JSON array on a non-2xx status is a hostile/broken endpoint (pivxd
    // returns 200 for a batch even when individual calls error); reject it,
    // matching the single-call `if (!res.ok)` and Rust batch's Error::Http.
    if (!res.ok) throw new Error(`batch: HTTP ${res.status} ${res.statusText}`);
    if (parsed.length !== calls.length) {
      throw new MalformedResponseError(
        `batch: node returned ${parsed.length} results for ${calls.length} calls`,
      );
    }
    // Index each element by its id. A null/primitive entry must not crash on
    // property access; a non-number id simply won't match any request below.
    const byId = new Map<
      number,
      { result?: unknown; error?: { code: number; message: string } | null }
    >();
    for (const el of parsed) {
      if (typeof el !== 'object' || el === null || Array.isArray(el)) {
        throw new MalformedResponseError('batch: malformed response element (expected a JSON object)');
      }
      byId.set((el as { id?: unknown }).id as number, el);
    }
    // Reassemble in request order by matching each request id to its element,
    // so a reordered response is still attributed correctly and a missing or
    // mismatched id is a labeled error rather than a mis-attributed result.
    return ids.map((id) => {
      const one = byId.get(id);
      if (one === undefined) {
        throw new MalformedResponseError(`batch: no response element for request id ${id}`);
      }
      return one.error == null
        ? { result: one.result }
        : { error: { code: one.error.code, message: one.error.message } };
    });
  }

  /** Read a response body as text, aborting once it exceeds maxResponseBytes. */
  private async readCapped(res: Response, method: string): Promise<string> {
    const tooBig = () =>
      new ResponseTooLargeError(`${method}: response exceeds ${this.maxResponseBytes} bytes`);
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

  /** One-line runtime guard for money/txid-bearing results: a mistyped amount
   * must fail loudly here, not propagate NaN into caller arithmetic. */
  private static expect<T>(value: T, type: 'number' | 'string', method: string): T {
    if (typeof value !== type) {
      throw new Error(`${method}: expected a ${type} result, got ${typeof value}`);
    }
    return value;
  }

  // ── Blockchain ────────────────────────────────────────────────────────────

  async getBlockCount() {
    return PivxClient.expect(await this.call<number>('getblockcount'), 'number', 'getblockcount');
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

  /** Block header. verbose=true (default) → typed object; false → raw hex. */
  getBlockHeader(blockhash: string, verbose?: true): Promise<BlockHeader>;
  getBlockHeader(blockhash: string, verbose: false): Promise<string>;
  getBlockHeader(blockhash: string, verbose = true): Promise<BlockHeader | string> {
    return this.call<BlockHeader | string>('getblockheader', blockhash, verbose);
  }

  /** All known chain tips (active tip plus any side branches). */
  getChainTips() {
    return this.call<ChainTip[]>('getchaintips');
  }

  /** Unspent output at (txid, n), or null when spent / not found. */
  getTxOut(txid: string, n: number, includeMempool = true) {
    return this.call<TxOut | null>('gettxout', txid, n, includeMempool);
  }

  /** Raw tx. verbose=false (default) → hex; true → decoded object. */
  getRawTransaction(txid: string, verbose?: false, blockhash?: string): Promise<string>;
  getRawTransaction(txid: string, verbose: true, blockhash?: string): Promise<DecodedTransaction>;
  getRawTransaction(
    txid: string,
    verbose = false,
    blockhash?: string,
  ): Promise<string | DecodedTransaction> {
    return this.call<string | DecodedTransaction>(
      'getrawtransaction',
      txid,
      verbose ? 1 : 0,
      blockhash,
    );
  }

  /** Build an unsigned raw tx from inputs and address→amount outputs. */
  createRawTransaction(inputs: TxInput[], outputs: Record<string, number>, locktime = 0) {
    return this.call<string>('createrawtransaction', inputs, outputs, locktime);
  }

  decodeRawTransaction(hex: string) {
    return this.call<DecodedTransaction>('decoderawtransaction', hex);
  }

  /** Sign a raw tx (PIVX RPC is `signrawtransaction`, not `...withkey`). */
  signRawTransaction(hex: string, prevTxs?: PrevTx[], privKeys?: string[], sigHashType = 'ALL') {
    return this.call<SignRawTransactionResult>(
      'signrawtransaction',
      hex,
      prevTxs,
      privKeys,
      sigHashType,
    );
  }

  sendRawTransaction(hex: string) {
    return this.call<string>('sendrawtransaction', hex);
  }

  // ── Transparent wallet ────────────────────────────────────────────────────

  async getBalance() {
    return PivxClient.expect(await this.call<number>('getbalance'), 'number', 'getbalance');
  }

  getNewAddress(label?: string) {
    return this.call<string>('getnewaddress', label);
  }

  listUnspent(minConf = 1, maxConf = 9999999, addresses?: string[]) {
    return this.call<Unspent[]>('listunspent', minConf, maxConf, addresses);
  }

  async sendToAddress(address: string, amount: number, comment?: string) {
    return PivxClient.expect(
      await this.call<string>('sendtoaddress', address, amount, comment),
      'string',
      'sendtoaddress',
    );
  }

  getTransaction(txid: string, includeWatchOnly = false) {
    return this.call<TransactionInfo>('gettransaction', txid, includeWatchOnly);
  }

  /** Wallet transactions since `blockhash` (or from genesis when omitted).
   * The node rejects a null `blockhash`, so when it is omitted no params are
   * sent — `targetConfirmations`/`includeWatchOnly` apply only with a hash. */
  listSinceBlock(blockhash?: string, targetConfirmations = 1, includeWatchOnly = false) {
    return blockhash === undefined
      ? this.call<ListSinceBlock>('listsinceblock')
      : this.call<ListSinceBlock>('listsinceblock', blockhash, targetConfirmations, includeWatchOnly);
  }

  /** Recent wallet transactions. The legacy `dummy="*"` account arg is passed
   * internally and not exposed. */
  listTransactions(
    count = 10,
    from = 0,
    includeWatchOnly = false,
    includeDelegated = true,
    includeCold = true,
  ) {
    return this.call<WalletTransaction[]>(
      'listtransactions',
      '*',
      count,
      from,
      includeWatchOnly,
      includeDelegated,
      includeCold,
    );
  }

  /** Send to many address→amount recipients (transparent or shield); returns
   * the txid. The legacy `dummy=""` account arg is passed internally. */
  sendMany(
    amounts: Record<string, number>,
    minConf = 1,
    comment?: string,
    includeDelegated = false,
    subtractFeeFrom?: string[],
  ) {
    return this.call<string>(
      'sendmany',
      '',
      amounts,
      minConf,
      comment,
      includeDelegated,
      subtractFeeFrom,
    );
  }

  /** New transparent exchange (EXM/EXT) address. */
  getNewExchangeAddress(label = '') {
    return this.call<string>('getnewexchangeaddress', label);
  }

  /** Mark an in-wallet transaction abandoned (node returns null on success). */
  async abandonTransaction(txid: string): Promise<void> {
    await this.call<null>('abandontransaction', txid);
  }

  getWalletInfo() {
    return this.call<WalletInfo>('getwalletinfo');
  }

  validateAddress(address: string) {
    return this.call<ValidateAddress>('validateaddress', address);
  }

  // ── Shield (SHIELD/Sapling) ───────────────────────────────────────────────

  getNewShieldAddress(label?: string) {
    return this.call<string>('getnewshieldaddress', label);
  }

  listShieldAddresses(includeWatchOnly = false) {
    return this.call<string[]>('listshieldaddresses', includeWatchOnly);
  }

  /** Total shield balance, or the balance of one shield address ("*" = all). */
  async getShieldBalance(address = '*', minConf = 1, includeWatchOnly = false) {
    return PivxClient.expect(
      await this.call<number>('getshieldbalance', address, minConf, includeWatchOnly),
      'number',
      'getshieldbalance',
    );
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
   *
   * An omitted `fee` lets the node compute the minimum fee (fee=0 on the wire
   * is identical: rpcwallet.cpp "If nFee=0 leave the default").
   */
  shieldSendMany(
    from: ShieldSendSource,
    recipients: ShieldRecipient[],
    minConf?: number,
    fee?: number,
    subtractFeeFrom?: string[],
  ) {
    // Interior undefineds serialize to null, which pivxd rejects (get_int /
    // AmountFromValue) — substitute the node's own defaults instead.
    return this.call<string>(
      'shieldsendmany',
      from,
      recipients,
      minConf ?? 1,
      fee ?? 0,
      subtractFeeFrom,
    );
  }

  /** Build and prove a shielded transaction but do not broadcast; returns raw
   * hex. Omitted `minConf`/`fee` use the node defaults (1 / computed fee). */
  rawShieldSendMany(
    from: ShieldSendSource,
    recipients: ShieldRecipient[],
    minConf?: number,
    fee?: number,
  ) {
    // Same interior-null substitution as shieldSendMany.
    return this.call<string>('rawshieldsendmany', from, recipients, minConf ?? 1, fee ?? 0);
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

  /** Import a sapling spending key. `rescan` defaults to `"whenkeyisnew"`;
   * `height` rescans from that block. Unless `rescan` is `"no"`, the request
   * timeout is raised to at least 10 minutes — a wallet rescan blocks the
   * node well past the default 30s. */
  importSaplingKey(key: string, rescan?: 'yes' | 'no' | 'whenkeyisnew', height?: number) {
    return this.callWithTimeout<{ address: string }>(
      rescan === 'no' ? this.timeoutMs : Math.max(this.timeoutMs, 600_000),
      'importsaplingkey',
      PivxClient.importKeyParams(key, rescan, height),
    );
  }

  /** pivxd reads rescan with get_str() and height with get_int() — both
   * reject null, so when height is given without rescan the node default is
   * substituted rather than sending an interior null. */
  private static importKeyParams(
    key: string,
    rescan?: 'yes' | 'no' | 'whenkeyisnew',
    height?: number,
  ): unknown[] {
    const params: unknown[] = [key];
    if (rescan !== undefined || height !== undefined) params.push(rescan ?? 'whenkeyisnew');
    if (height !== undefined) params.push(height);
    return params;
  }

  exportSaplingViewingKey(shieldAddr: string) {
    return this.call<string>('exportsaplingviewingkey', shieldAddr);
  }

  /** Import an incoming viewing key for watch-only shield balance tracking.
   * Same `rescan` defaults and long-rescan timeout as {@link importSaplingKey}. */
  importSaplingViewingKey(vkey: string, rescan?: 'yes' | 'no' | 'whenkeyisnew', height?: number) {
    return this.callWithTimeout<{ address: string }>(
      rescan === 'no' ? this.timeoutMs : Math.max(this.timeoutMs, 600_000),
      'importsaplingviewingkey',
      PivxClient.importKeyParams(vkey, rescan, height),
    );
  }

  // ── Masternode ──────────────────────────────────────────────────────────────

  /** Masternode network totals. Throws an {@link RpcError} (code 0) when the
   * node has no chain tip yet — pivxd returns the bare string "unknown" in
   * that state instead of the object (same `Error::Rpc` classification as the
   * Rust SDK). Any other non-object result is a malformed response. */
  async getMasternodeCount(): Promise<MasternodeCount> {
    const res = await this.call<MasternodeCount | 'unknown'>('getmasternodecount');
    if (res === 'unknown') {
      throw new RpcError(0, 'node has no chain tip yet', 'getmasternodecount');
    }
    if (res === null || typeof res !== 'object' || Array.isArray(res)) {
      throw new MalformedResponseError('getmasternodecount: malformed response (expected a JSON object)');
    }
    return res;
  }

  /** Legacy masternode list; filter matches address/txhash/status/etc.
   * Left untyped: returns the node's raw JSON; shape varies (deterministic vs
   * legacy) and can be a bare string on edge cases. */
  listMasternodes(filter?: string) {
    return this.call<unknown[]>('listmasternodes', filter);
  }

  /** This node's masternode status (errors if the node isn't a masternode).
   * Left untyped: returns the node's raw JSON; shape varies (deterministic vs
   * legacy) and can be a bare string on edge cases. */
  getMasternodeStatus() {
    return this.call<Record<string, unknown>>('getmasternodestatus');
  }

  /** The masternode currently scheduled to be paid.
   * Left untyped: returns the node's raw JSON; shape varies (deterministic vs
   * legacy) and can be a bare string on edge cases. */
  masternodeCurrent() {
    return this.call<Record<string, unknown>>('masternodecurrent');
  }

  // ── Deterministic MN (evo) ────────────────────────────────────────────────────

  /** Deterministic masternode list. All args optional (node defaults). */
  protxList(detailed?: boolean, walletOnly?: boolean, validOnly?: boolean, height?: number) {
    // Every positional arg is read by pivxd with an unguarded get_bool()/
    // get_int(), so an interior null is rejected — substitute the node's own
    // defaults; height stays trailing/optional.
    return this.call<unknown[]>(
      'protx_list',
      detailed ?? true,
      walletOnly ?? false,
      validOnly ?? false,
      height,
    );
  }

  // ── Budget / governance ───────────────────────────────────────────────────────

  /** Budget proposal(s); name limits the result to one proposal. */
  getBudgetInfo(name?: string) {
    return this.call<BudgetProposal[]>('getbudgetinfo', name);
  }

  getBudgetProjection() {
    return this.call<BudgetProjection[]>('getbudgetprojection');
  }

  // ── Staking / cold-staking ──────────────────────────────────────────────────────

  getStakingStatus() {
    return this.call<StakingStatus>('getstakingstatus');
  }

  listStakingAddresses() {
    return this.call<StakingAddress[]>('liststakingaddresses');
  }

  async getColdStakingBalance() {
    return PivxClient.expect(
      await this.call<number>('getcoldstakingbalance'),
      'number',
      'getcoldstakingbalance',
    );
  }

  // ── Network / mempool / mining / util ─────────────────────────────────────────

  getPeerInfo() {
    return this.call<PeerInfo[]>('getpeerinfo');
  }

  getConnectionCount() {
    return this.call<number>('getconnectioncount');
  }

  getNetworkInfo() {
    return this.call<NetworkInfo>('getnetworkinfo');
  }

  getMempoolInfo() {
    return this.call<MempoolInfo>('getmempoolinfo');
  }

  /** verbose false (default) → array of txids; true → object keyed by txid. */
  getRawMempool(verbose?: false): Promise<string[]>;
  getRawMempool(verbose: true): Promise<Record<string, MempoolEntry>>;
  getRawMempool(verbose = false): Promise<string[] | Record<string, MempoolEntry>> {
    return this.call<string[] | Record<string, MempoolEntry>>('getrawmempool', verbose);
  }

  /** Estimated fee-per-kB for confirmation within nblocks; -1 if unknown. */
  estimateFee(nblocks: number) {
    return this.call<number>('estimatefee', nblocks);
  }

  /** { feerate, blocks }; feerate is -1 if not enough data. */
  estimateSmartFee(nblocks: number) {
    return this.call<EstimateSmartFee>('estimatesmartfee', nblocks);
  }

  getMiningInfo() {
    return this.call<MiningInfo>('getmininginfo');
  }

  /** True if signature is a valid signing of message by address. */
  verifyMessage(address: string, signature: string, message: string) {
    return this.call<boolean>('verifymessage', address, signature, message);
  }

  /** Coin supply totals (transparent + shield). forceUpdate recomputes. */
  getSupplyInfo(forceUpdate?: boolean) {
    return this.call<SupplyInfo>('getsupplyinfo', forceUpdate);
  }

  /** Aggregate stats over `range` blocks ending at `height`. */
  getBlockIndexStats(height: number, range: number) {
    return this.call<BlockIndexStats>('getblockindexstats', height, range);
  }
}
