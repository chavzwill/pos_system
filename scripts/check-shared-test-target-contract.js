'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const helper=fs.readFileSync(path.join(root,'tests/test-base-url.js'),'utf8');
if(!helper.includes('POS_TEST_BASE_URL'))throw new Error('Shared POS test target helper must honor POS_TEST_BASE_URL');
if(!helper.includes('assertSafeMutationTarget'))throw new Error('Shared POS test target helper must retain mutation-target protection');

const portable=[
  'native-pos-certification.spec.js',
  'security-boundaries.spec.js',
  'erp-intelligence.spec.js',
  'inventory-intelligence.spec.js',
  'operational-reports.spec.js',
  'technician-compensation.spec.js',
  'accounting-ledger-integrity.spec.js',
  'accounting-source-sync-rbac.spec.js',
  'pos-financial-runtime.js',
  'purchase-order-hardening.spec.js',
  'procurement-intelligence-integrity.spec.js',
  'loss-control-integrity.spec.js',
  'rentals-integrity.spec.js',
  'repair-quality-integrity.spec.js',
  'service-completion-integrity.spec.js',
  'logistics-intelligence.spec.js',
];
for(const file of portable){
  const content=fs.readFileSync(path.join(root,'tests',file),'utf8');
  if(!content.includes('./test-base-url.js'))throw new Error(`${file} must use the shared test target helper`);
  if(content.includes('http://localhost:3001'))throw new Error(`${file} must not hardcode localhost:3001`);
}

const mutationGuarded=[
  'security-boundaries.spec.js',
  'accounting-ledger-integrity.spec.js',
  'accounting-source-sync-rbac.spec.js',
  'pos-financial-runtime.js',
  'purchase-order-hardening.spec.js',
  'procurement-intelligence-integrity.spec.js',
  'loss-control-integrity.spec.js',
  'repair-quality-integrity.spec.js',
  'logistics-intelligence.spec.js',
];
for(const file of mutationGuarded){
  const content=fs.readFileSync(path.join(root,'tests',file),'utf8');
  if(!content.includes('assertSafeMutationTarget'))throw new Error(`${file} must retain external mutation-target protection`);
}
console.log(`Shared POS test target contract passed for ${portable.length} migrated certification modules.`);
