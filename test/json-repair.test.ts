import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureJsonObject } from '../src/utils.js';

test('ensureJsonObject strips markdown fence and leading text', () => {
  const raw = 'Here is the result:\n```json\n{"ok":true,"nested":{"value":1}}\n```';
  const cleaned = ensureJsonObject(raw);
  assert.equal(cleaned, '{"ok":true,"nested":{"value":1}}');
});

test('ensureJsonObject strips trailing text after closing brace', () => {
  const raw = '{"ok":true}\nSome trailing explanation';
  assert.equal(ensureJsonObject(raw), '{"ok":true}');
});

test('ensureJsonObject throws when no object exists', () => {
  assert.throws(() => ensureJsonObject('not json'));
});
