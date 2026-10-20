# Upstream submissions

Patches this fork intends to send upstream, kept here so they travel with the fork rather than
living in one person's notes.

## `opencode-v2-entry.patch`

**Target:** `mksglu/context-mode`, branch `v2-design` (base commit `003b8d60`)
**Upstream PR:** none — upstream has pull requests and issues disabled, and `main` is a frozen v1
branch. The upstream rewrite is happening on `v2-design` and the surrounding `impl/M*` branches.

**What it does.** Rewrites `src/entries/opencode.ts` — the OpenCode 2 plugin entry — against the
real OpenCode 2 plugin API.

The entry as it stands registers the v1 hook names (`chat.message`, `tool.execute.before`,
`experimental.session.compacting`, `experimental.chat.system.transform`) and calls `app.tool(name,
def)`. None of those exist in OpenCode 2's plugin API, the v2 loader reads `id`/`setup` off the
**default** export, and the entry had no default export at all — so the module could not load under
OpenCode 2. The patch rewrites it to the v2 plugin context:

| | Before | After |
|---|---|---|
| Tools | `app.tool(name, def)` | `ctx.tool.transform(editor => editor.add(...))`, `codemode: false` |
| Tool hooks | returned as V1 hook names | `ctx.tool.hook("execute.before" / "execute.after")` |
| Session hooks | returned as V1 hook names | `ctx.session.hook("prompt" / "context" / "compaction")` |
| Events | V1 `event` hook | `ctx.event.subscribe()`, `session.step.ended` |
| cwd | `app.directory` | `ctx.location.directory` |
| Export | named `id` + `setup` | default export `{ id, setup }` |

It also ports this fork's compaction ownership (`own`/`passthrough`) and destructive-tool policy from
`mksglu/context-mode#1194`, and fixes the system payload to merge into the last `SystemPart` rather
than adding one, so `system.length` is unchanged and the provider prompt cache survives (#1085).

**Why it matters.** Upstream's own review pass already found the defect —
`docs/v2/review/out/r2/round1/review/agent-opencode-2.json` says *"v1 hook names… v2 has none of
these as hooks"* and prescribes exactly this fix — but the correction was never applied to the
implementation. Upstream's probe and install guide were both written against `opencode-ai@1.19.3`,
the v1-era plugin API, which is why the two disagree about which API the v2 plugin targets.

**Applying it**

```bash
git clone --branch v2-design https://github.com/mksglu/context-mode.git
cd context-mode
git apply --check ../opencode-v2-entry.patch   # dry run
git apply ../opencode-v2-entry.patch
```

Requires Node 24.15.0 or later — the upstream v2 rewrite hard-requires it. The upstream test suite
is `node --test --test-reporter=tap tests/v2/`.
