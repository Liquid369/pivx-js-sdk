import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { parseZmqFrame, ZmqSubscriber } from '../dist/index.js';

const utf8 = (s) => new TextEncoder().encode(s);
const leSeq = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

test('parseZmqFrame: hashblock → hex hash + LE sequence', () => {
  const body = new Uint8Array(32);
  for (let i = 0; i < 32; i++) body[i] = i;
  const ev = parseZmqFrame([utf8('hashblock'), body, leSeq(7)]);
  assert.deepEqual(ev, {
    topic: 'hashblock',
    hash: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    sequence: 7,
  });
});

test('parseZmqFrame: hashtx → hex hash + LE sequence', () => {
  const body = new Uint8Array(32).fill(0xab);
  const ev = parseZmqFrame([utf8('hashtx'), body, leSeq(258)]); // 258 = 0x0102, LE bytes 02 01
  assert.deepEqual(ev, { topic: 'hashtx', hash: 'ab'.repeat(32), sequence: 258 });
});

test('parseZmqFrame: rawblock → block passthrough', () => {
  const body = utf8('raw-block-bytes');
  const ev = parseZmqFrame([utf8('rawblock'), body, leSeq(1)]);
  assert.equal(ev.topic, 'rawblock');
  assert.equal(ev.sequence, 1);
  assert.deepEqual(ev.block, body);
});

test('parseZmqFrame: rawtx → tx passthrough', () => {
  const body = utf8('raw-tx-bytes');
  const ev = parseZmqFrame([utf8('rawtx'), body, leSeq(42)]);
  assert.equal(ev.topic, 'rawtx');
  assert.equal(ev.sequence, 42);
  assert.deepEqual(ev.tx, body);
});

test('parseZmqFrame: unknown topic throws', () => {
  assert.throws(() => parseZmqFrame([utf8('bogus'), new Uint8Array(4), leSeq(1)]), /unknown topic/);
});

test('parseZmqFrame: wrong part count throws', () => {
  assert.throws(() => parseZmqFrame([utf8('hashtx'), new Uint8Array(32)]), /expected 3 parts/);
});

test('parseZmqFrame: bad sequence length throws', () => {
  assert.throws(
    () => parseZmqFrame([utf8('hashtx'), new Uint8Array(32), new Uint8Array(3)]),
    /sequence must be 4 bytes/,
  );
});

test('parseZmqFrame: short hash body throws', () => {
  assert.throws(() => parseZmqFrame([utf8('hashblock'), new Uint8Array(31), leSeq(1)]), /32 bytes/);
});

test('ZmqSubscriber: publisher → subscriber round-trip yields a typed event', async () => {
  const zmq = await import('zeromq');
  const pub = new zmq.Publisher();
  await pub.bind('tcp://127.0.0.1:*');
  const endpoint = pub.lastEndpoint;

  const sub = await ZmqSubscriber.connect(endpoint, ['hashblock']);
  const iter = sub[Symbol.asyncIterator]();

  const body = new Uint8Array(32).fill(0xcd);
  // SUB is a slow joiner: the subscription may not have reached the publisher
  // yet, so keep publishing until the first message lands.
  let stop = false;
  const pump = (async () => {
    while (!stop) {
      await pub.send(['hashblock', body, leSeq(3)]);
      await delay(20);
    }
  })();

  try {
    const { value: ev } = await iter.next();
    assert.equal(ev.topic, 'hashblock');
    assert.equal(ev.sequence, 3);
    assert.equal(ev.hash, 'cd'.repeat(32));
  } finally {
    stop = true;
    await pump;
    await iter.return?.();
    sub.close();
    pub.close();
  }
});
