#!/usr/bin/env node
'use strict';
// Manual, operator-owned export; NEVER run against customer data in CI.
const path=require('node:path');
const {createClient}=require('@libsql/client');
const {snapshotLibsql,verifyBackup}=require('../lib/verified-libsql-snapshot');
require('dotenv').config({path:path.join(__dirname,'..','.env'),quiet:true});
async function main(){
 const args=process.argv.slice(2);
 const verify=args[0]==='--verify';
 const filename=verify?args[1]:(args[0]||path.join(__dirname,'..','pos-turso-snapshot.db'));
 if(verify){
  if(!filename||args.length!==2)throw new Error('Usage: node scripts/pull-turso-snapshot.js --verify <snapshot.db>');
  const check=await verifyBackup({path:filename});
  console.log('Verified database-only backup: '+JSON.stringify(check));
  console.log('NOTE: Uploaded media and evidence are not included.');
  return;
 }
 if(args.length>1)throw new Error('Usage: node scripts/pull-turso-snapshot.js [output.db]');
 if(process.env.GITHUB_ACTIONS==='true')throw new Error('Refusing to export real business data on GitHub Actions');
 if(process.env.POS_BACKUP_ACKNOWLEDGE!=='SENSITIVE_DATA'){
  throw new Error('Set POS_BACKUP_ACKNOWLEDGE=SENSITIVE_DATA to explicitly acknowledge the sensitive, unencrypted local export');
 }
 const url=String(process.env.TURSO_DATABASE_URL||'');
 const token=String(process.env.TURSO_AUTH_TOKEN||'');
 if(!/^libsql:\/\//i.test(url)||!token)throw new Error('A remote libsql:// URL and TURSO_AUTH_TOKEN are required');
 const source=createClient({url,authToken:token});
 try{
  const result=await snapshotLibsql({source,output:filename,sourceKind:'remote-libsql'});
  console.log('PASS: Database-only snapshot written with a consistent read transaction, SHA-256 manifest, PRAGMA integrity and foreign-key verification.');
  console.log('Snapshot: '+result.path);
  console.log('Manifest: '+result.manifest);
  console.log('Tables: '+Object.keys(result.table_counts).length+'  Rows: '+result.total_rows);
  console.log('IMPORTANT: This is NOT a full recovery point until product images, documents, rental evidence and other uploads are backed up and a restore drill passes.');
 }finally{await source.close();}
}
main().catch(error=>{console.error('BACKUP FAILED (no successful artifact published): '+String(error?.message||error));process.exitCode=1;});
