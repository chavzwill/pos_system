'use strict';
const fs=require('fs');
const path=require('path');
const source=fs.readFileSync(path.join(__dirname,'..','routes','operational-reports.js'),'utf8');
let failed=0;
function check(name,pass){console.log(`${pass?'PASS':'FAIL'} Supplier Reports: ${name}`);if(!pass)failed++;}
check('performance report declares evidence window',source.includes('evidence_window'));
check('performance report declares rating method',source.includes('rating_method'));
check('performance report declares evidence status',source.includes('evidence_status'));
check('insufficient evidence is human-readable',source.includes('Not enough data'));
check('insufficient evidence does not become a zero score',source.includes('overall_rating_score=null'));
check('sales attribution rule is explicit',source.includes('Current product supplier assignment'));
check('supplier performance uses safe public error',source.includes('SUPPLIER_PERFORMANCE_REPORT_UNAVAILABLE'));
check('supplier items uses safe public error',source.includes('SUPPLIER_ITEMS_REPORT_UNAVAILABLE'));
if(failed){console.error(`Supplier report evidence contract failed: ${failed}`);process.exit(1);}
console.log('Supplier report evidence contract passed.');
