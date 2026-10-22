// Ronin Code — local host service.
// Plain ESM Node (>=20), node:http + stdlib only. The embedded agent
// engine is loaded lazily, only for live turns (see ENGINE.md for the
// exact SDK API). This entry only wires the transport up; every
// behavior lives in the modules under src/ (see ARCHITECTURE.md).

import { startHost } from "./http-server.js";

startHost();
