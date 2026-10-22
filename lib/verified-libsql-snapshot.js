'use strict';
// Transaction-consistent, read-only libSQL source export to an isolated SQLite file.
// Database-only: media objects and operational uploads require an independent backup.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {createClient}=require('@libsql/client');

const quote=name=>'"'+String(name).replaceAll('"','""')+'"';
function assert(condition,message){if(!condition)throw new Error(message);}
const sql=(sql,args=[])=>({sql,args});
async function sha256(file){
 const hash=crypto.createHash('sha256');
 for await(const chunk of fs.createReadStream(file))hash.update(chunk);
 return hash.digest('hex');
}
async function ensureNoFile(p){
 try{await fsp.lstat(p);throw new Error('Refusing to overwrite existing backup artifact: '+p);}
 catch(error){if(error.code!=='ENOENT')throw error;}
}
async function snapshotLibsql({source,output,chunkSize=250,sourceKind='libsql',clock=()=>new Date()}){
 assert(source && typeof source.transaction==='function','A read-only capable source client is required');
 assert(Number.isInteger(chunkSize)&&chunkSize>=1&&chunkSize<=1000,'chunkSize must be 1..1000');
 assert(typeof output==='string'&&output.length>0,'An output path is required');
 const absolute=path.resolve(output), manifestPath=absolute+'.manifest.json';
 await ensureNoFile(absolute);await ensureNoFile(manifestPath);
 await fsp.access(path.dirname(absolute),fs.constants.W_OK);
 const partial=absolute+'.partial-'+crypto.randomBytes(9).toString('hex');
 const partialManifest=partial+'.manifest';
 let destination,reader,writer,published=false;
 const tableCounts={};
 try{
  const handle=await fsp.open(partial,'wx',0o600);
  await handle.close();
  destination=createClient({url:'file:'+partial});
  reader=await source.transaction('read');
  const entries=(await reader.execute(sql("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','view','trigger') ORDER BY rowid"))).rows;
  const tables=entries.filter(row=>row.type==='table'&&String(row.name)!=='sqlite_sequence'&&!String(row.name).startsWith('sqlite_'));
  const secondary=entries.filter(row=>['index','view','trigger'].includes(String(row.type))&&row.sql);
  assert(tables.length>0,'Source has no user tables — backup refused');
  for(const row of tables){
    assert(typeof row.sql==='string'&&row.sql.trim().length>0,'Unsupported table without SQL definition: '+row.name);
    assert(!/^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql),'Virtual tables require provider-native export: '+row.name);
  }
  // Foreign keys checked AFTER all records and schema are restored. This
  // avoids assuming foreign-key dependency ordering matches sqlite_master.
  await destination.execute(sql('PRAGMA foreign_keys=OFF'));
  writer=await destination.transaction('write');
  for(const row of tables)await writer.execute(sql(row.sql));
  for(const row of tables){
    const name=String(row.name),q=quote(name);
    const schema=(await reader.execute(sql('PRAGMA table_xinfo('+q+')'))).rows;
    const inserted=schema.filter(col=>Number(col.hidden||0)===0);
    assert(inserted.length>0,'No writable columns for '+name);
    const columns=inserted.map(c=>String(c.name));
    const primary=schema.filter(c=>Number(c.pk)>0).sort((a,b)=>Number(a.pk)-Number(b.pk)).map(c=>quote(c.name));
    const order=primary.length?' ORDER BY '+primary.join(','):' ORDER BY rowid';
    const insert='INSERT INTO '+q+' ('+columns.map(quote).join(',')+') VALUES ('+columns.map(()=>'?').join(',')+')';
    let count=0;
    while(true){
      const rows=(await reader.execute(sql('SELECT '+columns.map(quote).join(',')+' FROM '+q+order+' LIMIT ? OFFSET ?',[chunkSize,count]))).rows;
      if(rows.length===0)break;
      for(const item of rows)await writer.execute(sql(insert,columns.map(c=>item[c])));
      count+=rows.length;
      if(rows.length<chunkSize)break;
    }
    tableCounts[name]=count;
  }
  // Preserve AUTOINCREMENT high-water marks even after old rows were deleted.
  const hasSequence=entries.some(row=>row.type==='table'&&row.name==='sqlite_sequence');
  if(hasSequence){
    const sequences=(await reader.execute(sql('SELECT name,seq FROM sqlite_sequence'))).rows;
    for(const seq of sequences){
      await writer.execute(sql('DELETE FROM sqlite_sequence WHERE name=?',[seq.name]));
      await writer.execute(sql('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)',[seq.name,seq.seq]));
    }
  }
  // Recreating secondary objects AFTER data avoids side effects of triggers
  // and improves export throughput.
  for(const row of secondary)await writer.execute(sql(row.sql));
  await writer.commit();writer=null;
  await reader.commit();reader=null;
  const integrity=(await destination.execute(sql('PRAGMA integrity_check'))).rows;
  assert(integrity.length===1&&String(integrity[0].integrity_check).toLowerCase()==='ok','Destination integrity_check failed');
  const fk=(await destination.execute(sql('PRAGMA foreign_key_check'))).rows;
  assert(fk.length===0,'Destination has '+fk.length+' broken foreign-key reference(s)');
  for(const [name,expected] of Object.entries(tableCounts)){
    const result=(await destination.execute(sql('SELECT count(*) AS n FROM '+quote(name)))).rows;
    assert(Number(result[0].n)===expected,'Row-count mismatch in '+name);
  }
  // Never publish a main SQLite file while it still requires a WAL sidecar.
  await destination.execute(sql('PRAGMA wal_checkpoint(TRUNCATE)'));
  await destination.close();destination=null;
  for(const suffix of ['-wal','-shm']){
    try{
      const st=await fsp.stat(partial+suffix);
      assert(suffix==='-shm'||st.size===0,'Backup remains dependent on a non-empty SQLite WAL sidecar');
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const hash=await sha256(partial);
  const info={
    format:'total-tools-pos-libsql-database-export-v1',
    created_at_utc:clock().toISOString(),
    scope:'database_only_no_uploads',
    source_kind:sourceKind,
    integrity_check:'ok',
    foreign_key_violations:0,
    table_counts:tableCounts,
    total_rows:Object.values(tableCounts).reduce((a,b)=>a+b,0),
    sha256:hash
  };
  await fsp.writeFile(partialManifest,JSON.stringify(info,null,2)+'\n',{mode:0o600,flag:'wx'});
  await ensureNoFile(absolute);await ensureNoFile(manifestPath);
  await fsp.rename(partial,absolute);
  published=true;
  await fsp.rename(partialManifest,manifestPath);
  return {path:absolute,manifest:manifestPath,...info};
 }catch(error){
  if(writer)await writer.rollback().catch(()=>{});
  if(reader)await reader.rollback().catch(()=>{});
  if(destination)await destination.close().catch(()=>{});
  if(published)await fsp.rm(absolute,{force:true}).catch(()=>{});
  throw error;
 }finally{
  await fsp.rm(partial,{force:true}).catch(()=>{});
  await fsp.rm(partial+'-wal',{force:true}).catch(()=>{});
  await fsp.rm(partial+'-shm',{force:true}).catch(()=>{});
  await fsp.rm(partialManifest,{force:true}).catch(()=>{});
 }
}
async function verifyBackup({path:output}){
 const absolute=path.resolve(output);
 const manifest=JSON.parse(await fsp.readFile(absolute+'.manifest.json','utf8'));
 assert(manifest.format==='total-tools-pos-libsql-database-export-v1','Unexpected backup manifest format');
 assert(manifest.scope==='database_only_no_uploads','Unexpected backup scope');
 assert((await sha256(absolute))===manifest.sha256,'Backup SHA-256 mismatch');
 const dest=createClient({url:'file:'+absolute});
 try{
  const integrity=(await dest.execute(sql('PRAGMA integrity_check'))).rows;
  assert(integrity.length===1&&String(integrity[0].integrity_check).toLowerCase()==='ok','Backup integrity_check failed');
  const fk=(await dest.execute(sql('PRAGMA foreign_key_check'))).rows;
  assert(fk.length===0,'Backup foreign_key_check failed');
  for(const [table,count] of Object.entries(manifest.table_counts)){
   const rows=(await dest.execute(sql('SELECT count(*) AS n FROM '+quote(table)))).rows;
   assert(Number(rows[0].n)===count,'Backup row count drift: '+table);
  }
  return {verified:true,scope:manifest.scope,table_count:Object.keys(manifest.table_counts).length,total_rows:manifest.total_rows};
 }finally{await dest.close();}
}
module.exports={snapshotLibsql,verifyBackup};
