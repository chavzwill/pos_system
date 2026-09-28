'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runnerPaths = [
  'scripts/run-pos-disposable-certification.js',
  'scripts/run-pos-disposable-release-certification.js',
  'scripts/run-pos-production-certification.js',
];

const active = new Set();
const queue = [];
const enqueue = file => {
  const normalized = file.replace(/\\/g, '/');
  if (active.has(normalized)) return;
  const absolute = path.join(root, normalized);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return;
  active.add(normalized);
  queue.push(normalized);
};

for (const runnerPath of runnerPaths) {
  const source = fs.readFileSync(path.join(root, runnerPath), 'utf8');
  for (const match of source.matchAll(/['"](tests\/[A-Za-z0-9_.\/-]+\.(?:js|mjs|cjs))['"]/g)) {
    enqueue(match[1]);
  }
}

function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(path.join(root, fromFile)), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(root, candidate).replace(/\\/g, '/');
    }
  }
  return null;
}

while (queue.length) {
  const file = queue.shift();
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const imports = [
    ...source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g),
    ...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g),
  ];
  for (const match of imports) {
    const resolved = resolveRelative(file, match[1]);
    if (resolved && resolved.startsWith('tests/')) enqueue(resolved);
  }
}

const fixedTargetPattern = /https?:\/\/(?:localhost|127\.0\.0\.1):3001\b/g;
const allowedFixedTarget = new Set(['tests/test-base-url.js']);
const violations = [];
for (const file of [...active].sort()) {
  if (allowedFixedTarget.has(file)) continue;
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const matches = [...source.matchAll(fixedTargetPattern)].map(match => match[0]);
  if (matches.length) violations.push(`${file}: ${[...new Set(matches)].join(', ')}`);
}

const businessPath = 'tests/business-integrity.spec.js';
const repairWrapperPath = 'tests/repair-financial-runtime-helper.js';
const repairImplementationPath = 'tests/repair-financial-runtime-helper.migrated.js';
if (active.has(businessPath)) {
  const business = fs.readFileSync(path.join(root, businessPath), 'utf8');
  if (!business.includes("./repair-financial-runtime-helper.js")) {
    violations.push(`${businessPath}: canonical repair financial helper is not active`);
  }
  if (business.includes("./repair-financial-runtime-helper.migrated.js")) {
    violations.push(`${businessPath}: bypasses canonical repair helper wrapper`);
  }
}
if (!active.has(repairWrapperPath)) violations.push(`${repairWrapperPath}: canonical repair helper is not reachable from active certification`);
if (!active.has(repairImplementationPath)) violations.push(`${repairImplementationPath}: portable repair implementation is not reachable through the canonical wrapper`);

if (violations.length) {
  console.error('Active POS certification target audit failed:');
  for (const violation of violations) console.error(` - ${violation}`);
  process.exit(1);
}

console.log(`Active POS certification target audit passed for ${active.size} reachable test modules; no active suite is pinned to port 3001 outside the shared fallback helper, and repair financial certification flows through its canonical portable wrapper.`);
