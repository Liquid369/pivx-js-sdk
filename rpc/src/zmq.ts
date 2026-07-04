/**
 * ZMQ push notifications (PIVX v0.6 `-zmqpub*` endpoints).
 *
 * Two layers:
 *  - {@link parseZmqFrame}: pure, dependency-free decoder for the 3-part
 *    multipart message the node publishes. Bring your own socket.
 *  - {@link ZmqSubscriber}: optional convenience over the `zeromq` package.
 *    `zeromq` is NOT a runtime dependency — it is imported dynamically only
 *    when connect() runs, keeping this package zero-runtime-deps and
 *    browser-importable. Install it to use the subscriber: `npm install zeromq`.
 *
 * Wire format (src/zmq/zmqpublishnotifier.cpp): [topic, body, sequence] where
 * topic is a utf8 string, sequence is a little-endian u32, and the hash* bodies
 * are the 32-byte block/tx hash already in display order (hex it directly).
 *
 * Launch the node with matching endpoints, e.g.
 *   -zmqpubhashblock=tcp://127.0.0.1:28332 -zmqpubrawtx=tcp://127.0.0.1:28332
 */

export const TOPIC_HASHBLOCK = 'hashblock';
export const TOPIC_HASHTX = 'hashtx';
export const TOPIC_RAWBLOCK = 'rawblock';
export const TOPIC_RAWTX = 'rawtx';

export type ZmqEvent =
  | { topic: typeof TOPIC_HASHBLOCK; hash: string; sequence: number }
  | { topic: typeof TOPIC_HASHTX; hash: string; sequence: number }
  | { topic: typeof TOPIC_RAWBLOCK; block: Uint8Array; sequence: number }
  | { topic: typeof TOPIC_RAWTX; tx: Uint8Array; sequence: number };

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Decode a raw 3-part ZMQ multipart message [topic, body, sequence] into a
 * typed event. Pure — no socket, no deps. Throws on a malformed frame (wrong
 * part count, bad sequence length, short hash body) or unknown topic.
 */
export function parseZmqFrame(frames: Uint8Array[]): ZmqEvent {
  if (frames.length !== 3) {
    throw new Error(`ZMQ frame: expected 3 parts [topic, body, sequence], got ${frames.length}`);
  }
  const [topicBytes, body, seqBytes] = frames;
  if (seqBytes.length !== 4) {
    throw new Error(`ZMQ frame: sequence must be 4 bytes, got ${seqBytes.length}`);
  }
  const topic = new TextDecoder().decode(topicBytes);
  const sequence = new DataView(seqBytes.buffer, seqBytes.byteOffset, seqBytes.byteLength).getUint32(0, true);
  switch (topic) {
    case TOPIC_HASHBLOCK:
    case TOPIC_HASHTX:
      if (body.length !== 32) {
        throw new Error(`ZMQ ${topic}: hash body must be 32 bytes, got ${body.length}`);
      }
      return { topic, hash: toHex(body), sequence };
    case TOPIC_RAWBLOCK:
      return { topic, block: body, sequence };
    case TOPIC_RAWTX:
      return { topic, tx: body, sequence };
    default:
      throw new Error(`ZMQ frame: unknown topic '${topic}'`);
  }
}

/** Minimal shape of a zeromq v6 Subscriber (zeromq is an optional dev dep). */
interface RawSubscriber extends AsyncIterable<Uint8Array[]> {
  connect(endpoint: string): void;
  subscribe(...topics: string[]): void;
  close(): void;
}

/**
 * Convenience subscriber over the optional `zeromq` package. Yields typed
 * {@link ZmqEvent}s via async iteration; call {@link close} when done.
 *
 *   const sub = await ZmqSubscriber.connect('tcp://127.0.0.1:28332', ['hashblock']);
 *   for await (const ev of sub) handle(ev);
 */
export class ZmqSubscriber implements AsyncIterable<ZmqEvent> {
  private constructor(private readonly sock: RawSubscriber) {}

  static async connect(endpoint: string, topics: string[]): Promise<ZmqSubscriber> {
    // Non-literal specifier (`as string`) so bundlers don't try to resolve the
    // optional dep, mirroring shield-bindings.ts's multicore dynamic import.
    const zmq = await import('zeromq' as string).catch((e: unknown) => {
      // Distinguish "not installed" from a real load/binding failure so a
      // broken native build isn't misreported as a missing package.
      const code = (e as { code?: string })?.code;
      if (code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((e as Error)?.message))) {
        throw new Error("ZmqSubscriber requires the 'zeromq' package — run: npm install zeromq");
      }
      throw e;
    });
    const sock: RawSubscriber = new zmq.Subscriber();
    sock.connect(endpoint);
    for (const t of topics) sock.subscribe(t);
    return new ZmqSubscriber(sock);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ZmqEvent> {
    for await (const frames of this.sock) yield parseZmqFrame(frames);
  }

  close(): void {
    this.sock.close();
  }
}
