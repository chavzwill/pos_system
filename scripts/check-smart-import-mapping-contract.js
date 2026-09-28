'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
let failed=0;const check=(n,o)=>o?console.log('PASS Smart Import Mapping:',n):(failed++,console.error('FAIL Smart Import Mapping:',n));
const ui=read('public/index.html'),pkg=read('package.json');
check('shared column mapper exists',ui.includes('_mapImportColumns(rows, fields, title)'));
check('header normalization exists',ui.includes('_normalizeImportHeader(value)'));
check('common supplier spreadsheet aliases exist',ui.includes("itemcode")&&ui.includes("vendorname")&&ui.includes("qtyonhand")&&ui.includes("gctrate"));
check('required fields are enforced before import',ui.includes("fields.filter(f=>f.required&&!mapping[f.key])"));
check('mapping is read-only until continue',ui.includes('Continue Import')&&ui.includes('Preview'));
check('preview shows mapped sample rows',ui.includes("rows.slice(0,3)"));
check('source spreadsheet values are html escaped',ui.includes("replace(/[&<>\\\"']/g"));
check('inventory import uses mapping layer',ui.includes("], 'Inventory Import')")&&ui.includes("'/products/import'"));
check('rental import uses mapping layer',ui.includes("], 'Rental Item Import')")&&ui.includes("'/products/import/rentals'"));
check('rental batching remains after mapping',ui.includes('const BATCH_SIZE = 25'));
check('syntax wall includes smart import mapping',pkg.includes('check:smart-import-mapping'));
if(failed){console.error('Smart Import Mapping contract failed: '+failed);process.exit(1)}
console.log('Smart Import Mapping contract passed.');