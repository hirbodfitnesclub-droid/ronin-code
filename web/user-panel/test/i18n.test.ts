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

test('placeholder parity: fa and en use exactly the same {placeholders} per key', () => {
  for (const k of Object.keys(en) as Array<keyof typeof en>) {
    assert.deepEqual(vars(fa[k]), vars(en[k]), `placeholder mismatch on ${k}`);
  }
});
