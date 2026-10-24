"use strict";

// Kitty keyboard flags the browser implements (see static/js/kitty-keyboard.js).
const KITTY_KEYBOARD_SUPPORTED = 1 | 2 | 8;
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
      state.flags = value(0) & KITTY_KEYBOARD_SUPPORTED;
    } else if (prefix === "<") {
      let count = Math.min(value(0) || 1, 33);
      while (count--) {
        state.flags = state.stack.pop() ?? 0;
      }
    } else if (prefix === "=") {
      const flags = value(0) & KITTY_KEYBOARD_SUPPORTED;
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

module.exports = { TerminalModeTracker };
