import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate, formatNumber, formatUsd } from '../src/lib/format.ts';

test('interpolate replaces placeholders', () => {
  assert.equal(interpolate('Hi {name}', { name: 'Ronin' }), 'Hi Ronin');
  assert.equal(interpolate('{count} files', { count: 3 }), '3 files');
});

test('interpolate replaces every occurrence and leaves unknown ones', () => {
  assert.equal(interpolate('{a} and {a}', { a: 'x' }), 'x and x');
  assert.equal(interpolate('{a} {b}', { a: 'x' }), 'x {b}');
  assert.equal(interpolate('plain'), 'plain');
  assert.equal(interpolate('plain', undefined), 'plain');
});

test('formatNumber groups with locale separators', () => {
  assert.equal(formatNumber(1234567, 'en-US'), '1,234,567');
  assert.equal(formatNumber(0, 'en-US'), '0');
});

test('formatUsd: 2dp normally, 4dp for sub-10-cent amounts', () => {
  assert.equal(formatUsd(2.5, 'en-US'), '$2.50');
  assert.equal(formatUsd(18, 'en-US'), '$18.00');
  assert.equal(formatUsd(0, 'en-US'), '$0.00');
  assert.equal(formatUsd(0.0001, 'en-US'), '$0.0001');
  assert.equal(formatUsd(0.0625, 'en-US'), '$0.0625');
});
