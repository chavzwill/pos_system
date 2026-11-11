'use strict';
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
const read=f=>{try{return fs.readFileSync(path.join(root,f),'utf8')}catch(_){return''}};
let failed=0;
const check=(n,o)=>o?console.log('PASS Category Consolidation:',n):(failed++,console.error('FAIL Category Consolidation:',n));
const db=read('database.js'),lib=read('lib/catalog-integrity.js'),route=read('routes/catalog-integrity.js'),promo=read('routes/promotions.js'),sync=read('routes/commerce-sync.js'),ui=read('public/catalog-admin-workspace.js'),pkg=read('package.json');
check('append-only category consolidation evidence exists',db.includes('catalog_category_consolidations')&&db.includes('catalog_category_consolidations_no_update')&&db.includes('catalog_category_consolidations_no_delete'));
check('health emits exact duplicate-category candidate key',lib.includes('categoryCandidateKey')&&lib.includes('candidate_key:categoryCandidateKey(ids)'));
check('preview is read only',lib.includes('inspectCategoryConsolidation')&&lib.includes('read_only:true'));
check('consolidation requires typed confirmation',lib.includes('CATALOG_CATEGORY_CONSOLIDATION_CONFIRMATION_REQUIRED')&&lib.includes("'CONSOLIDATE'"));
check('consolidation requires reason and actor',lib.includes('CATALOG_CATEGORY_CONSOLIDATION_REASON_REQUIRED')&&lib.includes('CATALOG_CATEGORY_CONSOLIDATION_ACTOR_REQUIRED'));
check('products move to survivor category',lib.includes('UPDATE products SET category_id=? WHERE category_id=?'));
check('promotion category scope migrates idempotently',lib.includes('INSERT OR IGNORE INTO promotion_items')&&lib.includes("item_type='category'"));
check('duplicate category is removed only inside governed consolidation',lib.includes('DELETE FROM categories WHERE id=?'));
check('stale category ids resolve canonically',lib.includes('resolveCanonicalCategory')&&lib.includes('duplicate_category_id=?'));
check('API exposes preview and controlled consolidation',route.includes("'/category-consolidation-preview'")&&route.includes("'/category-consolidations'"));
check('promotion writes canonicalize category ids',promo.includes('resolveCanonicalCategory')&&promo.includes('canonical_category_id'));
check('website sync exports category consolidation mappings',sync.includes('category_consolidations')&&sync.includes('duplicate_category_id')&&sync.includes('survivor_category_id'));
check('Catalog Health exposes controlled category consolidation action',ui.includes('Consolidate duplicate categories')&&ui.includes('data-category-consolidation')&&ui.includes('executeCategoryConsolidation'));
const syncContractVersion=sync.match(/CONTRACT_VERSION = '([0-9]{4}-[0-9]{2}-[0-9]{2})[.]([0-9]+)'/);
check('commerce contract version advanced',
  Boolean(syncContractVersion) && Number.isFinite(Date.parse(syncContractVersion[1])) &&
  (syncContractVersion[1] > '2026-09-20' ||
   (syncContractVersion[1] === '2026-09-20' && Number(syncContractVersion[2]) >= 3)));
check('full syntax wall includes category consolidation',pkg.includes('check:category-consolidation'));
if(failed){console.error('Category Consolidation contract failed: '+failed);process.exit(1)}
console.log('Category Consolidation contract passed.');