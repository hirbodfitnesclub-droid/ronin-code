import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Error-surface invariant (owner rule): a screen never renders an error's
 * raw `.message`. Server/API text reaches the user ONLY through a stable
 * error code mapped to a localized string (errorKeyFor / ERROR_CODE_KEYS),
 * with a generic human fallback. ApiError construction lives in src/lib/api
 * (excluded here); every feature/component must go through the code mapping.
 * This scan pins the invariant the same way provider-security.test.ts pins
 * key-material handling.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('no screen renders raw error message text (code → i18n mapping only)', () => {
  const files = [...walk(join(SRC, 'features')), ...walk(join(SRC, 'components'))].filter(
    (f) => f.endsWith('.ts') || f.endsWith('.tsx'),
  );
  assert.ok(files.length > 10, `expected a real source tree, got ${files.length} files`);
  const rawMessage = /\b(?:err|error|e|reason|cause)\.message\b/;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!rawMessage.test(src), `${f} renders raw error .message — map the error code to i18n instead`);
  }
});
