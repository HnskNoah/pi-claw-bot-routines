#!/usr/bin/env node
/**
 * Re-apply the pi-routines patches (this directory) onto the installed copy.
 *
 * The patched source lives in node_modules and is LOST when the extension is
 * reinstalled/upgraded. Run this after `npm i -g` / extension upgrade, then
 * `/reload` pi.
 *
 * Usage: node apply.js [path-to-pi-routines-package]
 *   (defaults to $PI_ROUTINES_DIR or ~/.pi/agent/npm/node_modules/@davecodes/pi-routines)
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const here = __dirname;
const expectedVersion = "0.5.1"; // baseline package version these patches were made against

const pkgDir =
  process.env.PI_ROUTINES_DIR ||
  path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@davecodes", "pi-routines");

const files = [
  "src/github-poller.ts",
  "src/executor.ts",
  "src/parser.ts",
  "src/types.ts",
  "src/store.ts",
  "src/tools/routine-create.ts",
  "src/tools/_mutate.ts",
];

function main() {
  if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
    console.error(`✗ pi-routines not found at ${pkgDir}`);
    console.error("  Pass the path explicitly, e.g. node apply.js /path/to/pi-routines");
    process.exit(1);
  }
  const installed = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  if (installed.version !== expectedVersion) {
    console.warn(
      `⚠ installed version is ${installed.version}, patches were made against ${expectedVersion}. ` +
        "Overwriting anyway — verify with `tsc --noEmit` (in the package dir) afterwards.",
    );
  }
  let ok = 0;
  for (const rel of files) {
    const src = path.join(here, rel);
    const dst = path.join(pkgDir, rel);
    if (!fs.existsSync(src)) {
      console.error(`✗ missing patch file: ${rel} — run from the patches dir`);
      continue;
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    ok++;
  }
  console.log(`✓ applied ${ok}/${files.length} patched files to ${pkgDir}`);
  console.log("  Next: /reload pi (and re-run `npx tsc --noEmit` in the package dir to be safe).");
}

main();
