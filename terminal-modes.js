"use strict";

// All flags defined by the kitty keyboard protocol. Kept unmasked so a CLI
// client on a real kitty terminal can restore them; the browser masks its own.
const KITTY_KEYBOARD_FLAGS = 0x1f;
const TRACKED_DEC_FLAGS = {
  1: "applicationCursorKeys",
  6: "origin",
  7: "wraparound",
  45: "reverseWraparound",
  66: "applicationKeypad",
  1004: "sendFocus",
  2004: "bracketedPasteMode",
};
const MOUSE_PROTOCOLS = { 9: "X10", 1000: "VT200", 1002: "DRAG", 1003: "ANY" };
const MOUSE_ENCODINGS = { 1006: "SGR", 1016: "SGR_PIXELS" };

// Mirrors the PTY's input/protocol modes so a resumed client can be brought
// back in sync. Mode semantics follow xterm.js, which renders the output.
class TerminalModeTracker {
  constructor() {
    this.reset();
    this._state = "text";
    this._seq = "";
  }

  reset() {
    this.dec = {
      applicationCursorKeys: false,
      applicationKeypad: false,
      bracketedPasteMode: false,
      origin: false,
      reverseWraparound: false,
      sendFocus: false,
      wraparound: true,
    };
    this.cursorHidden = false;
    this.mouse = "NONE";
    this.encoding = "DEFAULT";
    this.alternate = false;
    this.kitty = { normal: { flags: 0, stack: [] }, alternate: { flags: 0, stack: [] } };
  }

  snapshot() {
    return {
      dec: { ...this.dec },
      cursorHidden: this.cursorHidden,
      mouse: this.mouse,
      encoding: this.encoding,
      alternate: this.alternate,
      kitty: {
        normal: { flags: this.kitty.normal.flags, stack: [...this.kitty.normal.stack] },
        alternate: { flags: this.kitty.alternate.flags, stack: [...this.kitty.alternate.stack] },
      },
    };
  }

  consume(buffer) {
    // Control sequences are ASCII, so bytes can be scanned without UTF-8 decoding.
    for (let i = 0; i < buffer.length; i += 1) {
      const byte = buffer[i];
      switch (this._state) {
        case "text":
          if (byte === 0x1b) {
            this._state = "esc";
          }
          break;
        case "esc":
          if (byte === 0x5b) {
            this._state = "csi";
            this._seq = "";
          } else if (byte === 0x5d || byte === 0x50 || byte === 0x5f || byte === 0x5e || byte === 0x58) {
            this._state = "string";
          } else if (byte === 0x1b) {
            this._state = "esc";
          } else if (byte >= 0x20 && byte <= 0x2f) {
            this._state = "esc-intermediate";
          } else {
            this._state = "text";
            this.handleEsc(byte);
          }
          break;
        case "esc-intermediate":
          if (byte < 0x20 || byte > 0x2f) {
            this._state = byte === 0x1b ? "esc" : "text";
          }
          break;
        case "csi":
          if (byte >= 0x40 && byte <= 0x7e) {
            this._state = "text";
            this.handleCsi(this._seq, String.fromCharCode(byte));
          } else if (byte === 0x1b) {
            this._state = "esc";
          } else if (byte === 0x18 || byte === 0x1a || this._seq.length >= 64) {
            this._state = "text";
          } else if (byte >= 0x20) {
            this._seq += String.fromCharCode(byte);
          }
          break;
        case "string":
          if (byte === 0x07 || byte === 0x18 || byte === 0x1a) {
            this._state = "text";
          } else if (byte === 0x1b) {
            this._state = "string-esc";
          }
          break;
        case "string-esc":
          this._state = byte === 0x1b ? "string-esc" : byte === 0x5c ? "text" : "string";
          break;
      }
    }
  }

  handleEsc(byte) {
    if (byte === 0x3d) {
      this.dec.applicationKeypad = true;
    } else if (byte === 0x3e) {
      this.dec.applicationKeypad = false;
    } else if (byte === 0x63) {
      this.reset();
    }
  }

  handleCsi(seq, final) {
    const prefix = /^[<=>?]/.test(seq) ? seq[0] : "";
    const body = prefix ? seq.slice(1) : seq;
    if (!/^[0-9;:]*$/.test(body)) {
      if (body === "!" && final === "p") {
        this.softReset();
      }
      return;
    }
    const params = body === "" ? [] : body.split(";").map((part) => {
      const value = Number.parseInt(part, 10);
      return Number.isFinite(value) ? value : 0;
    });
    if (prefix === "?" && (final === "h" || final === "l")) {
      for (const mode of params) {
        this.setPrivateMode(mode, final === "h");
      }
    } else if (final === "u" && prefix !== "?") {
      this.handleKittyKeyboard(prefix, params);
    }
  }

  softReset() {
    // DECSTR keeps the active screen and mouse reporting, like xterm.js.
    const { alternate, mouse, encoding } = this;
    this.reset();
    Object.assign(this, { alternate, mouse, encoding });
  }

