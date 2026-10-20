// tests/core/fork.test.ts
// Fork-only behaviour: the upgrade source and the version check are resolved at runtime, so a fork
// install upgrades the fork instead of replacing itself with upstream's files.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UPSTREAM_REPO,
  UPSTREAM_PACKAGE,
  updateRepo,
  updateRepoUrl,
  updatePackage,
  updateRegistryUrl,
  isForkInstall,
  FORK_COMMIT_MARKER,
  readCommitMarker,
  writeCommitMarker,
} from "../../src/fork.js";

const REPO_ENV = "CONTEXT_MODE_UPDATE_REPO";
const PACKAGE_ENV = "CONTEXT_MODE_UPDATE_PACKAGE";

let home: string;
let savedHome: string | undefined;
let savedRepo: string | undefined;
let savedPackage: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cm-fork-"));
  mkdirSync(join(home, ".context-mode"), { recursive: true });
  savedHome = process.env.HOME;
  savedRepo = process.env[REPO_ENV];
  savedPackage = process.env[PACKAGE_ENV];
  process.env.HOME = home;
  delete process.env[REPO_ENV];
  delete process.env[PACKAGE_ENV];
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedRepo === undefined) delete process.env[REPO_ENV];
  else process.env[REPO_ENV] = savedRepo;
  if (savedPackage === undefined) delete process.env[PACKAGE_ENV];
  else process.env[PACKAGE_ENV] = savedPackage;
  rmSync(home, { recursive: true, force: true });
});

describe("fork update source", () => {
  it("defaults to upstream when nothing is configured", () => {
    expect(updateRepo()).toBe(UPSTREAM_REPO);
    expect(updateRepoUrl()).toBe(`https://github.com/${UPSTREAM_REPO}.git`);
    expect(updatePackage()).toBe(UPSTREAM_PACKAGE);
    expect(updateRegistryUrl()).toBe("https://registry.npmjs.org/context-mode/latest");
    expect(isForkInstall()).toBe(false);
  });

  it("reads the repo and package from ~/.context-mode/fork.json", () => {
    writeFileSync(
      join(home, ".context-mode", "fork.json"),
      JSON.stringify({ repo: "Scratchydisk/context-mode", package: "" }),
    );
    expect(updateRepo()).toBe("Scratchydisk/context-mode");
    expect(updateRepoUrl()).toBe("https://github.com/Scratchydisk/context-mode.git");
    expect(isForkInstall()).toBe(true);
  });

  it("disables the version check when the package is empty", () => {
    writeFileSync(
      join(home, ".context-mode", "fork.json"),
      JSON.stringify({ repo: "Scratchydisk/context-mode", package: "" }),
    );
    expect(updatePackage()).toBeNull();
    expect(updateRegistryUrl()).toBeNull();
  });

  it("lets the environment override the config file", () => {
    writeFileSync(
      join(home, ".context-mode", "fork.json"),
      JSON.stringify({ repo: "Scratchydisk/context-mode" }),
    );
    process.env[REPO_ENV] = "someone/else";
    expect(updateRepo()).toBe("someone/else");
  });

  it("uses a configured clone url when one is set", () => {
    writeFileSync(
      join(home, ".context-mode", "fork.json"),
      JSON.stringify({ repo: "Scratchydisk/context-mode", url: "git@github.com:Scratchydisk/context-mode.git" }),
    );
    expect(updateRepoUrl()).toBe("git@github.com:Scratchydisk/context-mode.git");
  });

  it("ignores a malformed or unreadable config file", () => {
    writeFileSync(join(home, ".context-mode", "fork.json"), "{ not json");
    expect(updateRepo()).toBe(UPSTREAM_REPO);
  });

  it("never points the upgrade at upstream when a fork is configured", () => {
    writeFileSync(
      join(home, ".context-mode", "fork.json"),
      JSON.stringify({ repo: "Scratchydisk/context-mode", package: "" }),
    );
    expect(updateRepoUrl()).not.toContain("mksglu/context-mode");
  });
});

describe("fork commit marker", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cm-fork-marker-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips a commit sha", () => {
    const path = join(home, FORK_COMMIT_MARKER);
    expect(readCommitMarker(path)).toBe("");
    writeCommitMarker(path, "abc123def456");
    expect(readCommitMarker(path)).toBe("abc123def456");
  });

  it("reads an empty string when the marker is missing or unreadable", () => {
    expect(readCommitMarker(join(home, "nope"))).toBe("");
  });
});

describe("fork-aware upgrade short-circuit", () => {
  // The fork and upstream share a version number forever, so a version comparison would always say
  // "already on latest" and skip the file copy — leaving the install running upstream's code.
  it("cli.ts compares commits rather than versions for a fork install", () => {
    const src = readFileSync(
      new URL("../../src/cli.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(src).toContain("isForkInstall()");
    expect(src).toContain("readCommitMarker");
    expect(src).toContain("writeCommitMarker");
    expect(src).toContain("localSha === cloneSha");
  });
});
