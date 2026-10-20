/**
 * adapters/opencode — OpenCode platform adapter.
 *
 * Implements HookAdapter for OpenCode's TypeScript plugin paradigm.
 *
 * OpenCode hook specifics:
 *   - I/O: TS plugin functions (not JSON stdin/stdout)
 *   - Hook names: tool.execute.before, tool.execute.after, experimental.session.compacting
 *   - Arg modification: output.args mutation
 *   - Blocking: throw Error in tool.execute.before
 *   - Output modification: output.output mutation (TUI bug for bash #13575)
 *   - SessionStart: broken (#14808, no hook #5409)
 *   - Session ID: input.sessionID (camelCase!)
 *   - Project dir: ctx.directory in plugin init (no env var)
 *   - Config: opencode.json plugin array, .opencode/plugins/*.ts
 *   - Session dir: ~/.config/opencode/context-mode/sessions/
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  accessSync,
  existsSync,
  constants,
} from "node:fs";
import { resolve, join, dirname, extname, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BaseAdapter, resolveContextModeDataRoot } from "../base.js";
import { stripJsonComments } from "../../util/jsonc.js";

import type {
  HookAdapter,
  HookParadigm,
  PlatformCapabilities,
  DiagnosticResult,
  PreToolUseEvent,
  PostToolUseEvent,
  PreCompactEvent,
  SessionStartEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  PreCompactResponse,
  SessionStartResponse,
  HookRegistration,
  PlatformId,
} from "../types.js";

// ─────────────────────────────────────────────────────────
// OpenCode raw input types
// ─────────────────────────────────────────────────────────

/** Represents the combined input+output from OpenCode hooks, flattened for adapter parse methods. */
interface OpenCodeHookInput {
  /** From input.tool (both before and after hooks) */
  tool?: string;
  /** From input.sessionID */
  sessionID?: string;
  /** From input.callID */
  callID?: string;
  /** From output.args (before hook) or input.args (after hook) */
  args?: Record<string, unknown>;
  /** From output.output (after hook) */
  output?: string;
  /** From output.title (after hook) */
  title?: string;
  /** From output.metadata (after hook) */
  metadata?: unknown;
  /** For session start source (custom) */
  source?: string;
}

// ─────────────────────────────────────────────────────────
// Hook constants (re-exported from hooks.ts)
// ─────────────────────────────────────────────────────────

import { HOOK_TYPES as OPENCODE_HOOK_NAMES } from "./hooks.js";

// ─────────────────────────────────────────────────────────
// Adapter implementation
// ─────────────────────────────────────────────────────────

export type AdapterPlatformType = Extract<PlatformId, "opencode" | "kilo">;

/**
 * The OpenCode major version this install is talking to, or `null` when it cannot be determined.
 *
 * OpenCode 2 renamed the plugin config key from `plugin` to `plugins` and its config normaliser merges
 * the legacy key into the same list, so the two cannot both be written. The version decides which key
 * this adapter uses. `null` means "unknown" — the V1 key is the safe default, because a V1 host
 * ignores an unknown `plugins` key while a V2 host would still read a legacy `plugin` entry.
 *
 * `CONTEXT_MODE_OPENCODE_MAJOR` overrides the probe, so a test — or a host that is not on PATH — can
 * pin the generation without depending on which OpenCode happens to be installed.
 */
