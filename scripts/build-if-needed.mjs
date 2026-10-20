// scripts/build-if-needed.mjs — the `prepare` hook.
//
// `prepare` runs on every install of this package, including `npm install -g <git url>`, which is
// how a fork gets onto a machine. Without it, a git install ships no `build/` directory (it is
// gitignored) and the installed package cannot start.
//
// The build is skipped when `build/` is already newer than every source file, so the publish path
// (`prepublishOnly` then `prepare`) does not build twice, and `CONTEXT_MODE_SKIP_BUILD=1` skips it
// entirely for a source-only checkout.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const BUILD = join(ROOT, "build");

if (process.env.CONTEXT_MODE_SKIP_BUILD === "1") {
  process.exit(0);
}

// The build toolchain is a devDependency. A production install (`npm install --production`, which
// is what the in-place upgrade runs) has no devDependencies, so there is nothing to build with.
// The package is already built in that case — the copy carried build/ over — so skip rather than
// fail the install.
function hasToolchain() {
  return (
    existsSync(join(ROOT, "node_modules", "typescript", "bin", "tsc")) &&
    existsSync(join(ROOT, "node_modules", "esbuild"))
  );
}

if (!hasToolchain()) {
  console.log("context-mode: no build toolchain (devDependencies absent) — skipping build");
  process.exit(0);
}

function newestMtime(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = newestMtime(full);
      if (nested > newest) newest = nested;
      continue;
    }
    try {
      const mtime = statSync(full).mtimeMs;
      if (mtime > newest) newest = mtime;
    } catch {
      // A file that vanished mid-scan does not matter for an up-to-date check.
    }
  }
  return newest;
}

if (existsSync(BUILD)) {
  const built = newestMtime(BUILD);
  const source = newestMtime(SRC);
  // A one-second tolerance: a checkout can give a source file the same mtime as the build output.
  if (built > 0 && built + 1000 >= source) {
    process.exit(0);
  }
}

const result = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
