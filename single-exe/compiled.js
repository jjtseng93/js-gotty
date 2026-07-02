import { basename, dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import child_process from "node:child_process";


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



    if (result.error || result.status !== 0) {
    
      if (result.error) {
        console.error(result.error);
      }
      
      if (step.label == "Pack assets") {
        console.log("Pack assets failed; continuing with the existing assets.tar if available");
      }
      
    }
    
    
  }  //  for steps of build

  if(await Bun.file(outfile).exists())
  {
    console.log(`Built executable: ${outfile}`);
    return 0;
  }
  else
  {
    console.log(`Error while building executable: ${outfile}`);
    return 1;
  }
}

export const buildExe = buildExecutable;

export async function buildEarlyExit(argv = process.argv,build_outfile) {
  const buildExeIndex = argv.indexOf("--build-exe");
  const buildForIndex = argv.indexOf("--build-for");

  if (buildExeIndex === -1 && buildForIndex === -1) {
    return false;
  }

  if (buildForIndex !== -1) {
    const target = argv[buildForIndex + 1];
    if (!target || target.startsWith("-")) {
      console.error("Missing value for --build-for");
      process.exit(2);
    }
    process.exit(await buildExe(target,build_outfile));
  }

  process.exit(await buildExe(null,build_outfile));
}
