const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the keyboard encoder shipped in the frontend bundle.
const bundle = fs.readFileSync(path.join(__dirname, '../static/js/gotty.js'), 'utf8');
const marker = 't.evaluateKeyboardEvent = function (e, t, i, n) {';
const start = bundle.indexOf(marker);
assert.ok(start >= 0);
const end = bundle.indexOf('\n                  },\n                  482:', start);
assert.ok(end > start);
const source = bundle.slice(start + 't.evaluateKeyboardEvent = '.length, end).trim().replace(/;$/, '');
const evaluate = vm.runInNewContext(`(${source})`, { r: { C0: { ESC: '\x1b' } }, s: {} });
const arrows = [[37, 'D'], [38, 'A'], [39, 'C'], [40, 'B']];

for (const isMac of [false, true]) {
  test(`arrow modifiers stay distinct (isMac=${isMac})`, () => {
    for (const [keyCode, suffix] of arrows) {
      for (const applicationCursorMode of [false, true]) {
        const sequences = new Set();
        for (let mask = 0; mask < 8; mask++) {
          const result = evaluate({
            keyCode, metaKey: false,
            shiftKey: Boolean(mask & 1), altKey: Boolean(mask & 2), ctrlKey: Boolean(mask & 4),
          }, applicationCursorMode, isMac, false);
          const expected = mask
            ? `\x1b[1;${mask + 1}${suffix}`
            : `\x1b${applicationCursorMode ? 'O' : '['}${suffix}`;
          assert.equal(result.key, expected);
          sequences.add(result.key);
        }
        assert.equal(sequences.size, 8);
      }
    }
  });
}
