// tests/core/fork.test.ts
// Fork-only behaviour: the upgrade source and the version check are resolved at runtime, so a fork
// install upgrades the fork instead of replacing itself with upstream's files.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
