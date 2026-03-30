const { readdirSync, existsSync, readFileSync, appendFileSync } = require('fs');
const { join, resolve, relative, dirname } = require('path');

// Expand workspace globs from package.json using only fs (no external deps)
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const allDirs = [];
for (const pattern of pkg.workspaces) {
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    if (existsSync(base)) {
      for (const d of readdirSync(base, { withFileTypes: true })) {
        const dirPath = join(base, d.name);
        if (d.isDirectory() && existsSync(join(dirPath, 'package.json'))) {
          allDirs.push(dirPath);
        }
      }
    }
  } else if (existsSync(join(pattern, 'package.json'))) {
    allDirs.push(pattern);
  }
}
const allWorkspaces = [...new Set(allDirs)];

// Build reverse dependency map from tsconfig project references.
// dependents['libs/base-fastify-server'] = ['apps/session-manager', ...]
const dependents = /** @type {Record<string, string[]>} */ ({});
for (const wsDir of allWorkspaces) {
  const tsconfigPath = join(wsDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) continue;
  let tsconfig;
  try {
    const raw = readFileSync(tsconfigPath, 'utf8');
    // Strip comments and trailing commas (tsconfig is JSONC, not strict JSON)
    const stripped = raw
      .replace(/\/\/[^\n]*/g, '') // line comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/,(\s*[}\]])/g, '$1'); // trailing commas
    tsconfig = JSON.parse(stripped);
  } catch {
    continue;
  }
  for (const ref of tsconfig.references || []) {
    // Resolve the reference path relative to the workspace dir,
    // then normalize to a repo-root-relative path (strip /tsconfig.json).
    const absRef = resolve(wsDir, ref.path);
    const refDir = absRef.endsWith('.json') ? dirname(absRef) : absRef;
    const dep = relative(process.cwd(), refDir);
    if (!dependents[dep]) dependents[dep] = [];
    dependents[dep].push(wsDir);
  }
}

// BFS to expand a set of directly changed workspaces to include all
// transitive dependents (workspaces that import changed workspaces).
function expandWithDependents(directlyChanged) {
  const affected = new Set(directlyChanged);
  const queue = [...directlyChanged];
  while (queue.length > 0) {
    const ws = queue.shift();
    for (const dependent of dependents[ws] || []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return [...affected];
}

// Read changed files written by the shell step
const changedFiles = readFileSync('/tmp/changed_files.txt', 'utf8')
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean);

// Non-workspace directories whose changes imply a dependency on specific workspaces.
// Used for directories (e.g. Python services) that aren't in package.json workspaces.
const nonWorkspaceDependencies = /** @type {Record<string, string[]>} */ ({
  'transcription_service': ['apps/node-server'],
});

// Global config files that trigger a full run across all workspaces
const globalFiles = new Set([
  '.dockerignore',
  'package-lock.json',
  'package.json',
  'tsconfig.base.json',
  'eslint.config.js',
  'prettier.config.js',
  'vitest.config.ts',
  'vitest.shared.ts',
  '.npmrc',
  '.editorconfig',
]);

let affected;
if (changedFiles.length === 0 || changedFiles.some((f) => globalFiles.has(f))) {
  affected = allWorkspaces;
} else {
  const directlyChanged = new Set(
    allWorkspaces.filter((dir) =>
      changedFiles.some((f) => f.startsWith(dir + '/') || f === dir),
    ),
  );
  for (const [prefix, deps] of Object.entries(nonWorkspaceDependencies)) {
    if (changedFiles.some((f) => f.startsWith(prefix + '/'))) {
      for (const dep of deps) directlyChanged.add(dep);
    }
  }
  affected = expandWithDependents([...directlyChanged]);
}

const workspaces = JSON.stringify(affected);
const hasChanges = affected.length > 0 ? 'true' : 'false';

console.log('Affected Workspaces:\n\t', workspaces.join('\n\t'));

appendFileSync(process.env.GITHUB_OUTPUT, `workspaces=${workspaces}\n`);
appendFileSync(process.env.GITHUB_OUTPUT, `has_changes=${hasChanges}\n`);
