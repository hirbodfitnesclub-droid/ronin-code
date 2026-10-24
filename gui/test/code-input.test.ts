import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHandoffCode,
  handoffCodeComplete,
  normalizeHandoffCode,
  normalizeOtp,
  otpComplete,
} from '../src/lib/codeInput.ts';

test('handoff code: pasted display form normalises to the 8-char body', () => {
  assert.equal(normalizeHandoffCode('RNC-A7F3-29KD'), 'A7F329KD');
  assert.equal(normalizeHandoffCode('rnc-a7f3-29kd'), 'A7F329KD');
  assert.equal(normalizeHandoffCode('A7F3 29KD'), 'A7F329KD');
  assert.equal(normalizeHandoffCode('A7F329KD'), 'A7F329KD');
});

test('handoff code: partial input is capped, junk stripped, RNC body start kept', () => {
  assert.equal(normalizeHandoffCode('a7!'), 'A7');
  assert.equal(normalizeHandoffCode('RNC'), 'RNC');
  assert.equal(normalizeHandoffCode('RNCAB12'), 'RNCAB12');
  assert.equal(normalizeHandoffCode(''), '');
});

test('handoff code: format + completeness round-trip', () => {
  assert.equal(formatHandoffCode('A7F329KD'), 'RNC-A7F3-29KD');
  assert.equal(formatHandoffCode('A7'), 'RNC-A7');
  assert.equal(handoffCodeComplete('A7F329KD'), true);
  assert.equal(handoffCodeComplete('A7F3'), false);
});

test('otp: digits only, capped at 6', () => {
  assert.equal(normalizeOtp('12 34-56'), '123456');
  assert.equal(normalizeOtp('12345678'), '123456');
  assert.equal(normalizeOtp('abcdef'), '');
  assert.equal(otpComplete('123456'), true);
  assert.equal(otpComplete('12345'), false);
});
