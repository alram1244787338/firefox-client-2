// Unit tests for the connection / protocol layer in lib/client.js.
//
// These run on Node's built-in test runner (no Firefox, no extra deps):
//   node --test test/test-client.js   (or: npm test)
//
// They focus on the two risky areas called out for the modernization:
//   1. message parsing / framing (half packets, sticky packets, multi-byte
//      bodies, malformed input)
//   2. connection exceptions and the error taxonomy (connection / protocol /
//      local), making sure error paths surface instead of crashing.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const Client = require('../lib/client');

// Build a wire frame: "<byteLengthOfBody>:<body>" as a Buffer.
function frame(obj) {
  const json = JSON.stringify(obj);
  return Buffer.from(Buffer.byteLength(json) + ':' + json);
}

// Collect unsolicited 'message' events emitted by the client.
function collectMessages(client) {
  const msgs = [];
  client.on('message', (m) => msgs.push(m));
  return msgs;
}

// Collect 'error' events. Attaching a listener also prevents Node's
// EventEmitter from throwing on an emitted 'error' with no listener, so an
// unexpected error becomes a clean assertion failure instead of a crash.
function collectErrors(client) {
  const errs = [];
  client.on('error', (e) => errs.push(e));
  return errs;
}

// Assert that fn() throws an Error tagged with the given category.
function assertThrowsCategory(fn, category) {
  let thrown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'expected the call to throw');
  assert.ok(thrown instanceof Error, 'expected a real Error to be thrown');
  assert.equal(thrown.category, category);
  return thrown;
}

describe('message parsing / framing', () => {
  it('parses a single complete message', () => {
    const c = new Client();
    const msgs = collectMessages(c);
    const errs = collectErrors(c);

    c.onData(frame({ from: 'tab1', type: 'tabNavigated', url: 'a' }));

    assert.equal(errs.length, 0);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, 'tab1');
  });

  it('routes a response to the matching request callback', () => {
    const c = new Client();
    let got = null;
    c.expectReply('root', (resp) => { got = resp; });

    c.onData(frame({ from: 'root', tabs: [] }));

    assert.ok(got, 'callback should have been invoked');
    assert.deepEqual(got.tabs, []);
  });

  it('parses two messages delivered in one chunk (sticky packets)', () => {
    const c = new Client();
    const msgs = collectMessages(c);

    c.onData(Buffer.concat([
      frame({ from: 'a', type: 'appOpen' }),
      frame({ from: 'b', type: 'appClose' }),
    ]));

    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].from, 'a');
    assert.equal(msgs[1].from, 'b');
  });

  it('waits for the rest of a message split across chunks (half packet)', () => {
    const c = new Client();
    const msgs = collectMessages(c);

    const buf = frame({ from: 'a', type: 'appOpen', x: 'hello world' });
    const k = Math.floor(buf.length / 2);

    c.onData(buf.slice(0, k));
    assert.equal(msgs.length, 0, 'nothing should be parsed from a partial frame');

    c.onData(buf.slice(k));
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].x, 'hello world');
  });

  it('handles the length prefix being split across chunks', () => {
    const c = new Client();
    const msgs = collectMessages(c);

    const buf = frame({ from: 'a', type: 'appOpen' });
    // first byte only: a single digit, no ':' separator yet
    c.onData(buf.slice(0, 1));
    assert.equal(msgs.length, 0);

    c.onData(buf.slice(1));
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, 'a');
  });

  it('preserves byte boundaries for multi-byte UTF-8 bodies', () => {
    // Regression guard for the byte-accurate framing: the length prefix is a
    // *byte* count and bodies are sliced by bytes, so a multi-byte body must
    // not shift the boundary of the message that follows it.
    const c = new Client();
    const msgs = collectMessages(c);
    const errs = collectErrors(c);

    c.onData(Buffer.concat([
      frame({ from: 'a', type: 'appOpen', s: 'héllo✓ 世界' }),
      frame({ from: 'b', type: 'appClose' }),
    ]));

    assert.equal(errs.length, 0);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].s, 'héllo✓ 世界');
    assert.equal(msgs[1].from, 'b');
  });

  it('emits a protocol error for an invalid length prefix and does not throw', () => {
    const c = new Client();
    const errs = collectErrors(c);

    assert.doesNotThrow(() => c.onData(Buffer.from('abc:{}')));
    assert.equal(errs.length, 1);
    assert.equal(errs[0].category, 'protocol');
  });

  it('reports a bad JSON packet but keeps parsing the next message', () => {
    // Framing is intact (the byte count is honored), so one un-parseable
    // packet should be reported without dropping the messages after it.
    const c = new Client();
    const msgs = collectMessages(c);
    const errs = collectErrors(c);

    const bad = 'notjson';
    const badFrame = Buffer.from(Buffer.byteLength(bad) + ':' + bad);
    const good = frame({ from: 'a', type: 'appOpen' });

    c.onData(Buffer.concat([badFrame, good]));

    assert.equal(errs.length, 1);
    assert.equal(errs[0].category, 'protocol');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, 'a');
  });

  it('emits a protocol error for a server error packet without an actor', () => {
    const c = new Client();
    const errs = collectErrors(c);

    c.onData(frame({ error: 'unknownError', message: 'boom' }));

    assert.equal(errs.length, 1);
    assert.equal(errs[0].category, 'protocol');
    assert.equal(errs[0].message, 'boom');
  });

  it('emits a protocol error for an unexpected packet from an actor', () => {
    const c = new Client();
    const errs = collectErrors(c);

    // has a 'from' but no 'type' and no pending request for that actor
    c.onData(frame({ from: 'ghost', whatever: true }));

    assert.equal(errs.length, 1);
    assert.equal(errs[0].category, 'protocol');
  });
});

