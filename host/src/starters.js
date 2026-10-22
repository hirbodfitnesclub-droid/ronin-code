// Ronin Code — local host service.
// The built-in "classic" starter project's file contents. (Templated
// starters live as files under host/starters/ with a JSON manifest.)

export const STARTER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ronin Code — Starter</title>
<link rel="stylesheet" href="styles.css" />
</head>
<body>
<main class="card">
  <div class="mark">⚔</div>
  <h1>Ronin Code Starter</h1>
  <p>Your project is live. Ask Ronin Code to change this page — restyle it, add a section, make it yours.</p>
  <button id="hello">Say hello</button>
  <p id="out" class="out"></p>
</main>
<script src="app.js"></script>
</body>
</html>
`;

export const STARTER_CSS = `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0e14; color: #e6e9ef;
  font-family: ui-sans-system, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.card { max-width: 520px; padding: 48px 40px; text-align: center; background: #121722; border: 1px solid #232b3d;
  border-radius: 20px; box-shadow: 0 24px 60px rgba(0,0,0,.45); }
.mark { font-size: 40px; }
h1 { margin: 14px 0 10px; font-size: 28px; letter-spacing: -.02em; }
p { color: #9aa4b8; line-height: 1.6; }
button { margin-top: 14px; padding: 11px 22px; border: 0; border-radius: 999px; background: #e8b33c; color: #171106;
  font-weight: 600; cursor: pointer; }
button:hover { filter: brightness(1.08); }
.out { min-height: 1.5em; color: #e8b33c; }
`;

export const STARTER_JS = `document.getElementById("hello").addEventListener("click", () => {
  document.getElementById("out").textContent = "Hello from your Ronin Code starter project.";
});
`;

// ---------- usage store (cost center + router stats) ----------
