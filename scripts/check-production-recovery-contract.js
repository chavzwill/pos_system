'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const must=(file,needle,label)=>{const c=read(file);if(!c.includes(needle))throw new Error(`${label} missing required evidence: ${needle}`);return c;};

const backup='scripts/production-backup.sh';
const restore='scripts/production-restore.sh';
const rehearsal='scripts/production-recovery-rehearsal.sh';
const smoke='scripts/production-smoke.sh';
for(const f of [backup,restore,rehearsal,smoke]) if(!fs.existsSync(path.join(root,f))) throw new Error(`Missing production recovery asset: ${f}`);

must(backup,'docker compose stop app','backup write-quiescence requirement');
must(backup,'data/pos.db','database backup coverage');
must(backup,'tar -czf "$ARCHIVE_PATH" data uploads','database/upload atomic archive scope');
must(backup,'sha256sum -c "$CHECKSUM_PATH"','backup checksum verification');
must(backup,'secrets_included=no','backup secret exclusion evidence');

must(restore,'RESTORE_CONFIRM=RESTORE','destructive restore acknowledgement');
must(restore,'sha256sum -c','restore checksum verification');
must(restore,"grep -Eq '(^|/)\\.env$|(^|/)\\.git(/|$)|(^|/)node_modules(/|$)'",'forbidden restore content guard');
must(restore,'.restore-safety-','pre-restore safety copy');
must(restore,'original pre-restore state was put back','failed-restore automatic rollback');

must(rehearsal,'mktemp -d','isolated recovery rehearsal');
must(rehearsal,'PRAGMA quick_check;','SQLite quick check');
must(rehearsal,'PRAGMA integrity_check;','SQLite integrity check');
must(rehearsal,'sqlite3 -readonly','read-only restored-state validation');
must(rehearsal,'live data was not modified','non-destructive rehearsal evidence');

must(smoke,'protected API rejects anonymous access','post-restore auth smoke');
must(smoke,'check_endpoint products /api/products','post-restore inventory smoke');
must(smoke,'check_endpoint purchasing /api/purchase-orders','post-restore purchasing smoke');
must(smoke,'check_endpoint rentals /api/rentals','post-restore rental smoke');
must(smoke,'check_endpoint repairs /api/work-orders','post-restore repair smoke');
must(smoke,'check_endpoint dispatch /api/logistics-intelligence','post-restore dispatch smoke');
must(smoke,'check_endpoint accounting /api/accounting-intelligence','post-restore accounting smoke');

console.log('POS recovery contract passed: quiesced backups, checksums, secret exclusion, safety-copy rollback, isolated restore rehearsal, SQLite integrity validation, and read-only production smoke coverage are present.');
