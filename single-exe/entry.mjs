#!/usr/bin/env bun

// 1. Injects assets to global.internalAssets
//   as { "./path/in/tar":file.bytes() }
// 2. Sets global.assetsLoaderPromise
// 3. Starts the main program only after the assets are ready
import "./assetsLoader.mjs";

await globalThis.assetsLoaderPromise;

//  gotty.js starts itself from `require.main === module`, which the
//  bundler inlines to false because this file is the entry point instead.
//  Call its exported starter directly.
const { bootstrap } = await import("../gotty.js");

await bootstrap();
