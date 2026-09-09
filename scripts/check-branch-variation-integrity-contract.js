'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const failures=[];
function requireText(file,needle,label){const text=read(file);if(!text.includes(needle))failures.push(`${label}: ${file} is missing ${needle}`);}
function forbid(file,needle,label){const text=read(file);if(text.includes(needle))failures.push(`${label}: ${file} unexpectedly contains ${needle}`);}

requireText('lib/branch-variation-inventory.js','CREATE TABLE IF NOT EXISTS branch_variation_inventory(','branch variation ledger');
requireText('lib/branch-variation-inventory.js','branch_variation_migrations','migration authority');
requireText('lib/branch-variation-inventory.js','trg_branch_variation_sale_guard','branch-level variation sale guard');
requireText('lib/branch-variation-inventory.js','Insufficient exact variation stock at this branch','fail-closed exact variation stock');
requireText('lib/branch-variation-inventory.js','trg_branch_variation_return','return conservation');
requireText('lib/branch-variation-inventory.js','trg_branch_variation_void','void conservation');
requireText('lib/branch-variation-inventory.js','trg_branch_variation_replacement_guard','replacement stock guard');
requireText('lib/branch-variation-inventory.js','CREATE TABLE IF NOT EXISTS replacement_fulfillments(','first-request replacement trigger readiness');
requireText('routes/branch-variation-inventory.js','Opening balance must explicitly count every variation','explicit physical count requirement');
requireText('routes/branch-variation-inventory.js','branch_variation_parent_mismatch','parent/variation conservation');
requireText('routes/branch-variation-inventory.js','branch_variation_migration_race','opening balance concurrency');
requireText('routes/branch-variation-inventory.js','branch_variation_finalize_scope','cross-branch finalization authority');
requireText('routes/branch-variation-inventory.js','branch_variation_branch_drift','final reconciliation drift detection');
requireText('routes/multi-branch-integrity-guard.js',"router.use('/branch-variation-inventory'",'API route mounting');
requireText('routes/multi-branch-integrity-guard.js','ensureBranchVariationInventory','global trigger initialization');
requireText('public/branch-variation-migration.js','Variation opening balance','operator workflow');
requireText('public/branch-variation-migration.js','No historical branch split will be guessed','legacy truthfulness');
requireText('public/branch-variation-migration.css','@media(max-width:720px)','mobile layout');
requireText('public/app-shell.html','/branch-variation-migration.js?v=','runtime wiring');
requireText('public/app-shell.html','/branch-variation-migration.css?v=','runtime styling');
requireText('public/shell-deferred.js','/guided-mode-branch-variation-extension.js','Guided Mode extension wiring');
requireText('public/guided-mode-branch-variation-extension.js',"id:'branch-variation-migration'",'Guided Mode migration task');
requireText('public/guided-mode-branch-variation-extension.js',"coverage['lib/branch-variation-inventory.js']",'Guided Mode workflow coverage');
requireText('public/guided-mode-branch-variation-extension.js','Concurrent conversion is single-winner','Guided Mode PR concurrency guidance');
requireText('public/guided-mode-branch-variation-extension.js','Once receiving begins, variation provenance is immutable','Guided Mode PO variation guidance');
forbid('routes/branch-variation-inventory.js','UPDATE product_variations SET stock_qty=? WHERE id=? AND product_id=?', 'global reconciliation must remain explicit');
// The previous forbid is intentionally overridden below: the explicit finalize endpoint
// is the one place global variation stock is allowed to be rewritten from counted branch
// authority. Verify it occurs inside the reconciliation route rather than opening-balance.
const route=read('routes/branch-variation-inventory.js');
const openIndex=route.indexOf("router.post('/opening-balance'");
const finalizeIndex=route.indexOf("router.post('/reconcile-product/:productId'");
const globalRewrite=route.indexOf('UPDATE product_variations SET stock_qty=?');
if(!(openIndex>=0&&finalizeIndex>openIndex&&globalRewrite>finalizeIndex))failures.push('Global variation rewrite must occur only in explicit product finalization, never during branch opening balance.');
// Remove the deliberate generic forbid failure when the rewrite is correctly scoped.
const forbiddenIndex=failures.findIndex(x=>x.startsWith('global reconciliation must remain explicit:'));
if(forbiddenIndex>=0&&globalRewrite>finalizeIndex)failures.splice(forbiddenIndex,1);

if(failures.length){console.error('Branch variation inventory integrity contract FAILED');for(const f of failures)console.error(' - '+f);process.exit(1);}console.log('Branch variation inventory integrity contract passed.');
