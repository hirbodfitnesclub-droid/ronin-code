# ENGINE.md — internal engineering note (not user-facing)

This file is the one place in `host/` that names the internal engine library.
Nothing user-facing (logs, responses, folder names, config paths) uses its name.

## Engine

- Package: `@earendil-works/pi-coding-agent` **1.3.0** (exact, in `package.json`),
  used only as an embedded SDK library via `import()` inside `runLiveTurn()`.
  No external agent CLI binary is ever spawned, and no `~/.pi` is created:
  `process.env.PI_CODING_AGENT_DIR` and the `agentDir` session option are both
  pointed at `<RONIN_HOME>/engine`, `SessionManager` is given
  `<RONIN_HOME>/sessions` as its session dir, and settings are in-memory.

## Actual installed API (read from `node_modules/.../dist/*.d.ts` + `docs/sdk.md` + `examples/sdk/`)

Version 1.3.0 differs from older expectations:

- **No `AuthStorage` class is exported** from the package index
  (only `readStoredCredential`). There is also no standalone `setRuntimeApiKey`
  export. Auth is owned by **`ModelRuntime`**:
  ```js
  import { createAgentSession, SessionManager, SettingsManager, ModelRuntime }
    from "@earendil-works/pi-coding-agent";

  const modelRuntime = await ModelRuntime.create({
    authPath: "<RONIN_HOME>/engine/auth.json",
    modelsPath: "<RONIN_HOME>/engine/models.json",
  });
  await modelRuntime.setRuntimeApiKey(providerId, apiKey); // runtime-only override
  const model = modelRuntime.getModel(providerId, modelId); // -> Model | undefined
  ```
- `ModelRegistry` **is** exported, but it is a thin wrapper constructed as
  `new ModelRegistry(modelRuntime)`; `ModelRuntime` alone is sufficient and is
  what the bundled SDK examples (02, 09, 12) use, so Ronin uses `ModelRuntime`.
- Ronin's own `<RONIN_HOME>/auth.json` is a simple `provider -> apiKey` map
  (per product spec). That is **not** the engine's on-disk credential format
  (`{ "<provider>": { "type": "api_key", "key": "..." } }`), so Ronin never
  points the engine's `authPath` at its own file — keys reach the engine only
  in memory via `setRuntimeApiKey()`, and the engine's own auth file lives
  separately at `<RONIN_HOME>/engine/auth.json`.
- Session creation (all options verified against `dist/core/sdk.d.ts`):
  ```js
  const { session } = await createAgentSession({
    cwd: projectPath,
    agentDir: "<RONIN_HOME>/engine",
    modelRuntime,
    model,
    sessionManager: SessionManager.create(projectPath, "<RONIN_HOME>/sessions"),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
  });
  const unsubscribe = session.subscribe((event) => { /* ... */ });
  await session.prompt(promptText);          // resolves when the run finishes
  const lastText = session.getLastAssistantText(); // string | undefined
  session.dispose();
  ```
- Events used for the Ronin activity stream (`AgentSessionEvent` /
  `AgentEvent` in `dist/core/agent-session.d.ts` + `pi-agent-core/dist/types.d.ts`):
  - `message_update` with `assistantMessageEvent.type` of
    `thinking_start` / `thinking_delta` / `thinking_end` → `thinking` activity;
    `text_delta` (with `.delta`) → `assistant_delta`.
  - `tool_execution_start` / `tool_execution_end` with `toolCallId`, `toolName`,
    `args` → activity start/end. Kind map: `read`→reading, `write`→writing,
    `edit`→editing, `bash`/`powershell`→terminal, `grep`/`find`/`ls`/`search`→searching,
    anything else→reading.
  - Changed files are computed by diffing the post-turn project tree against
    the pre-turn snapshot manifest (sha256 per file); write/edit tool `args.path`
    is tracked as a fallback.
- All four default models resolve via `modelRuntime.getModel(...)` in 1.3.0
  (verified): `anthropic/claude-sonnet-4-5`, `openai/gpt-5`,
  `google/gemini-2.5-pro`, `openrouter/openai/gpt-5`.
- The engine package declares `engines: node >=22.19.0`; Ronin's host targets
  Node >=20 per product spec, but live mode inherits the engine's requirement.
  Preview mode and all non-turn routes work on Node 20.

## Limitations / adaptations

- One session is created per turn and disposed afterwards (no cross-turn
  conversation continuity beyond the persisted session files the manager
  writes under `<RONIN_HOME>/sessions`). This keeps lifecycle simple and
  leak-free for the MVP.
- `agent_settled` is not awaited separately: `session.prompt()` already
  resolves after the run (including retries) per `docs/sdk.md`.
