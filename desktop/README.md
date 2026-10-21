# Ronin Code — Desktop Shell (Tauri v2)

A thin native wrapper around the existing Ronin Code web app. It is **not** a
rewrite: the React GUI and the Node host are reused exactly as they run today.

## How it fits together

```
┌─ Ronin Code.exe (Tauri v2, Rust) ──────────────────────────────┐
│  src-tauri/src/lib.rs                                           │
│    1. spawns the host (below) as a child process                │
│    2. polls GET http://127.0.0.1:7331/health (std TCP, ~15 s)   │
│    3. shows one window (1440×900, min 1024×640) loading         │
│       http://127.0.0.1:7331 — title "Ronin Code"                │
│    4. kills the host on window close / app exit                 │
│    5. best-effort background update check (never blocks start)  │
└─────────────────────────────────────────────────────────────────┘
        │ spawns, using the bundled Node runtime
        ▼
  resources/host/src/server.js     the existing Node host, unmodified
  resources/gui/dist/              the built GUI — a sibling of host/,
                                   because the host serves ../gui/dist
  binaries/node-x86_64-pc-windows-msvc.exe   bundled Node 22 runtime
```

- In dev, if the bundled Node is missing, the shell falls back to `node` on
  `PATH`, and if the bundled host is missing it falls back to the repo's
  `host/` directory — so `cargo run` works before any staging.
- The window is created hidden and shown once the host is healthy. If the
  host never becomes healthy within ~15 s the window is shown anyway, so the
  host's own error state surfaces instead of a silent hang.
- The host is spawned with `PORT=7331` and `RONIN_DESKTOP=1`, working
  directory = the staged host directory. User data still lives in
  `~/.ronin-code`, API keys still stay local — nothing about the BYOK model
  changes.

## Layout

| Path | What |
| --- | --- |
| `src-tauri/` | Rust crate + Tauri config, capabilities, icons |
| `src-tauri/src/lib.rs` | All shell logic (host spawn / health / window / updater) |
| `stage.mjs` | Copies host + built GUI into `src-tauri/resources/`, installs host deps, optionally downloads Windows Node |
| `tools/make-icons.mjs` | Dependency-free icon generator (hand-rolled PNG encoder) |
| `src-tauri/resources/`, `src-tauri/binaries/` | Staged at build time, git-ignored — never commit these |

## Build

Prerequisites: Node 22, Rust stable, and (on Windows) the WebView2 runtime
(preinstalled on Windows 11 / recent Windows 10).

```sh
# from the repo root
npm run install:all
npm run build                  # builds gui/ -> gui/dist

# stage the bundle inputs
node desktop/stage.mjs --node-win   # host + gui + Windows Node runtime
# …or, if node.exe is already in desktop/src-tauri/binaries/:
node desktop/stage.mjs --host-only

# build the installer
npm install -g @tauri-apps/cli@^2   # or use npx
cd desktop
npx tauri build
# -> src-tauri/target/release/bundle/nsis/Ronin Code_0.1.0_x64-setup.exe
```

Regenerate icons after any brand change:

```sh
node desktop/tools/make-icons.mjs
```

## CI

`.github/workflows/windows-build.yml` does the whole flow on `windows-latest`
(GUI build → Node download → staging → `tauri build`) and uploads the NSIS
installer as the `ronin-code-windows-installer` artifact. Trigger it manually
(`workflow_dispatch`) or by pushing a `v*` tag.

**Honest note:** a local `.exe` build requires Windows (or that CI workflow).
This scaffold was authored on Linux, where there is no Rust toolchain in the
dev VM — the Rust code and config are written to the Tauri v2 contracts but
the first compile happens in CI.

## Must be replaced before release

1. **Updater endpoint** — `plugins.updater.endpoints` in
   `src-tauri/tauri.conf.json` still points at the placeholder
   `https://updates.roninapp.example/latest.json`. Point it at the real
   update feed and host a signed `latest.json` there.
2. **Updater public key** — `plugins.updater.pubkey` is
   `PLACEHOLDER_REPLACE_BEFORE_RELEASE`. Generate a keypair with
   `tauri signer generate`, keep the private key in CI secrets only, and put
   the public key here. Until this exists, update checks fail silently by
   design — the app still starts normally.
3. **Code signing** — the NSIS installer is unsigned. Add a Windows code
   signing certificate (Tauri `bundle.windows.certificateThumbprint` /
   `signCommand`, secret stored in CI) so SmartScreen does not warn users.
4. **Node pin** — `stage.mjs` and the CI workflow both pin Node `22.14.0`;
   bump them together.
