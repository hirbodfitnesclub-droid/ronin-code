import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from '../src/lib/i18n/en.ts';
import { fa } from '../src/lib/i18n/fa.ts';

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('fa dictionary mirrors the en key set exactly', () => {
  assert.deepEqual(Object.keys(fa).sort(), Object.keys(en).sort());
});

test('no empty strings in either dictionary', () => {
  for (const [k, v] of Object.entries(en)) assert.ok(v.length > 0, `en ${k} empty`);
  for (const [k, v] of Object.entries(fa)) assert.ok(v.length > 0, `fa ${k} empty`);
});

test('every fa placeholder exists in the en string (en may add grammar-only ones, e.g. {plural})', () => {
  for (const k of Object.keys(en) as Array<keyof typeof en>) {
    const enVars = new Set(vars(en[k]));
    for (const v of vars(fa[k])) assert.ok(enVars.has(v), `fa ${k} uses unknown placeholder {${v}}`);
  }
});
