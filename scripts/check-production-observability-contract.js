'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const need=(file,needle,label)=>{const c=read(file);if(!c.includes(needle))throw new Error(`${label} missing: ${needle}`);return c;};

need('docker-compose.yml','healthcheck:','container readiness healthcheck');
need('docker-compose.yml',"fetch('http://127.0.0.1:3001/api/products')",'native POS readiness probe');
need('docker-compose.yml','start_period: 20s','startup grace period');
need('docker-compose.host.yml','condition: service_healthy','reverse proxy waits for app readiness');

need('scripts/production-host-verify.sh','app_health','container health verification');
need('scripts/production-host-verify.sh','proxy -> native POS -> database readiness -> auth boundary is healthy','end-to-end readiness verification');
need('scripts/production-host-verify.sh','application port 3001 is not host-published','network exposure verification');
need('scripts/production-host-verify.sh','uploads persistence path is writable','upload persistence verification');

need('scripts/production-smoke.sh','protected API rejects anonymous access','anonymous boundary smoke test');
need('scripts/production-smoke.sh','smoke employee authenticated successfully','authenticated smoke test');
need('scripts/production-smoke.sh','check_endpoint purchasing','purchasing smoke coverage');
need('scripts/production-smoke.sh','check_endpoint rentals','rentals smoke coverage');
need('scripts/production-smoke.sh','check_endpoint repairs','repairs smoke coverage');
need('scripts/production-smoke.sh','check_endpoint dispatch','dispatch smoke coverage');
need('scripts/production-smoke.sh','check_endpoint accounting','accounting smoke coverage');

need('scripts/production-cutover-gate.sh','CUTOVER_CONFIRM=VERIFY_ONLY','explicit cutover verification acknowledgement');
need('scripts/production-cutover-gate.sh','POS_EXPECTED_RELEASE_SHA','release SHA pinning');
need('scripts/production-cutover-gate.sh','POS_CUTOVER_BACKUP_ARCHIVE','release-adjacent recovery rehearsal');
need('scripts/production-cutover-gate.sh','No deployment, package installation, database mutation, or paid service was triggered','non-deploying cutover safety');

console.log('Production observability/cutover contract passed: startup grace, database-backed container readiness, proxy sequencing, protected readiness verification, read-only smoke coverage, release SHA pinning, and recovery evidence are required.');