describe('connection exceptions', () => {
  it('tags socket errors as connection and preserves the code', () => {
    const c = new Client();
    const errs = collectErrors(c);

    c.onError({ code: 'ECONNREFUSED' });

    assert.equal(errs.length, 1);
    assert.equal(errs[0].category, 'connection');
    assert.equal(errs[0].code, 'ECONNREFUSED');
  });

  it('re-emits a socket end as an "end" event', () => {
    const c = new Client();
    let ended = false;
    c.on('end', () => { ended = true; });

    c.onEnd();

    assert.equal(ended, true);
  });

  it('re-emits a socket timeout as a "timeout" event', () => {
    const c = new Client();
    let timedOut = false;
    c.on('timeout', () => { timedOut = true; });

    c.onTimeout();

    assert.equal(timedOut, true);
  });

  it('surfaces a real connection failure as a connection error', { timeout: 5000 }, (t, done) => {
    const c = new Client();
    c.on('error', (err) => {
      try {
        assert.equal(err.category, 'connection');
        assert.ok(err.code, 'expected an OS error code such as ECONNREFUSED');
        done();
      } catch (e) {
        done(e);
      }
    });
    // nothing is listening on port 1 -> fast ECONNREFUSED
    c.connect(1, '127.0.0.1', () => {
      done(new Error('connect callback should not fire for a refused connection'));
    });
  });
});

describe('send framing and local errors', () => {
  it('frames outgoing messages with the correct byte length', () => {
    const c = new Client();
    let written = null;
    c.client = { write: (s) => { written = s; } };

    const message = { to: 'x', s: 'é' }; // 'é' is 2 bytes, 1 char
    c.sendMessage(message);

    const json = JSON.stringify(message);
    assert.equal(written, Buffer.byteLength(json) + ':' + json);

    const headerNum = parseInt(written.split(':')[0], 10);
    assert.equal(headerNum, Buffer.byteLength(json));
    assert.notEqual(headerNum, json.length, 'prefix must be a byte length, not a char length');
  });

  it('throws a local error when makeRequest has no destination', () => {
    const c = new Client();
    assertThrowsCategory(() => c.makeRequest({ type: 'listTabs' }, () => {}), 'local');
  });

  it('throws a local error when sending without a connection', () => {
    const c = new Client();
    assertThrowsCategory(() => c.sendMessage({ to: 'x' }), 'local');
  });

  it('throws a local error (not a ReferenceError) on clashing reply handlers', () => {
    const c = new Client();
    c.expectReply('a', () => {});

    const err = assertThrowsCategory(() => c.expectReply('a', () => {}), 'local');
    assert.match(err.message, /clashing/);
  });
});