function detectOpencodeMajor(): number | null {
  const override = process.env.CONTEXT_MODE_OPENCODE_MAJOR?.trim();
  if (override) {
    const parsed = Number(override);
    if (Number.isFinite(parsed)) return parsed;
  }
  try {
    const out = execFileSync("opencode", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /(\d+)\.(\d+)/.exec(out);
    return match ? Number(match[1]) : null;
  } catch {
    // opencode is not on PATH, or it failed — treat as unknown.
    return null;
  }
}

export class OpenCodeAdapter extends BaseAdapter implements HookAdapter {
  get name(): string {
    return this.platform === "kilo" ? "KiloCode" : "OpenCode";
  }
  readonly paradigm: HookParadigm = "ts-plugin";
  private settingsPath?: string;

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: true, // experimental
    sessionStart: true,
    canModifyArgs: true,
    canModifyOutput: true, // with TUI bug caveat for bash (#13575)
    canInjectSessionContext: true,
  };

  private platform: AdapterPlatformType;

  constructor(platform: AdapterPlatformType = "opencode") {
    // sessionDirSegments unused — opencode overrides getSessionDir()
    // with XDG_CONFIG_HOME / APPDATA logic
    super([".config", platform]);
    this.platform = platform;
  }

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as OpenCodeHookInput;
    return {
      toolName: input.tool ?? "",
      toolInput: input.args ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as OpenCodeHookInput;
    return {
      toolName: input.tool ?? "",
      toolInput: input.args ?? {},
      toolOutput: input.output,
      isError: undefined, // OpenCode doesn't provide isError
      sessionId: this.extractSessionId(input),
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parsePreCompactInput(raw: unknown): PreCompactEvent {
    const input = raw as OpenCodeHookInput;
    return {
      sessionId: this.extractSessionId(input),
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  parseSessionStartInput(raw: unknown): SessionStartEvent {
    const input = raw as OpenCodeHookInput;
    const rawSource = input.source ?? "startup";

    let source: SessionStartEvent["source"];
    switch (rawSource) {
      case "compact":
        source = "compact";
        break;
      case "resume":
        source = "resume";
        break;
      case "clear":
        source = "clear";
        break;
      default:
        source = "startup";
    }

    return {
      sessionId: this.extractSessionId(input),
      source,
      projectDir: process.env.OPENCODE_PROJECT_DIR || process.cwd(),
      raw,
    };
  }

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    if (response.decision === "deny") {
      // OpenCode TS plugin paradigm: throw Error to block
      throw new Error(
        response.reason ?? "Blocked by context-mode hook",
      );
    }
    if (response.decision === "modify" && response.updatedInput) {
      // OpenCode: output.args mutation
      return { args: response.updatedInput };
    }
    if (response.decision === "ask") {
      // OpenCode: no native "ask" mechanism — throw to be safe
      throw new Error(
        response.reason ?? "Action requires user confirmation (security policy)",
      );
    }
    // "context" — OpenCode's tool.execute.before cannot inject additionalContext
    // in PreToolUse (platform limitation). The guidance is delivered via
    // CLAUDE.md/AGENTS.md routing instructions instead. Passthrough.
    // "allow" — passthrough
    return undefined;
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    const result: Record<string, unknown> = {};
    if (response.updatedOutput) {
      // OpenCode: output.output mutation (TUI bug for bash #13575)
      result.output = response.updatedOutput;
    }
    if (response.additionalContext) {
      result.additionalContext = response.additionalContext;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  formatPreCompactResponse(response: PreCompactResponse): unknown {
    // experimental.session.compacting — return context string
    return response.context ?? "";
  }

  formatSessionStartResponse(response: SessionStartResponse): unknown {
    return response.context ?? "";
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    if (this.settingsPath) return this.settingsPath;
    // Edge case (#849): writeSettings() called without a prior readSettings()
    // (which is what populates this.settingsPath).
    //
    // Prefer an existing config, in the same order paths() searches: the project-local `.jsonc`
    // first, because OpenCode merges the project-root `.jsonc` LAST, so it is the authoritative
    // config (refs/platforms/opencode/packages/opencode/src/config/config.ts:406-408 +
    // paths.ts:15-22), and writing into a `.json` that shadows it destroys the user's settings.
    //
    // With no config anywhere, the target is the global file. Creating one in the current
    // directory instead would leave a stray opencode.json wherever the command happened to run,
    // and that file would shadow the global config rather than extend it.
    for (const candidate of this.paths()) {
      if (existsSync(candidate)) return candidate;
    }
    return join(homedir(), ".config", this.platform, `${this.platform}.json`);
  }

  private paths(): string[] {
    // `.jsonc` is listed BEFORE `.json` so it is selected as the write target
    // when both exist (#849). OpenCode loads the project-root `.json` then
    // `.jsonc` and merges `.jsonc` last — scalars override-last, arrays concat
    // (refs/platforms/opencode/packages/opencode/src/config/config.ts:406-408,
    // 258-260 + paths.ts:15-22). The `.jsonc` is therefore the authoritative
    // file holding the user's real config; a `.json` is often an empty/auto-
    // generated placeholder. Writing into the placeholder would create a
    // file that shadows the user's real `.jsonc`. Preferring `.jsonc` for the
    // write target avoids that silent config destruction. Read order is
    // irrelevant for the plugin early-return (hasContextModePlugin) path.
    if (this.platform === "kilo") {
      // Kilo runtime accepts `.kilo/`, `.kilocode/`, and `.opencode/` as
      // project config dirs (refs/platforms/kilo/packages/opencode/src/
      // kilocode/config/config.ts:50,408). Mirror that here so context-mode
      // discovers config regardless of which suffix the user adopted.
      return [
        resolve("kilo.jsonc"),
        resolve("kilo.json"),
        resolve(".kilo", "kilo.jsonc"),
        resolve(".kilo", "kilo.json"),
        resolve(".kilocode", "kilo.jsonc"),
        resolve(".kilocode", "kilo.json"),
        join(homedir(), ".config", "kilo", "kilo.jsonc"),
        join(homedir(), ".config", "kilo", "kilo.json"),
      ];
    }
    return [
      resolve("opencode.jsonc"),
      resolve("opencode.json"),
      resolve(".opencode", "opencode.jsonc"),
      resolve(".opencode", "opencode.json"),
      join(homedir(), ".config", "opencode", "opencode.jsonc"),
      join(homedir(), ".config", "opencode", "opencode.json"),
    ];
  }

  getSessionDir(): string {
    // Issue #649: honor CONTEXT_MODE_DATA_DIR universal storage override
    // ahead of OpenCode/Kilo's XDG-rooted default. opencode.json + plugin
    // discovery stay under getConfigDir() so OpenCode itself sees its own
    // config in the expected location.
    const override = resolveContextModeDataRoot();
    const dir = override
      ? join(override, "context-mode", "sessions")
      : join(this.getConfigDir(), "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * OpenCode/KiloCode honor XDG_CONFIG_HOME on POSIX and APPDATA on Windows.
   * Falls back to ~/.config/<platform> (or %APPDATA%\<platform>).
   * Always absolute. `_projectDir` is accepted for interface symmetry but
   * unused — config is home/XDG-rooted, never project-scoped.
   */
  getConfigDir(_projectDir?: string): string {
    let root: string;
    if (process.platform === "win32") {
      root = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    } else {
      root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    }
    return join(root, this.platform);
  }

  getInstructionFiles(): string[] {
    return ["AGENTS.md"];
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    // OpenCode uses TS plugin paradigm — hooks are registered via plugin array
    // in opencode.json, not via command-based hook entries.
    // Return the hook name mapping for documentation purposes.
    return {
      [OPENCODE_HOOK_NAMES.BEFORE]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
      [OPENCODE_HOOK_NAMES.AFTER]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
      [OPENCODE_HOOK_NAMES.COMPACTING]: [
        {
          matcher: "",
          hooks: [
            {
              type: "plugin",
              command: "context-mode",
            },
          ],
        },
      ],
    };
  }

  readSettings(): Record<string, unknown> | null {
    this.settingsPath = undefined;
    const configPaths = this.paths();
    const globalPaths = new Set(configPaths.filter(p => p.includes(homedir())));
    let firstValidSettings: Record<string, unknown> | null = null;
    let firstValidPath: string | undefined;

    for (const configPath of configPaths) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const text = configPath.endsWith(".jsonc") ? stripJsonComments(raw) : raw;
        const settings = JSON.parse(text) as Record<string, unknown>;

        if (!firstValidSettings) {
          firstValidSettings = settings;
          firstValidPath = configPath;
        }

        const isGlobalConfig = globalPaths.has(configPath);

        if (this.hasContextModePlugin(settings) || isGlobalConfig) {
          this.settingsPath = configPath;
          return settings;
        }
      } catch {
        continue;
      }
    }

    if (firstValidSettings) {
      this.settingsPath = firstValidPath;
      return firstValidSettings;
    }
    return null;
  }

  writeSettings(settings: Record<string, unknown>): void {
    // Write to opencode.json(c)/kilo.json(c) in current directory
    writeFileSync(
      this.getSettingsPath(),
      JSON.stringify(settings, null, 2) + "\n",
      "utf-8",
    );
  }

  // ── Diagnostics (doctor) ─────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const settings = this.readSettings();

    if (!settings) {
      results.push({
        check: "Plugin configuration",
        status: "fail",
        message: `Could not read ${this.platform}.json or ${this.platform}.jsonc`,
        fix: "context-mode upgrade",
      });
      return results;
    }

    // Check for "context-mode" in the plugin array. OpenCode 2 reads `plugins` and merges the legacy
    // `plugin` key into the same list, so either key counts.
    const hasPlugin = this.hasContextModePlugin(settings);
    const pluginKey = Array.isArray(settings.plugins)
      ? "plugins"
      : Array.isArray(settings.plugin)
        ? "plugin"
        : undefined;
    if (pluginKey !== undefined) {
      results.push({
        check: "Plugin registration",
        status: hasPlugin ? "pass" : "fail",
        message: hasPlugin
          ? `context-mode found in ${pluginKey} array`
          : `context-mode not found in ${pluginKey} array`,
        fix: hasPlugin
          ? undefined
          : "context-mode upgrade",
      });
    } else {
      results.push({
        check: "Plugin registration",
        status: "fail",
        message: `No plugin array found in ${this.platform}.json or ${this.platform}.jsonc`,
        fix: "context-mode upgrade",
      });
    }

    if (this.hasLegacyContextModeMcp(settings)) {
      results.push({
        check: "Legacy MCP registration",
        status: "warn",
        message: "mcp.context-mode is redundant: ctx_* tools are now provided by the plugin",
        fix: "context-mode upgrade (removes only mcp.context-mode; preserves other MCP servers)",
      });
    }

    // Note: SessionStart handled via experimental.chat.system.transform surrogate
    results.push({
      check: "SessionStart hook",
      status: "pass",
      message:
        `SessionStart via experimental.chat.system.transform surrogate (native hook pending #14808, #5409)`,
    });

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    const settings = this.readSettings();
    if (!settings) {
      return {
        check: "Plugin registration",
        status: "warn",
        message: `Could not read ${this.platform}.json or ${this.platform}.jsonc`,
      };
    }

    if (this.hasContextModePlugin(settings)) {
      return {
        check: "Plugin registration",
        status: "pass",
        message: "context-mode found in plugin array",
      };
    }

    return {
      check: "Plugin registration",
      status: "fail",
      message: `context-mode not found in ${this.platform}.json plugin array`,
      fix: "context-mode upgrade",
    };
  }

  getInstalledVersion(): string {
    // OpenCode 2 loads the plugin from the `plugins` array, which may point at a directory on disk
    // (a fork install) rather than a package in OpenCode's npm cache. Read the version from
    // whichever location the config actually names.
    const settings = this.readSettings();
    const specs: unknown[] = [];
    for (const key of ["plugins", "plugin"]) {
      const list = settings?.[key];
      if (Array.isArray(list)) specs.push(...list);
    }
    for (const spec of specs) {
      const target =
        typeof spec === "string"
          ? spec
          : typeof spec === "object" && spec !== null
            ? (spec as { package?: unknown }).package
            : undefined;
      if (typeof target !== "string") continue;
      // A local directory: read its package.json. A bare spec is an npm package name — the version
      // lives in OpenCode's npm cache, which is checked below.
      if (target.startsWith("/") || target.startsWith("file://")) {
        const dir = target.startsWith("file://") ? fileURLToPath(target) : target;
        try {
          const pkg = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf-8")) as {
            name?: string;
            version?: string;
          };
          if (pkg.name === "context-mode" && typeof pkg.version === "string") return pkg.version;
        } catch {
          /* not a package directory */
        }
      }
    }
    // Check ~/.cache/opencode/node_modules/ for context-mode
    try {
      const pkgPath = resolve(
        homedir(),
        ".cache",
        this.platform,
        "node_modules",
        "context-mode",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* not found */
    }
    return "not installed";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(pluginRoot: string, installRoot?: string): string[] {
    const settings = this.readSettings() ?? {};
    const changes: string[] = [];

    const siblingPaths = this.findSiblingConfigPaths();
    const siblingPlugins = this.readSiblingPlugins(siblingPaths);

    // OpenCode 2 renamed the plugin config key from `plugin` to `plugins`, and its config normaliser
    // merges the legacy `plugin` key into the same list (opencode core/src/config/normalize.ts:185-190).
    // Writing the V1 key on a V2 host would make OpenCode npm-install the `context-mode` package — which
    // is upstream's build, not this install's — so the key is chosen from the host's major version.
    const major = detectOpencodeMajor();
    const isV2 = major !== null && major >= 2;
    const key = isV2 ? "plugins" : "plugin";

    const plugins = (settings[key] ?? []) as string[];

    for (const sp of siblingPlugins) {
      if (!plugins.includes(sp)) {
        plugins.push(sp);
      }
    }

    if (!plugins.some((p) => p.includes("context-mode"))) {
      // On V2 a bare `"context-mode"` spec is an npm package name: OpenCode would resolve it from the
      // registry and load upstream's build. Point at this install's own directory instead — a plugin
      // directory is a supported spec (opencode.ai/v2/docs/build/plugins — "or plugin directories").
      // `installRoot` is where this context-mode actually lives; `pluginRoot` is the host's npm
      // cache, which holds whatever package OpenCode installed for itself.
      const target = isV2 ? (installRoot ?? pluginRoot) : "context-mode";
      plugins.push(target);
      changes.push(`Added context-mode to ${key} array${isV2 ? ` (${target})` : ""}`);
    } else {
      changes.push(`context-mode already in ${key} array`);
    }

    settings[key] = plugins;

    if (isV2) {
      // The legacy key must not linger on a V2 host: OpenCode merges it into `plugins`, so a leftover
      // `"context-mode"` there would register the npm package next to this install.
      const legacy = settings.plugin;
      if (Array.isArray(legacy)) {
        const kept = legacy.filter((p) => typeof p !== "string" || !p.includes("context-mode"));
        if (kept.length !== legacy.length) {
          if (kept.length === 0) delete settings.plugin;
          else settings.plugin = kept;
          changes.push("Removed context-mode from the legacy plugin array");
        }
      }
    }

    const mcp = settings.mcp;
    if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
      const servers = mcp as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(servers, "context-mode")) {
        delete servers["context-mode"];
        changes.push("Removed legacy context-mode MCP block (plugin-native tools)");
      }
      if (Object.keys(servers).length === 0) delete settings.mcp;
    }

    this.writeSettings(settings);
    return changes;
  }

  private findSiblingConfigPaths(): string[] {
    const settingsPath = this.getSettingsPath();
    const stem = join(dirname(settingsPath), basename(settingsPath, extname(settingsPath)));
    const sibling = stem + (extname(settingsPath) === ".jsonc" ? ".json" : ".jsonc");
    return existsSync(sibling) ? [sibling] : [];
  }

  private readSiblingPlugins(siblingPaths: string[]): string[] {
    const plugins: string[] = [];
    for (const configPath of siblingPaths) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const text = configPath.endsWith(".jsonc") ? stripJsonComments(raw) : raw;
        const settings = JSON.parse(text) as Record<string, unknown>;
        // Both keys: a sibling config may register the plugin under the V2 `plugins` key or the
        // legacy `plugin` key, and OpenCode merges them into one list.
        for (const key of ["plugin", "plugins"]) {
          const list = settings[key];
          if (!Array.isArray(list)) continue;
          for (const p of list) {
            if (typeof p === "string" && !plugins.includes(p)) {
              plugins.push(p);
            }
          }
        }
      } catch { /* skip unreadable/unparseable sibling */ }
    }
    return plugins;
  }

  backupSettings(): string | null {
    const check = this.checkPluginRegistration();
    
    if (!this.settingsPath) return null;

    if (check.status === "pass") {
      return this.settingsPath;
    } else {
      try {
        accessSync(this.settingsPath, constants.R_OK);
        const backupPath = this.settingsPath + ".bak";
        copyFileSync(this.settingsPath, backupPath);
        return backupPath;
      } catch { 
        return null;
       }
    }
  }

  setHookPermissions(_pluginRoot: string): string[] {
    // OpenCode uses TS plugin paradigm — no shell scripts to chmod
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // OpenCode manages plugins through npm/opencode.json — no separate registry
  }

  // ── Internal helpers ───────────────────────────────────

  /**
   * Check whether a settings object has the context-mode plugin registered.
   */
  private hasContextModePlugin(settings: Record<string, unknown>): boolean {
    // Both keys are checked: OpenCode 2 reads `plugins` and merges the legacy `plugin` key into the
    // same list, so an entry under either key means the plugin is registered.
    for (const key of ["plugin", "plugins"]) {
      const plugins = settings[key];
      if (Array.isArray(plugins) && plugins.some((p: unknown) => typeof p === "string" && p.includes("context-mode"))) {
        return true;
      }
    }
    return false;
  }

  private hasLegacyContextModeMcp(settings: Record<string, unknown>): boolean {
    const mcp = settings.mcp;
    return !!(
      mcp &&
      typeof mcp === "object" &&
      !Array.isArray(mcp) &&
      Object.prototype.hasOwnProperty.call(mcp, "context-mode")
    );
  }

  /**
   * Extract session ID from OpenCode hook input.
   * OpenCode uses camelCase sessionID.
   */
  private extractSessionId(input: OpenCodeHookInput): string {
    if (input.sessionID) return input.sessionID;
    return `pid-${process.ppid}`;
  }
}
