#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE = path.resolve(ROOT, '..', 'rental');
const LEGACY_SOURCE = path.resolve(ROOT, '..', 'ohsung-rental');
const MANIFEST_PATH = 'config/firebase-config-provenance.json';
const REPOSITORY = 'https://github.com/oshs-sc/rental.git';
const FILES = Object.freeze([
  Object.freeze({ sourcePath: 'firestore.rules', targetPath: 'config/firestore.rules' }),
  Object.freeze({ sourcePath: 'firestore.indexes.json', targetPath: 'config/firestore.indexes.json' }),
  Object.freeze({ sourcePath: 'firebase.json', targetPath: 'config/firebase.json' }),
  Object.freeze({ sourcePath: 'frontend/src/services/studentIdentity.js', targetPath: 'lib/studentIdentity.js' }),
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function targetFile(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Refusing path outside CLI repository: ' + relativePath);
  }
  return absolute;
}

function readRegularFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(label + ' is missing: ' + file);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(label + ' must be a regular file: ' + file);
  }
  return fs.readFileSync(file);
}

function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.source ||
      manifest.source.repository !== REPOSITORY ||
      !/^[a-f0-9]{40}$/.test(manifest.source.revision) ||
      (manifest.source.ref !== null && typeof manifest.source.ref !== 'string') ||
      manifest.source.verification !== 'clean-local-checkout' ||
      manifest.source.networkFetch !== false ||
      !Array.isArray(manifest.files) || manifest.files.length !== FILES.length) {
    throw new Error('Invalid provenance manifest shape or source identity.');
  }
  const records = new Map();
  for (const record of manifest.files) {
    if (!record || typeof record.sourcePath !== 'string' ||
        typeof record.targetPath !== 'string' ||
        !Number.isSafeInteger(record.bytes) || record.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(record.sha256) ||
        records.has(record.targetPath)) {
      throw new Error('Invalid or duplicate file record in provenance manifest.');
    }
    records.set(record.targetPath, record);
  }
  for (const file of FILES) {
    const record = records.get(file.targetPath);
    if (!record || record.sourcePath !== file.sourcePath) {
      throw new Error('Provenance manifest file set does not match: ' + file.targetPath);
    }
  }
  return manifest;
}

function readManifest(root = ROOT) {
  const file = targetFile(root, MANIFEST_PATH);
  return validateManifest(JSON.parse(readRegularFile(file, 'Provenance manifest').toString('utf8')));
}

function compareVendoredFiles(root, manifest) {
  const records = new Map(manifest.files.map(record => [record.targetPath, record]));
  const mismatches = [];
  for (const file of FILES) {
    const record = records.get(file.targetPath);
    let bytes;
    try {
      bytes = readRegularFile(targetFile(root, file.targetPath), 'Vendored file');
    } catch (error) {
      mismatches.push({ file, expected: record, actual: null, reason: error.message });
      continue;
    }
    const actual = { bytes: bytes.length, sha256: sha256(bytes) };
    if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256) {
      mismatches.push({ file, expected: record, actual, reason: 'content differs from provenance' });
    }
  }
  return mismatches;
}

function formatMismatches(mismatches, prefix) {
  return mismatches.map(({ file, expected, actual, reason }) => {
    const actualText = actual ? actual.bytes + ' bytes sha256=' + actual.sha256 : 'unavailable';
    return prefix + file.targetPath + ': ' + reason +
      ' (expected ' + expected.bytes + ' bytes sha256=' + expected.sha256 +
      '; actual ' + actualText + ')';
  });
}

function assertBundledConfig(root = ROOT) {
  const manifest = readManifest(root);
  const mismatches = compareVendoredFiles(root, manifest);
  if (mismatches.length) {
    throw new Error('Bundled Firebase config integrity check failed:\n' +
      formatMismatches(mismatches, ' - ').join('\n'));
  }
  return manifest;
}

