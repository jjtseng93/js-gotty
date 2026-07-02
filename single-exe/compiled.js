import { basename, dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";


const IS_COMPILED = isCompiledBinary(process.argv);
const REPO_ROOT = IS_COMPILED
  ? resolveCompiledBaseDir({ argv: process.argv })
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SINGLE_EXE_DIR = resolve(REPO_ROOT, "single-exe");
const SINGLE_EXE_ENTRY = resolve(SINGLE_EXE_DIR, "entry.mjs");


export function isCompiledBinary(argv = process.argv) {
  return Boolean(argv?.[1]?.startsWith?.("/$bunfs/"));
}

export function resolveCompiledBaseDir({ argv = process.argv, execPath = process.execPath } = {}) {
  const bn = basename(execPath);
  if (bn.startsWith("ld") || 
      bn.startsWith("libld") ||
      bn.startsWith("linker") ) {
    const realArgv = readFileSync("/proc/self/cmdline", "utf8").match(/[^\0]+/g);
    return dirname(realArgv?.[1] ?? execPath);
  }
  return dirname(execPath) || process.cwd();
}

export function resolveRepoRoot(importMetaUrl, options = {}) {
  if (isCompiledBinary(options.argv)) {
    return resolveCompiledBaseDir(options);
  }
  return resolve(dirname(fileURLToPath(importMetaUrl)), "..");
}

export async function buildExecutable(target = "",build_outfile="single.exe") {
 
  const outfile = resolve(process.cwd(), build_outfile);
  const normalizedTarget = String(target || "").trim();
  if(!globalThis.Bun)
  {
    console.log("Build exe can only be run by Bun");
    return 1;
  }
  
  let bunBin=Bun.which('bun') || process.argv0;

  const steps = [
    {
      label: "Pack assets",
      cwd: SINGLE_EXE_DIR,
      cmd: bunBin,
      args: ["./packAssets.sh"],
    },
    {
      label: "Compile executable",
      cwd: process.cwd(),
      cmd: bunBin,
      args: [
        "build",
        "--compile",
        "--bytecode",
        "--minify",
        SINGLE_EXE_ENTRY,
        `--outfile=${build_outfile}`,
        ...(normalizedTarget ? [`--target=${normalizedTarget}`] : []),
      ],
    },
  ];

  for (const step of steps) {
    console.log('');
    console.log(Bun?.markdown?.ansi?.('## '+step.label)||step.label);
  
    const result = child_process.spawnSync(step.cmd, step.args, {
      cwd: step.cwd,
      stdio: "inherit",
      env: process.env,
    });
    
    console.log("");
    console.log(Bun?.markdown?.ansi?.(
      '- Status: '+result.status+' for '+step.label
    )||result.status);
    
  }

  if(await Bun.file(outfile).exists())
    console.log(`Built executable: ${outfile}`);
  else
    console.log(`Error while building executable: ${outfile}`);
}
