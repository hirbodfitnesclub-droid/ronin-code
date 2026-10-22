# Ronin Code — User Web Panel

React + Vite + TypeScript panel (login, dashboard, buy credit, purchases,
history, devices, account). Foundation scaffold: design tokens, FA/EN i18n,
typed API client (live + mock), shell with stub screens.

## Dev

```bash
npm install
npm run dev        # http://127.0.0.1:5174 — proxies /api + /hooks to 127.0.0.1:7443
```

Env: `VITE_API_MODE=mock` for the full mock client; claims route live
(POST/GET /api/orders) by default — `VITE_CLAIMS_ADAPTER=mock` forces the
mock claims adapter for offline UI work; `VITE_API_BASE_URL` to point at a
non-proxied API origin. Mock OTP: `123456`.
