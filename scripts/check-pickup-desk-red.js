'use strict';
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const required=[
  'routes/employee-customer-pickup-desk.js',
  'public/customer-pickup-desk-ui.js'
];
let failed=0;
for(const file of required){
  const ok=fs.existsSync(path.join(root,file));
  console.log(ok?'PASS':'FAIL',file);
  if(!ok)failed++;
}
const mount=fs.readFileSync(path.join(root,'routes','employee-end-shift-assistant.js'),'utf8');
if(!mount.includes("employee-customer-pickup-desk")){console.error('FAIL pickup desk mount');failed++;}
if(failed)process.exit(1);
console.log('Pickup Desk RED probe unexpectedly passed');
