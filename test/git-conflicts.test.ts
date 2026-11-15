import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  ConflictError,
  resolveConflict,
  type ConflictDeps,
} from '../src/git-conflicts.ts';

const ROOT = '/repo';
const FILE = '/repo/a.txt';
const MARKERS = '<<<<<<< HEAD\ncurrent side\n=======\nincoming side\n>>>>>>> incoming\n';

type Operation = 'merge' | 'rebase' | undefined;

interface HarnessOptions {
  operation?: Operation
  /** Whether index stage 2 (`:2:a.txt`) exists. */
  stage2?: boolean
  /** Whether index stage 3 (`:3:a.txt`) exists. */
  stage3?: boolean
  /** Working-tree content; `undefined` → marked sample, `null` → missing file. */
  file?: string | null
}

function makeHarness(options: HarnessOptions = {}) {
  const gitCalls: string[][] = [];
  const readFiles: string[] = [];
  const writeFiles: { path: string; data: string }[] = [];
  const readDirs: string[] = [];

  const deps: ConflictDeps = {
    async git(_cwd, args) {
      gitCalls.push([...args]);
      switch (args[0]) {
        case 'rev-parse':
          if (args[1] === '--show-toplevel') {return `${ROOT}\n`;}
          if (args[1] === '--absolute-git-dir') {return `${ROOT}/.git\n`;}
          break;
        case 'cat-file':
          if (args[1] === '-e') {
            const stageArg = args[2]!;
            const exists = stageArg === ':2:a.txt' ? options.stage2 : stageArg === ':3:a.txt' ? options.stage3 : undefined;
            if (exists === false) {throw new Error(`missing ${stageArg}`);}
            if (exists === true) {return '';}
          }
          break;
        case 'checkout':
        case 'add':
        case 'rm':
          return '';
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    },
    async readFile(path) {
      readFiles.push(path);
      if (options.file === null) {throw new Error('file missing');}
      return options.file ?? MARKERS;
    },
    async writeFile(path, data) {
      writeFiles.push({ path, data });
    },
    async readDir(path) {
      readDirs.push(path);
      if (path === `${ROOT}/.git`) {
        if (options.operation === 'merge') {return ['config', 'HEAD', 'MERGE_HEAD'];}
        if (options.operation === 'rebase') {return ['config', 'rebase-merge'];}
        return ['config', 'HEAD'];
      }
      throw new Error(`unexpected readDir: ${path}`);
    },
  };

  return { deps, gitCalls, readFiles, writeFiles, readDirs };
}

const baseGitCalls = (): string[][] => [
  ['rev-parse', '--show-toplevel'],
  ['rev-parse', '--absolute-git-dir'],
];

test('resolve "current" under merge checks out --ours and stages it', async () => {
  const h = makeHarness({ operation: 'merge', stage2: true });
  const result = await resolveConflict(ROOT, FILE, 'current', h.deps);

  assert.deepEqual(result, { path: FILE });
  assert.deepEqual(h.gitCalls, [
    ...baseGitCalls(),
    ['cat-file', '-e', ':2:a.txt'],
    ['checkout', '--ours', '--', 'a.txt'],
    ['add', '--', 'a.txt'],
  ]);
  assert.deepEqual(h.readDirs, [`${ROOT}/.git`]);
  assert.deepEqual(h.readFiles, []);
  assert.deepEqual(h.writeFiles, []);
});

test('resolve "incoming" under merge checks out --theirs and stages it', async () => {
  const h = makeHarness({ operation: 'merge', stage3: true });
  await resolveConflict(ROOT, FILE, 'incoming', h.deps);

  assert.deepEqual(h.gitCalls, [
    ...baseGitCalls(),
    ['cat-file', '-e', ':3:a.txt'],
    ['checkout', '--theirs', '--', 'a.txt'],
    ['add', '--', 'a.txt'],
  ]);
});

test('resolve "current" under merge when ours deleted stages the deletion', async () => {
  const h = makeHarness({ operation: 'merge', stage2: false });
  await resolveConflict(ROOT, FILE, 'current', h.deps);

  assert.deepEqual(h.gitCalls, [
    ...baseGitCalls(),
    ['cat-file', '-e', ':2:a.txt'],
    ['rm', '-f', '--', 'a.txt'],
  ]);
});

test('resolve "incoming" under merge when theirs deleted stages the deletion', async () => {
  const h = makeHarness({ operation: 'merge', stage3: false });
  await resolveConflict(ROOT, FILE, 'incoming', h.deps);

  assert.deepEqual(h.gitCalls, [
    ...baseGitCalls(),
    ['cat-file', '-e', ':3:a.txt'],
    ['rm', '-f', '--', 'a.txt'],
  ]);
});

test('resolve "current" under rebase follows the ours/theirs swap', async () => {
  const h = makeHarness({ operation: 'rebase', stage3: true });
  await resolveConflict(ROOT, FILE, 'current', h.deps);

  assert.deepEqual(h.gitCalls, [
    ...baseGitCalls(),
    ['cat-file', '-e', ':3:a.txt'],
    ['checkout', '--theirs', '--', 'a.txt'],
    ['add', '--', 'a.txt'],
  ]);
});

test('resolve "incoming" under rebase follows the ours/theirs swap', async () => {
  const h = makeHarness({ operation: 'rebase', stage2: true });
  await resolveConflict(ROOT, FILE, 'incoming', h.deps);

  assert.deepEqual(h.gitCalls, [
    ...baseGitCalls(),
    ['cat-file', '-e', ':2:a.txt'],
    ['checkout', '--ours', '--', 'a.txt'],
    ['add', '--', 'a.txt'],
  ]);
});

test('resolve "both" under merge writes the union and stages it', async () => {
  const h = makeHarness({ operation: 'merge' });
  const result = await resolveConflict(ROOT, FILE, 'both', h.deps);

  assert.deepEqual(result, { path: FILE });
  assert.deepEqual(h.gitCalls, [
    ...baseGitCalls(),
    ['add', '--', 'a.txt'],
  ]);
  assert.deepEqual(h.readFiles, [FILE]);
  assert.deepEqual(h.writeFiles, [{ path: FILE, data: 'current side\nincoming side\n' }]);
});

test('resolve "both" under rebase stages the union the same way', async () => {
  const h = makeHarness({ operation: 'rebase' });
  await resolveConflict(ROOT, FILE, 'both', h.deps);

  assert.deepEqual(h.gitCalls, [
    ...baseGitCalls(),
    ['add', '--', 'a.txt'],
  ]);
  assert.deepEqual(h.writeFiles, [{ path: FILE, data: 'current side\nincoming side\n' }]);
});

test('resolve "both" without markers rejects and does not stage', async () => {
  const h = makeHarness({ operation: 'merge', file: 'no conflict markers here\n' });

  await assert.rejects(
    () => resolveConflict(ROOT, FILE, 'both', h.deps),
    (error: unknown) => error instanceof ConflictError && error.code === 'no-markers',
  );

  assert.deepEqual(h.gitCalls, baseGitCalls());
  assert.deepEqual(h.readFiles, [FILE]);
  assert.deepEqual(h.writeFiles, []);
});

test('resolve "both" on an absent file rejects and does not stage', async () => {
  const h = makeHarness({ operation: 'merge', file: null });

  await assert.rejects(
    () => resolveConflict(ROOT, FILE, 'both', h.deps),
    (error: unknown) => error instanceof ConflictError && error.code === 'no-markers',
  );

  assert.deepEqual(h.gitCalls, baseGitCalls());
  assert.deepEqual(h.readFiles, [FILE]);
  assert.deepEqual(h.writeFiles, []);
});