  setPrivateMode(mode, enabled) {
    if (TRACKED_DEC_FLAGS[mode]) {
      this.dec[TRACKED_DEC_FLAGS[mode]] = enabled;
    } else if (MOUSE_PROTOCOLS[mode]) {
      this.mouse = enabled ? MOUSE_PROTOCOLS[mode] : "NONE";
    } else if (MOUSE_ENCODINGS[mode]) {
      this.encoding = enabled ? MOUSE_ENCODINGS[mode] : "DEFAULT";
    } else if (mode === 25) {
      this.cursorHidden = !enabled;
    } else if (mode === 47 || mode === 1047 || mode === 1049) {
      this.alternate = enabled;
    }
  }

  handleKittyKeyboard(prefix, params) {
    const state = this.kitty[this.alternate ? "alternate" : "normal"];
    const value = (index, fallback = 0) => (Number.isInteger(params[index]) ? params[index] : fallback);
    if (prefix === ">") {
      state.stack.push(state.flags);
      if (state.stack.length > 32) {
        state.stack.shift();
      }
      state.flags = value(0) & KITTY_KEYBOARD_FLAGS;
    } else if (prefix === "<") {
      let count = Math.min(value(0) || 1, 33);
      while (count--) {
        state.flags = state.stack.pop() ?? 0;
      }
    } else if (prefix === "=") {
      const flags = value(0) & KITTY_KEYBOARD_FLAGS;
      const mode = value(1) || 1;
      if (mode === 1) {
        state.flags = flags;
      } else if (mode === 2) {
        state.flags |= flags;
      } else if (mode === 3) {
        state.flags &= ~flags;
      }
    }
  }
}

const DEFAULT_MODES = new TerminalModeTracker().snapshot();
const MOUSE_PROTOCOL_MODES = { X10: 9, VT200: 1000, DRAG: 1002, ANY: 1003 };
const MOUSE_ENCODING_MODES = { SGR: 1006, SGR_PIXELS: 1016 };

// Turns off what a previous client may have left on, using only sequences that
// are harmless on a clean terminal: no queries, nothing that moves the cursor.
const STARTUP_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1004l\x1b[?2004l" +
  "\x1b[?1l\x1b>\x1b[?25h\x1b[<100u";

function sameKitty(a, b) {
  return a.flags === b.flags && a.stack.length === b.stack.length &&
    a.stack.every((flags, index) => flags === b.stack[index]);
}

function kittyRebuild(state) {
  // Popping past the bottom clears the stack and flags; then rebuild bottom-up.
  let sequence = "\x1b[<100u";
  if (state.stack.length === 0) {
    return state.flags ? `${sequence}\x1b[=${state.flags};1u` : sequence;
  }
  sequence += `\x1b[=${state.stack[0]};1u`;
  for (const flags of state.stack.slice(1)) {
    sequence += `\x1b[>${flags}u`;
  }
  return `${sequence}\x1b[>${state.flags}u`;
}

// Escape sequence that moves a terminal known to be in `from` to `to`, emitting
// only differences: DECOM homes the cursor and 1049 overwrites the saved cursor.
function modeTransition(from, to = DEFAULT_MODES) {
  let sequence = "";
  const fromScreen = from.alternate ? "alternate" : "normal";
  const toScreen = to.alternate ? "alternate" : "normal";
  // Kitty keyboard stacks are per screen, so each is fixed while it is active.
  if (!sameKitty(from.kitty[fromScreen], to.kitty[fromScreen])) {
    sequence += kittyRebuild(to.kitty[fromScreen]);
  }
  if (fromScreen !== toScreen) {
    sequence += `\x1b[?1049${to.alternate ? "h" : "l"}`;
    if (!sameKitty(from.kitty[toScreen], to.kitty[toScreen])) {
      sequence += kittyRebuild(to.kitty[toScreen]);
    }
  }
  for (const [mode, name] of Object.entries(TRACKED_DEC_FLAGS)) {
    if (!!from.dec[name] === !!to.dec[name]) {
      continue;
    }
    if (name === "applicationKeypad") {
      sequence += to.dec[name] ? "\x1b=" : "\x1b>"; // more widely supported than ?66
    } else {
      sequence += `\x1b[?${mode}${to.dec[name] ? "h" : "l"}`;
    }
  }
  if (!!from.cursorHidden !== !!to.cursorHidden) {
    sequence += `\x1b[?25${to.cursorHidden ? "l" : "h"}`;
  }
  if (from.mouse !== to.mouse) {
    sequence += MOUSE_PROTOCOL_MODES[to.mouse]
      ? `\x1b[?${MOUSE_PROTOCOL_MODES[to.mouse]}h`
      : `\x1b[?${MOUSE_PROTOCOL_MODES[from.mouse]}l`;
  }
  if (from.encoding !== to.encoding) {
    sequence += MOUSE_ENCODING_MODES[to.encoding]
      ? `\x1b[?${MOUSE_ENCODING_MODES[to.encoding]}h`
      : `\x1b[?${MOUSE_ENCODING_MODES[from.encoding]}l`;
  }
  return sequence;
}

module.exports = { TerminalModeTracker, modeTransition, STARTUP_RESET };
