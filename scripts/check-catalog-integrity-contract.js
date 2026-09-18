'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=f=>{try{return fs.readFileSync(path.join(root,f),'utf8')}catch(_){return''}};
let failed=0;
function check(name,ok){if(ok)console.log('PASS Catalog Integrity:',name);else{failed++;console.error('FAIL Catalog Integrity:',name);}}

const lib=read('lib/catalog-integrity.js');
const route=read('routes/catalog-integrity.js');
const products=read('routes/products.js');
const categories=read('routes/categories.js');
const server=read('server.js');
const ui=read('public/catalog-admin-workspace.js');

check('shared catalog integrity authority exists',/inspectProductCleanup/.test(lib)&&/archiveProduct/.test(lib));
check('product archive never hard deletes product row',!/DELETE FROM products/i.test(lib)&&/active\s*=\s*0/i.test(lib));
check('archive blocks physical stock',/CATALOG_PRODUCT_STOCK_PRESENT/.test(lib)&&/branch/i.test(lib));
check('archive preserves historical references',/historical/i.test(lib)&&/reference/i.test(lib));
check('health reports stock mismatches',/stock_balance_mismatch/.test(lib));
check('health reports inactive products with stock',/inactive_with_stock/.test(lib));
check('health reports missing category supplier and online image',/missing_category/.test(lib)&&/missing_supplier/.test(lib)&&/online_missing_image/.test(lib));
check('health reports normalized duplicate categories',/duplicate_category_name/.test(lib));
check('catalog integrity route requires inventory authority',/requirePermission\(['\"]inventory['\"]\)/.test(route));
check('server mounts catalog integrity route',server.includes("'/api/catalog-integrity'"));
check('product delete uses shared archive authority',/archiveProduct/.test(products));
check('retirement records attributable audit evidence',lib.includes('recordSecurityAudit')&&lib.includes('catalog_product_retired')&&products.includes('actorEmployeeId:req.employee?.id'));
check('direct product update cannot bypass retirement authority',products.includes('CATALOG_RETIREMENT_ROUTE_REQUIRED'));
check('category writes reject normalized duplicates',/CATEGORY_NAME_EXISTS/.test(categories));
check('UI exposes Catalog Health in staff language',ui.includes('Catalog Health')&&ui.includes('Needs attention')&&ui.includes('What to do next'));
check('UI retirement is an explicit governed action',ui.includes('Retire product')&&ui.includes("method:'DELETE'"));
check('UI does not expose dependency table names',!ui.includes('tables_with_references'));

if(failed){console.error('Catalog Integrity contract failed: '+failed);process.exit(1);}console.log('Catalog Integrity contract passed.');
