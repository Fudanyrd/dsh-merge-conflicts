import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extOf, languageForPath, languageKeyForExt } from '../src/client/lang.ts';

test('languageKeyForExt maps known extensions and leaves ambiguous ones unmapped', () => {
  assert.equal(languageKeyForExt('ts'), 'ts');
  assert.equal(languageKeyForExt('tsx'), 'tsx');
  assert.equal(languageKeyForExt('jsx'), 'jsx');
  assert.equal(languageKeyForExt('json'), 'json');
  assert.equal(languageKeyForExt('yaml'), 'yaml');
  assert.equal(languageKeyForExt('dockerfile'), 'dockerfile');
  assert.equal(languageKeyForExt('v'), null);
  assert.equal(languageKeyForExt('m'), null);
});

test('extOf keeps only the extension in the last path segment', () => {
  assert.equal(extOf('/a/b/c.TSX'), 'tsx');
  assert.equal(extOf('/a/b/c'), '');
  assert.equal(extOf('/a.b/c'), '');
  assert.equal(extOf('/a/b/c.d.ts'), 'ts');
});

test('languageForPath degrades unknown extensions to plain text', () => {
  assert.equal(languageForPath('/a/b/file.unknown'), null);
  assert.notEqual(languageForPath('/a/b/file.py'), null);
});
