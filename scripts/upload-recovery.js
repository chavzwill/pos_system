#!/usr/bin/env node
'use strict';
// Controlled local-media backup and isolated restore. Never reads live Vercel files.
const {captureUploadArchive,verifyUploadArchive,restoreUploadArchive}=require('../lib/verified-upload-archive');
async function main(){
 const [mode,first,second,...extra]=process.argv.slice(2);
 const usage='Usage: node scripts/upload-recovery.js capture <local-uploads-dir> <NEW-archive-dir> | verify <archive-dir> | restore <archive-dir> <NEW-isolated-dir>';
 if(extra.length||!['capture','verify','restore'].includes(mode)||!first||((mode==='verify')?Boolean(second):!second))
  throw new Error(usage);
 if(mode!=='verify'){
  if(process.env.GITHUB_ACTIONS==='true')throw new Error('Live media capture/restore is not permitted on CI');
  if(process.env.POS_UPLOAD_RECOVERY_ACKNOWLEDGE!=='SENSITIVE_MEDIA')
   throw new Error('Set POS_UPLOAD_RECOVERY_ACKNOWLEDGE=SENSITIVE_MEDIA; output contains sensitive, unencrypted business files');
 }
 let result;
 if(mode==='capture')result=await captureUploadArchive({sourcePath:first,archivePath:second});
 if(mode==='verify')result=await verifyUploadArchive({archivePath:first});
 if(mode==='restore')result=await restoreUploadArchive({archivePath:first,destinationPath:second});
 console.log('PASS '+mode+': '+JSON.stringify(result));
 console.log('NOTE: This archive covers only local uploaded files. It excludes database rows, Cloudinary/provider objects and files on other app instances. No production-wide DR certification is implied.');
}
main().catch(err=>{console.error('UPLOAD RECOVERY FAILED: '+String(err?.message||err));process.exitCode=1;});
