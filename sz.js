#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  loadZmodem,
  restoreStdin,
  setRawStdin,
  stderr,
  writeOctets,
} = require("./zmodem-node");
const { BridgeInputParser, emitBridgeMessage } = require("./windows-bridge-node");

async function main() {
  const inputPaths = process.argv.slice(2);
  if (inputPaths.length === 0 || inputPaths.includes("-h") || inputPaths.includes("--help")) {
    stderr("usage: node sz.js <file> [more files...]");
    process.exitCode = inputPaths.length === 0 ? 1 : 0;
    return;
  }

  const files = inputPaths.map((filePath) => buildFileSpec(filePath));
  if (process.platform === "win32") {
    await runWindowsBridge(files);
    return;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const Zmodem = loadZmodem();
  const sentry = new Zmodem.Sentry({
    to_terminal: () => {},
    on_detect: (detection) => {
      void handleDetection(detection, files, totalBytes).catch((error) => fatal(1, error));
    },
    on_retract: () => {},
    sender: (octets) => {
      void writeOctets(octets).catch((error) => fatal(1, error));
    },
  });

  let done = false;

  const finish = (code, error) => {
    if (done) {
      return;
    }
    done = true;
    restoreStdin();
    if (error) {
      stderr(String(error && error.stack ? error.stack : error));
    }
    process.exitCode = code;
  };

  const fatal = (code, error) => {
    finish(code, error);
  };

  process.on("SIGINT", () => finish(130));

  process.stdin.on("data", (chunk) => {
    try {
      sentry.consume(chunk);
    } catch (error) {
      fatal(1, error);
    }
  });

  process.stdin.on("end", () => {
    if (!done) {
      fatal(1, new Error("stdin ended before ZMODEM session completed"));
    }
  });

  setRawStdin();
  stderr(`sz ready: waiting for receiver (${files.length} file${files.length > 1 ? "s" : ""})`);
  await writeOctets(Zmodem.Header.build("ZRQINIT").to_hex());

  async function handleDetection(detection, fileSpecs, allBytes) {
    const session = detection.confirm();
    if (session.type !== "send") {
      throw new Error(`unexpected session type: ${session.type}`);
    }

    session.on("session_end", () => finish(0));

    let remainingBytes = allBytes;

    for (let index = 0; index < fileSpecs.length; index += 1) {
      const file = fileSpecs[index];
      stderr(`sending ${file.fullPath}`);

      const transfer = await session.send_offer({
        bytes_remaining: remainingBytes,
        files_remaining: fileSpecs.length - index,
        mode: file.mode,
        mtime: file.mtime,
        name: file.name,
        size: file.size,
      });

      if (!transfer) {
        stderr(`skipped ${file.name}`);
        remainingBytes -= file.size;
        continue;
      }

      await sendFilePayload(file.fullPath, transfer);
      stderr(`sent ${file.name}`);
      remainingBytes -= file.size;
    }

    await session.close();
  }
}

async function runWindowsBridge(files) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let finished = false;

  const finish = (code, error) => {
    if (finished) {
      return;
    }
    finished = true;
    restoreStdin();
    if (error) {
      stderr(String(error && error.stack ? error.stack : error));
    }
    process.exitCode = code;
  };

  const parser = new BridgeInputParser((message) => {
    if (!message || message.requestId !== requestId) {
      return;
    }
    if (message.op === "download_error") {
      finish(1, new Error(String(message.message || "download failed")));
      return;
    }
    if (message.op === "download_finish") {
      finish(0);
    }
  });

  process.on("SIGINT", () => finish(130));
  process.stdin.on("data", (chunk) => parser.consume(chunk));
  process.stdin.on("end", () => {
    if (!finished) {
      finish(1, new Error("stdin ended before download completed"));
    }
  });

  setRawStdin();
  stderr(`sz ready: sending ${files.length} file${files.length > 1 ? "s" : ""}`);
  emitBridgeMessage({
    op: "download_request",
    requestId,
    files: files.map((file) => ({
      fullPath: file.fullPath,
      name: file.name,
    })),
  });
}

function buildFileSpec(filePath) {
  const fullPath = path.resolve(filePath);
  const stats = fs.statSync(fullPath);

  if (!stats.isFile()) {
    throw new Error(`not a regular file: ${filePath}`);
  }

  return {
    fullPath,
    mode: stats.mode & 0o777,
    mtime: stats.mtime,
    name: path.basename(fullPath),
    size: stats.size,
  };
}

async function sendFilePayload(filePath, transfer) {
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(8192);

  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      transfer.send(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }

  await transfer.end();
}

main().catch((error) => {
  restoreStdin();
  stderr(String(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
