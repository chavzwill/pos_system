'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {captureUploadArchive,verifyUploadArchive,restoreUploadArchive}=require('../lib/verified-upload-archive');
const rejects=async(p,rx)=>assert.rejects(p,rx);
async function main(){
 const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'tt-upload-recovery-ci-'));
 try{
  const source=path.join(temp,'uploads');
  await fsp.mkdir(path.join(source,'products'),{recursive:true});
  await fsp.mkdir(path.join(source,'customer-ids'),{recursive:true});
  await fsp.mkdir(path.join(source,'po-attachments'),{recursive:true});
  await fsp.mkdir(path.join(source,'rental-signatures'),{recursive:true});
  const records={
   'products/drill.png':Buffer.from([0x89,0x50,0x4e,0x47,0,12,255,88,55]),
   'customer-ids/identity.pdf':Buffer.from('%PDF-1.7\nSYNTHETIC-NO-REAL-PII\n'),
   'po-attachments/po.txt':Buffer.from('Synthetic test purchase order\n'),
   'rental-signatures/evidence.bin':crypto.randomBytes(67)
  };
  for(const [relative,body] of Object.entries(records)){
   await fsp.writeFile(path.join(source,...relative.split('/')),body);
  }
  await fsp.writeFile(path.join(source,'products','.gitkeep'),'');
  const archive=path.join(temp,'backup-001');
  const result=await captureUploadArchive({sourcePath:source,archivePath:archive});
  assert.equal(result.file_count,4);
  assert.equal(result.verified,true);
  assert.equal(result.scope,'local_uploads_only');
  const found=(await verifyUploadArchive({archivePath:archive}));
  assert.equal(found.file_count,4);
  assert.equal(fs.existsSync(path.join(archive,'products','.gitkeep')),false);
  const restore=path.join(temp,'restored-in-isolation');
  assert.equal((await restoreUploadArchive({archivePath:archive,destinationPath:restore})).verified,true);
  for(const [relative,expected] of Object.entries(records)){
   const data=await fsp.readFile(path.join(restore,...relative.split('/')));
   assert.deepEqual(data,expected,'Restored file does not match: '+relative);
   const mode=(await fsp.stat(path.join(restore,...relative.split('/')))).mode&0o077;
   assert.equal(mode,0,'Files must not be readable by other users');
  }
  await rejects(captureUploadArchive({sourcePath:source,archivePath:archive}),/already exists/);
  await rejects(restoreUploadArchive({archivePath:archive,destinationPath:restore}),/already exists/);
  await rejects(captureUploadArchive({sourcePath:source,archivePath:path.join(source,'nested-backup')}),/within the source|nested within source/);
  await fsp.writeFile(path.join(archive,'products','drill.png'),'tampered content');
  await rejects(verifyUploadArchive({archivePath:archive}),/size mismatch|checksum mismatch/i);
  await rejects(restoreUploadArchive({archivePath:archive,destinationPath:path.join(temp,'should-not-restore')}),/size mismatch|checksum mismatch/i);
  assert.equal(fs.existsSync(path.join(temp,'should-not-restore')),false);
  // Construct an entirely new archive to test unlisted files, missing files,
  // corrupt manifests, path traversal and forbidden filesystem links.
  const extra=path.join(temp,'backup-002');
  await captureUploadArchive({sourcePath:source,archivePath:extra});
  await fsp.writeFile(path.join(extra,'products','undocumented.jpg'),'unknown');
  await rejects(verifyUploadArchive({archivePath:extra}),/inventory differs/);
  await fsp.rm(path.join(extra,'products','undocumented.jpg'));
  await fsp.rm(path.join(extra,'customer-ids','identity.pdf'));
  await rejects(verifyUploadArchive({archivePath:extra}),/inventory differs/);
  const unsafe=path.join(temp,'backup-003');
  await captureUploadArchive({sourcePath:source,archivePath:unsafe});
  const manifestPath=path.join(unsafe,'.tt-pos-upload-manifest.json');
  const bytes=JSON.parse(await fsp.readFile(manifestPath,'utf8'));
  bytes.files[0].path='../outside.txt';
  const rewrite=JSON.stringify(bytes);
  await fsp.writeFile(manifestPath,rewrite);
  await fsp.writeFile(unsafe+'.tt-pos-upload-manifest.sha256',crypto.createHash('sha256').update(rewrite).digest('hex')+'\n');
  await rejects(verifyUploadArchive({archivePath:unsafe}),/Unsafe relative file path|inventory differs/);
  const noChecksum=path.join(temp,'backup-004');
  await captureUploadArchive({sourcePath:source,archivePath:noChecksum});
  await fsp.writeFile(noChecksum+'.tt-pos-upload-manifest.sha256','0'.repeat(64));
  await rejects(verifyUploadArchive({archivePath:noChecksum}),/Manifest checksum mismatch/);
  const badRoot=path.join(temp,'source-link');
  await fsp.symlink(source,badRoot,'dir');
  await rejects(captureUploadArchive({sourcePath:badRoot,archivePath:path.join(temp,'bad-root-archive')}),/not a symlink/);
  const badChild=path.join(source,'po-attachments','link.txt');
  await fsp.symlink(path.join(source,'customer-ids','identity.pdf'),badChild);
  await rejects(captureUploadArchive({sourcePath:source,archivePath:path.join(temp,'bad-file-archive')}),/Symbolic links/);
  assert.equal(fs.existsSync(path.join(temp,'bad-file-archive')),false);
  await fsp.rm(badChild);
  const hardlink=path.join(source,'products','hardlink.png');
  await fsp.link(path.join(source,'products','drill.png'),hardlink);
  await rejects(captureUploadArchive({sourcePath:source,archivePath:path.join(temp,'bad-hardlink-archive')}),/Hard-linked file/);
  assert.equal(fs.existsSync(path.join(temp,'bad-hardlink-archive')),false);
  console.log('PASS: verified upload snapshot, offline isolated restoration, SHA-256 and manifest integrity, file privacy, overwrite refusal, malicious paths, missing/extra files, symlink/hardlink refusal');
 }finally{await fsp.rm(temp,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
