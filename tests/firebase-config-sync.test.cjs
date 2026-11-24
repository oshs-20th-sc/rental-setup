'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  FILES,
  assertBundledConfig,
  createManifest,
  runCheck,
  sha256,
  syncFromGit,
} = require('../scripts/sync-firestore-config.cjs');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeSourceRepo() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-config-source-'));
  const repo = path.join(parent, 'website');
  fs.mkdirSync(repo);
  git(parent, ['init', '--bare', 'remote.git']);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Config Sync Test']);
  git(repo, ['config', 'user.email', 'config-sync@example.test']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/oshs-20th-sc/ohsung-rental.git']);
  return { parent, repo };
}

function writeSourceFiles(repo, contents) {
  for (const file of FILES) {
    const target = path.join(repo, file.sourcePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents.get(file.sourcePath));
  }
  git(repo, ['add', '--', ...FILES.map(file => file.sourcePath)]);
  git(repo, ['commit', '-m', 'Update managed config fixtures']);
  return git(repo, ['rev-parse', 'HEAD']);
}

function makeContent(label) {
  return new Map(FILES.map(file => [file.sourcePath, Buffer.from(label + ':' + file.sourcePath + '\n')]));
}

function makeCliRoot(contents, revision = '1'.repeat(40)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-config-cli-'));
  for (const file of FILES) {
    const target = path.join(root, file.targetPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents.get(file.sourcePath));
  }
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  const manifest = createManifest(revision, 'main', contents);
  fs.writeFileSync(path.join(root, 'config/firebase-config-provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
  return root;
}

test('offline self-check validates all vendored artifacts by byte length and SHA-256', () => {
  const contents = makeContent('baseline');
  const root = makeCliRoot(contents);
  const manifest = assertBundledConfig(root);
  assert.equal(manifest.files.length, 4);
  assert.equal(manifest.files[3].sha256, sha256(contents.get('frontend/src/services/studentIdentity.js')));
  assert.equal(runCheck(root, { report() {} }), 0);
});

test('local check warns on a newer checkout and fails clearly when committed bytes drift', () => {
  const { parent, repo } = makeSourceRepo();
  const baseline = makeContent('baseline');
  const firstCommit = writeSourceFiles(repo, baseline);
  const root = makeCliRoot(baseline, firstCommit);

  const updated = makeContent('updated');
  const secondCommit = writeSourceFiles(repo, updated);
  const report = [];
  assert.equal(runCheck(root, { sourceDir: repo, report: line => report.push(line) }), 1);
  assert.ok(report.some(line => line.includes('WARNING: website checkout HEAD ' + secondCommit)));
  assert.ok(report.some(line => line.includes('DRIFT: local website firestore.rules')));

  fs.writeFileSync(path.join(repo, 'untracked-note.txt'), 'uncommitted');
  assert.throws(
    () => runCheck(root, { sourceDir: repo, report() {} }),
    /Source checkout is not clean/,
  );
  fs.rmSync(parent, { recursive: true, force: true });
});

test('sync reads only an explicit clean local commit and updates copies plus provenance', () => {
  const { parent, repo } = makeSourceRepo();
  const baseline = makeContent('baseline');
  const firstCommit = writeSourceFiles(repo, baseline);
  const root = makeCliRoot(baseline, firstCommit);

  const updated = makeContent('reviewed');
  const secondCommit = writeSourceFiles(repo, updated);
  const manifest = syncFromGit(root, { sourceDir: repo, commit: secondCommit });

  assert.equal(manifest.source.revision, secondCommit);
  assert.equal(manifest.source.networkFetch, false);
  for (const file of FILES) {
    assert.deepEqual(fs.readFileSync(path.join(root, file.targetPath)), updated.get(file.sourcePath));
  }
  assert.equal(assertBundledConfig(root).source.revision, secondCommit);
  assert.equal(runCheck(root, { sourceDir: repo, report() {} }), 0);

  const drifted = fs.readFileSync(path.join(root, FILES[0].targetPath));
  fs.writeFileSync(path.join(root, FILES[0].targetPath), Buffer.concat([drifted, Buffer.from('local edit')]));
  assert.throws(
    () => syncFromGit(root, { sourceDir: repo, commit: secondCommit }),
    /Refusing to overwrite locally drifted vendored files/,
  );
  fs.rmSync(parent, { recursive: true, force: true });
});
