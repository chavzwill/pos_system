'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
function read(p){return fs.readFileSync(path.join(root,p),'utf8');}
function fail(m){console.error(`Role dashboard contract failed: ${m}`);process.exitCode=1;}
const logistics=read('routes/logistics-intelligence.js');
const dashboards=read('routes/role-operations-dashboards.js');
const guard=read('routes/dispatch-security-release-guard.js');
const shell=read('public/app-shell.html');
const ui=read('public/role-operations-dashboard.js');
if(!logistics.includes("require('./role-operations-dashboards')"))fail('role dashboard API must be mounted in logistics intelligence');
if(!logistics.includes("require('./dispatch-security-release-guard')"))fail('dispatch security release guard must be mounted');
if(logistics.indexOf("require('./dispatch-security-release-guard')")>logistics.indexOf("require('./logistics-field-execution')"))fail('security release guard must execute before field pickup mutation');
if(!guard.includes('DISPATCH_SECURITY_RELEASE_REQUIRED'))fail('pickup must fail closed without security release');
if(!guard.includes("source==='purchase_order'"))fail('supplier-origin pickup must remain exempt from Total Tools branch security release');
if(!dashboards.includes('commercial_account_applications'))fail('website credit/commercial application queue is missing');
if(!dashboards.includes("if(!req.apiKey&&!req.employee)"))fail('account application intake must require authenticated integration or employee session');
if(dashboards.includes("function has(req,key){return Boolean(req.apiKey)"))fail('API keys must not inherit internal employee dashboard permissions');
if(!dashboards.includes('is_driver=1'))fail('dispatch dashboard must enumerate configured drivers');
if(!dashboards.includes('is_security'))fail('security dashboard must be bound to security personnel identity');
if(!shell.includes('/role-operations-dashboard.js'))fail('role dashboard UI must load in the native shell');
if(!shell.includes('/role-operations-dashboard.css'))fail('role dashboard responsive styles must load in the native shell');
for(const label of ['Dispatch Control','My Driver Dashboard','Security Shipments','Accounts Approvals'])if(!ui.includes(label))fail(`native navigation entry missing: ${label}`);
if(!process.exitCode)console.log('Role dashboard contract passed: driver, dispatch, security custody release, and accounts application controls are wired.');