function runGit(repoRoot, args, binary = false) {
  try {
    const output = execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: binary ? null : 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return binary ? output : output.trimEnd();
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error('Local Git command failed (' + args.join(' ') + '): ' + detail);
  }
}

function normalizeRepository(url) {
  return url.trim()
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

function inspectLocalCheckout(sourceDir) {
  const requestedRoot = path.resolve(sourceDir);
  const repoRoot = path.resolve(runGit(requestedRoot, ['rev-parse', '--show-toplevel']));
  const origin = normalizeRepository(runGit(repoRoot, ['remote', 'get-url', 'origin']));
  if (origin !== REPOSITORY.replace(/\.git$/i, '').toLowerCase()) {
    throw new Error('Source origin is not the expected repository: ' + origin);
  }
  const status = runGit(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) {
    throw new Error('Source checkout is not clean; refusing to use uncommitted website files:\n' + status);
  }
  const head = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Could not resolve a full source commit SHA.');
  let ref = null;
  try {
    ref = runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || null;
  } catch (_) {
    ref = null;
  }
  return { repoRoot, head, ref };
}

function readCommittedFiles(repoRoot, revision) {
  const result = new Map();
  for (const file of FILES) {
    result.set(file.sourcePath, runGit(repoRoot, ['show', revision + ':' + file.sourcePath], true));
  }
  return result;
}

function createManifest(revision, ref, sourceFiles) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Source revision must be a full 40-character commit SHA.');
  const files = FILES.map(file => {
    const bytes = sourceFiles.get(file.sourcePath);
    if (!Buffer.isBuffer(bytes)) throw new Error('Missing committed source file: ' + file.sourcePath);
    return {
      sourcePath: file.sourcePath,
      targetPath: file.targetPath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  return validateManifest({
    schemaVersion: 1,
    source: {
      repository: REPOSITORY,
      revision,
      ref: ref || null,
      verification: 'clean-local-checkout',
      networkFetch: false,
    },
    files,
  });
}

function runCheck(root = ROOT, options = {}) {
  const report = options.report || (line => console.log(line));
  const manifest = readManifest(root);
  const localMismatches = compareVendoredFiles(root, manifest);
  if (localMismatches.length) {
    for (const line of formatMismatches(localMismatches, 'DRIFT: ')) report(line);
  } else {
    report('PASS: bundled files match provenance by byte length and SHA-256.');
  }

  let sourceDrift = false;
  if (!options.sourceDir) {
    report('Offline self-check: no website checkout or network fetch used.');
  } else {
    const checkout = inspectLocalCheckout(options.sourceDir);
    if (checkout.head !== manifest.source.revision) {
      report('WARNING: website checkout HEAD ' + checkout.head +
        ' differs from pinned source revision ' + manifest.source.revision + '.');
    }
    const sourceFiles = readCommittedFiles(checkout.repoRoot, checkout.head);
    for (const file of FILES) {
      const source = sourceFiles.get(file.sourcePath);
      const vendored = readRegularFile(targetFile(root, file.targetPath), 'Vendored file');
      if (!source.equals(vendored)) {
        sourceDrift = true;
        report('DRIFT: local website ' + file.sourcePath + ' differs byte-for-byte from ' + file.targetPath + '.');
      }
    }
    if (!sourceDrift) {
      report('PASS: all vendored files are byte-identical to the clean local website checkout at ' + checkout.head + '.');
    }
  }
  return localMismatches.length || sourceDrift ? 1 : 0;
}

function writeAtomic(file, bytes, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + process.pid;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function syncFromGit(root = ROOT, options = {}) {
  if (!options.sourceDir) throw new Error('sync requires an explicit local source checkout (--source PATH).');
  const revision = String(options.commit || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('sync requires --commit with a full 40-character source commit SHA.');
  }
  const currentManifest = readManifest(root);
  const localMismatches = compareVendoredFiles(root, currentManifest);
  if (localMismatches.length) {
    throw new Error('Refusing to overwrite locally drifted vendored files:\n' +
      formatMismatches(localMismatches, ' - ').join('\n'));
  }
  const checkout = inspectLocalCheckout(options.sourceDir);
  if (checkout.head !== revision) {
    throw new Error('Requested commit does not match the clean local checkout HEAD: requested ' +
      revision + ', checkout ' + checkout.head + '. Check out the exact commit locally; this tool never fetches.');
  }

  const sourceFiles = readCommittedFiles(checkout.repoRoot, revision);
  const nextManifest = createManifest(revision, checkout.ref, sourceFiles);
  const targets = FILES.map(file => ({
    file,
    path: targetFile(root, file.targetPath),
    bytes: sourceFiles.get(file.sourcePath),
  }));

  for (const target of targets) {
    const current = readRegularFile(target.path, 'Vendored file');
    if (!current.equals(target.bytes)) writeAtomic(target.path, target.bytes, fs.statSync(target.path).mode & 0o777);
  }
  const manifestFile = targetFile(root, MANIFEST_PATH);
  writeAtomic(manifestFile, Buffer.from(JSON.stringify(nextManifest, null, 2) + '\n'),
    fs.statSync(manifestFile).mode & 0o777);
  return nextManifest;
}

function parseArgs(argv) {
  const [command = 'help', ...args] = argv;
  if (command === 'help' || command === '--help' || command === '-h') return { command: 'help' };
  if (!['check', 'sync'].includes(command)) throw new Error('Unknown command: ' + command);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key !== '--source' && key !== '--commit') throw new Error('Unknown option: ' + key);
    if (options[key.slice(2)] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(key + ' requires one value and may appear only once.');
    }
    options[key.slice(2)] = args[++index];
  }
  if (command === 'check' && options.commit !== undefined) throw new Error('check does not accept --commit.');
  if (command === 'sync' && !options.commit) throw new Error('sync requires --commit FULL_SHA.');
  return { command, ...options };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/sync-firestore-config.cjs check [--source PATH]',
    '  node scripts/sync-firestore-config.cjs sync [--source PATH] --commit FULL_SHA',
    '',
    'check validates vendored files against config/firebase-config-provenance.json without fetching.',
    'When --source is supplied, check also compares a clean local website checkout byte-for-byte.',
    'sync reads only the requested commit from a clean local checkout whose HEAD matches --commit.',
    'Without --source, sync looks for ../rental and falls back to ../ohsung-rental if needed.',
    'No Firebase CLI or remote configuration deploy is performed.',
  ].join('\n');
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    if (args.command === 'help') {
      console.log(usage());
      return 0;
    }
    const root = ROOT;
    if (args.command === 'check') {
      return runCheck(root, {
        sourceDir: args.source ? path.resolve(args.source) : null,
      });
    }
    let sourceDir = args.source ? path.resolve(args.source) : DEFAULT_SOURCE;
    if (!args.source && !fs.existsSync(sourceDir) && fs.existsSync(LEGACY_SOURCE)) {
      sourceDir = LEGACY_SOURCE;
    }
    const manifest = syncFromGit(root, { sourceDir, commit: args.commit });
    console.log('Synchronized ' + manifest.files.length + ' files from local commit ' + manifest.source.revision + '.');
    for (const file of manifest.files) {
      console.log(file.sourcePath + ' -> ' + file.targetPath + ' (' + file.bytes + ' bytes, sha256=' + file.sha256 + ')');
    }
    console.log('No network fetch or Firebase deploy was performed.');
    return 0;
  } catch (error) {
    console.error('ERROR: ' + error.message);
    return 1;
  }
}

module.exports = {
  FILES,
  MANIFEST_PATH,
  REPOSITORY,
  assertBundledConfig,
  compareVendoredFiles,
  createManifest,
  parseArgs,
  runCheck,
  sha256,
  syncFromGit,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
