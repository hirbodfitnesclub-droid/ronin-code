// Ronin Code — local host service.
// Filesystem layout + process-wide constants. Importing this module
// prepares the Ronin data directory; nothing else lives here.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const GUI_DIST = path.resolve(HOST_DIR, "..", "gui", "dist");

export const VERSION = "1.0.0";

export const RONIN_HOME = process.env.RONIN_HOME
  ? path.resolve(process.env.RONIN_HOME)
  : path.join(os.homedir(), ".ronin-code");

export const ENGINE_DIR = path.join(RONIN_HOME, "engine");

export const SESSIONS_DIR = path.join(RONIN_HOME, "sessions");

export const SNAPSHOTS_DIR = path.join(RONIN_HOME, "snapshots");

export const CONFIG_PATH = path.join(RONIN_HOME, "config.json");

export const AUTH_PATH = path.join(RONIN_HOME, "auth.json");

// Keep every engine-native file inside the Ronin data dir (never ~/.pi).

process.env.PI_CODING_AGENT_DIR = ENGINE_DIR;

fs.mkdirSync(RONIN_HOME, { recursive: true });

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

fs.mkdirSync(ENGINE_DIR, { recursive: true });
