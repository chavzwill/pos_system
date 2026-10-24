'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const db=read('database.js');
const vercel=JSON.parse(read('vercel.json'));
const shell=read('public/app-shell.html');

const checks=[];
const check=(name,pass)=>checks.push({name,pass:!!pass});

check('Vercel root is served from the static fast shell',
  Array.isArray(vercel.rewrites) &&
  vercel.rewrites.some(r=>r.source==='/'&&r.destination==='/app-shell.html'));
check('Vercel leaves API routing to the detected Express framework',
  Array.isArray(vercel.rewrites) &&
  !vercel.rewrites.some(r=>String(r.destination||'').includes('server.js')));
check('static shell has shared redesigned assets',
  shell.includes('/ui-workspaces.css?v=20261024-receiving2') &&
  shell.includes('/app-shell.js?v=20261024-receiving2'));
check('remote schema readiness has an explicit version marker',
  db.includes("const POS_SCHEMA_VERSION = '2026-10-21-fast-boot-v1'"));
check('cold-start fast path reads only the persisted schema version before full init',
  db.includes('async function _remoteSchemaVersionIsCurrent()') &&
  db.indexOf('if (await _remoteSchemaVersionIsCurrent()) return;') <
    db.indexOf('await _init();'));
check('successful full initialization persists the remote schema version',
  db.includes('await _writeRemoteSchemaVersion();') &&
  db.includes("ON CONFLICT(key) DO UPDATE SET"));
check('local SQLite still runs the full bootstrap path',
  db.includes("if (!process.env.TURSO_DATABASE_URL) return false;"));

for(const c of checks) console.log(`${c.pass?'PASS':'FAIL'} Startup performance: ${c.name}`);
if(checks.some(c=>!c.pass)) process.exit(1);
console.log(`Startup performance contract OK (${checks.length} checks).`);
