// src/fork.ts — fork-only: where `/ctx-upgrade` pulls from, and which npm package it version-checks.
//
// Upstream's defaults point at upstream. Left alone, an upgrade clones upstream and copies its files
// over this install — silently dropping every fix the fork carries (OpenCode 2 support, the
// cherry-picked upstream PRs, the security fixes). That is the one failure mode a fork install
// cannot recover from by accident, so the source is resolved at runtime instead of hardcoded.
//
// Resolution order: environment variable → ~/.context-mode/fork.json → the upstream default.
// scripts/install-fork.sh writes the file; deleting it restores upstream behaviour.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Upstream's GitHub slug. The default target when no fork config is present. */
export const UPSTREAM_REPO = "mksglu/context-mode";

/** Upstream's npm package. The default target of the version check. */
export const UPSTREAM_PACKAGE = "context-mode";

export const UPDATE_REPO_ENV = "CONTEXT_MODE_UPDATE_REPO";
export const UPDATE_PACKAGE_ENV = "CONTEXT_MODE_UPDATE_PACKAGE";

interface ForkConfig {
  /** GitHub slug (owner/repo) the upgrade clones. */
  repo?: string;
  /**
   * npm package the version check reads. An empty string disables the check — used when the fork is
   * not published to npm, so `ctx_doctor` stops comparing against upstream's release.
   */
  package?: string;
}

function configPath(): string {
  return join(homedir(), ".context-mode", "fork.json");
}

function readConfig(): ForkConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ForkConfig;
  } catch {
    // No fork config, or it is not readable — upstream defaults apply.
  }
  return {};
}

function pick(envValue: string | undefined, fileValue: string | undefined, fallback: string): string {
  const fromEnv = envValue?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = fileValue?.trim();
  if (fromFile) return fromFile;
  return fallback;
}

/**
 * The package value, honouring an explicitly empty one. The empty string is meaningful: it disables
 * the version check. It must not fall through to the default the way a missing value does.
 */
function pickPackage(envValue: string | undefined, fileValue: string | undefined): string {
  const fromEnv = envValue?.trim();
  if (fromEnv) return fromEnv;
  if (fileValue !== undefined) return fileValue.trim();
  return UPSTREAM_PACKAGE;
}

/** The GitHub slug the upgrade clones from — this fork's repo on a fork install. */
export function updateRepo(): string {
  const cfg = readConfig();
  return pick(process.env[UPDATE_REPO_ENV], cfg.repo, UPSTREAM_REPO);
}

/** The clone URL for `updateRepo()`. */
export function updateRepoUrl(): string {
  return `https://github.com/${updateRepo()}.git`;
}

/**
 * The npm package the version check reads, or `null` when the check is disabled. Disabled when the
 * fork is not published under that name: comparing a fork build against an unrelated package's
 * release would report a permanent, meaningless "outdated".
 */
export function updatePackage(): string | null {
  const cfg = readConfig();
  const raw = pickPackage(process.env[UPDATE_PACKAGE_ENV], cfg.package);
  if (raw === "" || raw === "none" || raw === "off") return null;
  return raw;
}

/** The registry URL for the version check, or `null` when the check is disabled. */
export function updateRegistryUrl(): string | null {
  const pkg = updatePackage();
  if (pkg === null) return null;
  return `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
}

/** True when this install is pointed at something other than upstream. */
export function isForkInstall(): boolean {
  return updateRepo() !== UPSTREAM_REPO;
}

/**
 * The file inside an install that records the commit it was built from. A fork keeps upstream's
 * version number, so the version cannot say whether an install is current — the commit can.
 */
export const FORK_COMMIT_MARKER = ".context-mode-fork-commit";

/** The commit an install was built from, or "" when it is unknown. */
export function readCommitMarker(path: string): string {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

/** Record the commit an install was built from, so the next upgrade can tell whether it is current. */
export function writeCommitMarker(path: string, sha: string): void {
  try {
    writeFileSync(path, `${sha}\n`);
  } catch {
    // Best effort — the marker only saves a redundant upgrade.
  }
}
