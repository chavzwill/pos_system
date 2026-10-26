'use strict';
// Offline, provider-independent upload archive validation. No network or DB access.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {constants}=fs;
const MANIFEST='.tt-pos-upload-manifest.json';
const MARKER='.tt-pos-upload-manifest.sha256';

function insist(ok,message){if(!ok)throw new Error(message);}
async function absent(location){
 try{await fsp.lstat(location);throw new Error('Archive target already exists: '+location);}
 catch(error){if(error.code!=='ENOENT')throw error;}
}
async function digest(file){
 const h=crypto.createHash('sha256');
 for await(const chunk of fs.createReadStream(file))h.update(chunk);
 return h.digest('hex');
}
async function regularFile(location){
 const info=await fsp.lstat(location);
 insist(info.isFile()&&!info.isSymbolicLink(),'Only regular non-symlink files permitted: '+location);
 insist(info.nlink===1,'Hard-linked file refused: '+location);
 return info;
}
function normalRelative(rel){
 insist(typeof rel==='string'&&rel.length>0&&rel!==MANIFEST,'Invalid archive-relative file name');
 insist(!path.isAbsolute(rel)&&rel.split('/').every(x=>x&&x!=='.'&&x!=='..'),'Unsafe relative file path: '+rel);
 insist(rel===rel.replaceAll('\\','/'),'Backslash in archive path: '+rel);
 return rel;
}
async function listFiles(root,{ignoreArchiveManifest=false}={}){
 const paths=[];
 async function walk(folder,rel=''){
  const entries=await fsp.readdir(folder,{withFileTypes:true});
  for(const item of entries){
   if(ignoreArchiveManifest && !rel && item.name===MANIFEST)continue;
   insist(item.name!==MANIFEST&&item.name!==MARKER,'Source contains a reserved archive manifest file');
   insist(!item.isSymbolicLink(),'Symbolic links are not supported in upload backup: '+item.name);
   const child=rel?rel+'/'+item.name:item.name;
   normalRelative(child);
   const absolute=path.join(folder,item.name);
   if(item.isDirectory()){await walk(absolute,child);continue;}
   insist(item.isFile(),'Unsupported filesystem entry: '+child);
   if(item.name==='.gitkeep')continue;
   paths.push(child);
   insist(paths.length<=100000,'Upload inventory exceeds 100000 files; use provider-native backup');
  }
 }
 await walk(root);
 paths.sort();
 return paths;
}
async function verifyUploadArchive({archivePath}){
 const absolute=path.resolve(archivePath);
 insist((await fsp.lstat(absolute)).isDirectory(),'Archive directory is required');
 const manifestFile=path.join(absolute,MANIFEST);
 await regularFile(manifestFile);
 const bytes=await fsp.readFile(manifestFile);
 const manifestDigest=await fsp.readFile(absolute+MARKER,'utf8');
 insist(manifestDigest.trim()===crypto.createHash('sha256').update(bytes).digest('hex'),'Manifest checksum mismatch');
 const document=JSON.parse(bytes.toString('utf8'));
 insist(document.format==='total-tools-pos-upload-archive-v1'&&document.scope==='local_uploads_only','Incorrect manifest format or scope');
 insist(Array.isArray(document.files)&&document.files.length>0,'Archive manifest has no files');
 const found=await listFiles(absolute,{ignoreArchiveManifest:true});
 const expected=document.files.map(x=>normalRelative(x.path));
 insist(expected.length===new Set(expected).size,'Duplicate archive entries');
 insist(found.length===expected.length&&found.every((p,i)=>p===expected[i]),'Archive file inventory differs from manifest (missing or unlisted files)');
 let bytesTotal=0;
 for(const entry of document.files){
  insist(Number.isSafeInteger(entry.size)&&entry.size>=0&&/^[a-f0-9]{64}$/.test(entry.sha256),'Invalid file inventory metadata');
  const file=path.join(absolute,...entry.path.split('/'));
  const current=await regularFile(file);
  insist(current.size===entry.size,'File size mismatch: '+entry.path);
  insist((await digest(file))===entry.sha256,'File checksum mismatch: '+entry.path);
  bytesTotal+=current.size;
 }
 insist(bytesTotal===document.total_bytes,'Total byte count mismatch');
 return {verified:true,file_count:document.files.length,total_bytes:bytesTotal,scope:document.scope};
}
async function captureUploadArchive({sourcePath,archivePath,clock=()=>new Date()}){
 insist(typeof sourcePath==='string'&&typeof archivePath==='string','Source and output must be provided');
 const source=path.resolve(sourcePath),output=path.resolve(archivePath);
 const root=await fsp.lstat(source);
 insist(root.isDirectory()&&!root.isSymbolicLink(),'Source must be a real directory, not a symlink');
 const actual=await fsp.realpath(source);
 insist(!output.startsWith(actual+path.sep)&&output!==actual,'Archive cannot be within the source upload tree');
 await absent(output);await absent(output+MARKER);
 const parent=path.dirname(output);
 insist(!output.startsWith(source+path.sep),'Archive cannot be nested within source');
 const parentInfo=await fsp.lstat(parent);
 insist(parentInfo.isDirectory()&&!parentInfo.isSymbolicLink(),'Archive parent must be a real directory');
 const stage=output+'.partial-'+crypto.randomBytes(8).toString('hex');
 let published=false,sidecar=false;
 const inventory=[];
 try{
  await fsp.mkdir(stage,{mode:0o700});
  const paths=await listFiles(source);
  insist(paths.length>0,'No actual upload files were found; cannot certify an empty archive');
  for(const rel of paths){
   const input=path.join(source,...rel.split('/'));
   const before=await regularFile(input);
   const beforeHash=await digest(input);
   const target=path.join(stage,...rel.split('/'));
   await fsp.mkdir(path.dirname(target),{recursive:true,mode:0o700});
   await fsp.copyFile(input,target,constants.COPYFILE_EXCL);
   await fsp.chmod(target,0o600);
   const after=await regularFile(input);
   insist(before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs,
     'Source upload changed during archive: '+rel);
   insist((await digest(input))===beforeHash,'Source upload contents changed during archive: '+rel);
   const dest=await regularFile(target);
   insist(dest.size===before.size,'Copied file size changed: '+rel);
   insist((await digest(target))===beforeHash,'Copied file checksum mismatch: '+rel);
   inventory.push({path:rel,size:dest.size,sha256:beforeHash});
  }
  const document={
   format:'total-tools-pos-upload-archive-v1',scope:'local_uploads_only',
   created_at_utc:clock().toISOString(),
   files:inventory,total_bytes:inventory.reduce((sum,x)=>sum+x.size,0)
  };
  const data=JSON.stringify(document,null,2)+'\n';
  await fsp.writeFile(path.join(stage,MANIFEST),data,{mode:0o600,flag:'wx'});
  await absent(output);await absent(output+MARKER);
  await fsp.rename(stage,output);published=true;
  await fsp.writeFile(output+MARKER,crypto.createHash('sha256').update(data).digest('hex')+'\n',
   {mode:0o600,flag:'wx'});sidecar=true;
  const verified=await verifyUploadArchive({archivePath:output});
  return {archivePath:output,manifestPath:path.join(output,MANIFEST),checksumPath:output+MARKER,...verified};
 }catch(error){
  // Do not leave an archive that could be mistaken for a verified recovery point.
  if(sidecar)await fsp.rm(output+MARKER,{force:true}).catch(()=>{});
  if(published)await fsp.rm(output,{recursive:true,force:true}).catch(()=>{});
  throw error;
 }finally{
  await fsp.rm(stage,{recursive:true,force:true}).catch(()=>{});
 }
}
async function restoreUploadArchive({archivePath,destinationPath}){
 insist(typeof archivePath==='string'&&typeof destinationPath==='string','An archive and new restore destination are required');
 const archive=path.resolve(archivePath),destination=path.resolve(destinationPath);
 insist(destination!==archive&&!destination.startsWith(archive+path.sep),'Cannot restore into the archive itself');
 await absent(destination);
 const parent=await fsp.lstat(path.dirname(destination));
 insist(parent.isDirectory()&&!parent.isSymbolicLink(),'Restore parent must be a real directory');
 const verification=await verifyUploadArchive({archivePath:archive});
 const manifest=JSON.parse(await fsp.readFile(path.join(archive,MANIFEST),'utf8'));
 const stage=destination+'.partial-'+crypto.randomBytes(8).toString('hex');
 let published=false;
 try{
  await fsp.mkdir(stage,{mode:0o700});
  for(const row of manifest.files){
   const rel=normalRelative(row.path);
   const input=path.join(archive,...rel.split('/'));
   const output=path.join(stage,...rel.split('/'));
   await regularFile(input);
   await fsp.mkdir(path.dirname(output),{recursive:true,mode:0o700});
   await fsp.copyFile(input,output,constants.COPYFILE_EXCL);
   await fsp.chmod(output,0o600);
   insist((await digest(output))===row.sha256,'Restored upload verification failed: '+rel);
  }
  await absent(destination);
  await fsp.rename(stage,destination);published=true;
  return {...verification,restored_to:destination};
 }catch(error){
  if(published)await fsp.rm(destination,{recursive:true,force:true}).catch(()=>{});
  throw error;
 }finally{
  await fsp.rm(stage,{recursive:true,force:true}).catch(()=>{});
 }
}
module.exports={captureUploadArchive,verifyUploadArchive,restoreUploadArchive};
