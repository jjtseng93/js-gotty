const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TerminalModeTracker } = require('../terminal-modes.js');

const source = fs.readFileSync(path.join(__dirname, '../static/js/gotty.js'), 'utf8');
const methods = source.slice(source.indexOf('          applySessionModes(state)'), source.indexOf('          setDisconnected(e)'));

function feed(tracker, ...chunks) {
  for (const chunk of chunks) tracker.consume(Buffer.from(chunk, 'latin1'));
  return tracker.snapshot();
}

function client({ alternate = false, dec = {}, mouse = 'NONE', encoding = 'DEFAULT', cursorHidden = false } = {}) {
  const Wrapper = vm.runInNewContext(`(class {${methods}})`);
  const w = new Wrapper();
  const writes = [];
  const defaults = { applicationCursorKeys: false, applicationKeypad: false, bracketedPasteMode: false,
    origin: false, reverseWraparound: false, sendFocus: false, wraparound: true };
  w.term = {
    _core: { coreService: { decPrivateModes: { ...defaults, ...dec }, isCursorHidden: cursorHidden },
      coreMouseService: { activeProtocol: mouse, activeEncoding: encoding } },
    buffer: { active: { type: alternate ? 'alternate' : 'normal' } },
    write: (s) => writes.push(s),
  };
  w.kittyKeyboard = { states: { normal: { flags: 0, stack: [] }, alternate: { flags: 0, stack: [] } } };
  return { w, writes };
}

test('tracker follows DEC, mouse, alternate screen and kitty keyboard modes', () => {
  const state = feed(new TerminalModeTracker(),
    'hi\x1b[?1049h\x1b[?1;2004h\x1b=\x1b[?25l',
    '\x1b[?1002h\x1b[?10', '06h', // split across chunks
    '\x1b[>1u\x1b[>11u\x1b]0;title \x1b[?2004l\x07');
  assert.equal(state.alternate, true);
  assert.equal(state.dec.applicationCursorKeys, true);
  assert.equal(state.dec.bracketedPasteMode, true, 'OSC payload is not parsed as CSI');
  assert.equal(state.dec.applicationKeypad, true);
  assert.equal(state.cursorHidden, true);
  assert.equal(state.mouse, 'DRAG');
  assert.equal(state.encoding, 'SGR');
  assert.deepEqual(state.kitty.alternate, { flags: 11, stack: [0, 1] });
  assert.deepEqual(state.kitty.normal, { flags: 0, stack: [] });
});

test('tracker handles mode resets, kitty pop/set and RIS', () => {
  const tracker = new TerminalModeTracker();
  let state = feed(tracker, '\x1b[?1003h\x1b[?1006h\x1b[?1000l\x1b[?1006l\x1b[>1u\x1b[=8;2u\x1b[<u');
  assert.equal(state.mouse, 'NONE');
  assert.equal(state.encoding, 'DEFAULT');
  assert.equal(state.kitty.normal.flags, 0);
  state = feed(tracker, '\x1b[?1049h\x1b[?2004h\x1b[?1002h\x1b[!p');
  assert.equal(state.dec.bracketedPasteMode, false, 'DECSTR resets DEC modes');
  assert.equal(state.alternate, true, 'DECSTR keeps the active screen');
  assert.equal(state.mouse, 'DRAG', 'DECSTR keeps mouse reporting');
  state = feed(tracker, '\x1bc');
  assert.deepEqual(state, new TerminalModeTracker().snapshot());
});

test('fresh client gets the full state restored', () => {
  const state = feed(new TerminalModeTracker(), '\x1b[?1049h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[>11u');
  const { w, writes } = client();
  w.applySessionModes(state);
  assert.equal(writes.length, 1);
  for (const seq of ['\x1b[?1049h', '\x1b[?2004h', '\x1b[?1002h', '\x1b[?1006h', '\x1b[?25l'])
    assert.ok(writes[0].includes(seq), JSON.stringify(seq));
  assert.equal(w.kittyKeyboard.states.alternate.flags, 11);
});

test('socket-only reconnect with matching xterm state writes nothing', () => {
  const state = feed(new TerminalModeTracker(), '\x1b[?1049h\x1b[?6h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[>1u\x1b[>11u');
  const { w, writes } = client({ alternate: true, dec: { origin: true, bracketedPasteMode: true }, mouse: 'DRAG', encoding: 'SGR' });
  w.applySessionModes(state);
  assert.equal(writes.length, 0, 'no DECOM cursor homing or 1049 cursor save');
  w.applySessionModes(state);
  assert.deepEqual(w.kittyKeyboard.states.alternate, { flags: 11, stack: [0, 1] }, 'push stack does not grow');
});

test('stale client modes are turned off when the program disabled them while disconnected', () => {
  const state = new TerminalModeTracker().snapshot();
  const { w, writes } = client({ alternate: true, dec: { bracketedPasteMode: true }, mouse: 'ANY', encoding: 'SGR' });
  w.applySessionModes(state);
  assert.equal(writes.length, 1);
  for (const seq of ['\x1b[?1049l', '\x1b[?2004l', '\x1b[?1000l', '\x1b[?1006l'])
    assert.ok(writes[0].includes(seq), JSON.stringify(seq));
});

test('transport disconnect and reconnect clear held keys without resetting negotiation', () => {
  const start = source.indexOf('          reset() {\n            // Reconnecting');
  const reset = source.slice(start, source.indexOf('          close() {', start));
  assert.match(reset, /clearHeld\(false\)/);
  assert.doesNotMatch(reset, /kittyKeyboard.reset/);
  assert.match(source, /setDisconnected\(e\) \{\s*if \(e\) this.kittyKeyboard.clearHeld\(false\)/);
});
