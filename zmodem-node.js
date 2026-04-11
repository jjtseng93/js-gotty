const fs = require("fs");
const path = require("path");
const vm = require("vm");

let cachedZmodem = null;

function loadZmodem() {
  if (cachedZmodem) {
    return cachedZmodem;
  }

  const bundlePath = path.join(__dirname, "static", "js", "zmodem.js");
  const source = fs.readFileSync(bundlePath, "utf8");
  const quietConsole = {
    debug() {},
    log() {},
    warn() {},
    error: (...args) => process.stderr.write(`${args.join(" ")}\n`),
  };

  const context = {
    Array,
    ArrayBuffer,
    Blob: typeof Blob === "undefined" ? undefined : Blob,
    Buffer,
    Date,
    Int32Array,
    Math,
    Object,
    Promise,
    TextDecoder,
    TextEncoder,
    URL: typeof URL === "undefined" ? undefined : URL,
    Uint8Array,
    clearTimeout,
    console: quietConsole,
    setTimeout,
  };
  context.window = context;
  context.global = context;
  context.globalThis = context;

  vm.runInNewContext(source, context, { filename: bundlePath });

  if (!context.Zmodem) {
    throw new Error("failed to load ZMODEM bundle");
  }

  cachedZmodem = context.Zmodem;
  return cachedZmodem;
}

function writeOctets(octets) {
  let buffer = Buffer.isBuffer(octets) ? octets : Buffer.from(octets);
  if (process.stdout.isTTY && process.platform !== "win32") {
    buffer = normalizeTtyOutput(buffer);
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(buffer, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function normalizeTtyOutput(buffer) {
  const output = Buffer.allocUnsafe(buffer.length);
  for (let index = 0; index < buffer.length; index += 1) {
    const value = buffer[index];
    output[index] = value === 0x0a ? 0x8a : value;
  }
  return output;
}

function setRawStdin() {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
}

function restoreStdin() {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

function stderr(message) {
  process.stderr.write(`${message}\n`);
}

function basenameSafe(name) {
  const base = path.basename(name || "");
  if (!base || base === "." || base === "..") {
    throw new Error(`invalid filename from peer: ${JSON.stringify(name)}`);
  }
  return base;
}

module.exports = {
  basenameSafe,
  loadZmodem,
  restoreStdin,
  setRawStdin,
  stderr,
  writeOctets,
};
