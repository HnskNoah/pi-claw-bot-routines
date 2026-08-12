/**
 * pi-routines fork deploy
 *
 * This repo is a full fork of @davecodes/pi-routines (baseline v0.5.1) —
 * all source lives here. This script is the only deploy entry point: it
 * syncs the fork into pi's installed copy of the package.
 *
 * Runs on Node ≥22 with native type stripping:
 *   node deploy.ts          # sync + restore missing deps
 *   node deploy.ts --check  # report diffs only, write nothing
 *
 * Workflow (user convention):
 *   edit fork source → node deploy.ts → npx tsc --noEmit (in install dir)
 *   → deploy is confirmed good → done.
 * The fork has no node_modules; type-check against the installed copy.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const here = import.meta.dirname;
const pkg = JSON.parse(
  fs.readFileSync(path.join(here, "package.json"), "utf8"),
) as { version: string; dependencies?: Record<string, string> };
const pkgDir =
  process.env.PI_ROUTINES_DIR ??
  path.join(
    os.homedir(),
    ".pi",
    "agent",
    "npm",
    "node_modules",
    "@davecodes",
    "pi-routines",
  );
const checkOnly = process.argv.includes("--check");
const ROOTS = ["src", "extensions", "tsconfig.json", "package.json"];

function walkFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(path.join(dir, entry.name), rel));
    else if (/\.(ts|json)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// 1) upstream baseline check
let installed: { version: string; dependencies?: Record<string, string> };
try {
  installed = JSON.parse(
    fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
  );
} catch {
  console.error(`✗ installed pi-routines not found at ${pkgDir}`);
  process.exit(1);
}
if (installed.version !== pkg.version) {
  console.warn(
    `⚠ fork baseline v${pkg.version} ≠ installed v${installed.version} — ` +
      `upstream may have upgraded; re-check before deploying`,
  );
}

// 2) enumerate fork files (src + extensions trees, plus root configs)
const rels: string[] = [];
for (const root of ROOTS) {
  const abs = path.join(here, root);
  if (fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    rels.push(...walkFiles(abs, root));
  } else if (fs.existsSync(abs)) {
    rels.push(root);
  }
}

// 3) sync (or report)
let copied = 0;
let changed = 0;
for (const rel of rels) {
  const src = path.join(here, rel);
  const dst = path.join(pkgDir, rel);
  const srcText = fs.readFileSync(src, "utf8");
  const dstSame = fs.existsSync(dst) && fs.readFileSync(dst, "utf8") === srcText;
  if (dstSame) continue;
  changed++;
  if (checkOnly) {
    console.log(`  ~ ${rel}`);
    continue;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied++;
}

// 4) restore missing dependencies (from fork package.json deps)
const forkDeps = pkg.dependencies ?? {};
const missing = Object.keys(forkDeps).filter((d) => !installed.dependencies?.[d]);
if (missing.length > 0 && !checkOnly) {
  console.log(`⏳ installing missing deps: ${missing.join(", ")} ...`);
  try {
    execSync(
      `npm install ${missing.map((d) => `${d}@${forkDeps[d]}`).join(" ")}`,
      { cwd: pkgDir, stdio: "inherit" },
    );
    console.log("✓ deps installed");
  } catch (e) {
    console.error("✗ dep install failed — run it manually:", String(e));
  }
}

if (checkOnly) {
  console.log(
    changed === 0
      ? `✓ in sync (${rels.length} files identical)`
      : `${changed} file(s) differ — deploy to apply`,
  );
} else {
  console.log(`✓ deployed ${copied}/${rels.length} files to ${pkgDir}`);
  console.log(
    "  Next: /reload pi (and run `npx tsc --noEmit` in the package dir to be safe).",
  );
}