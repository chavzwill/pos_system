'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
const root=path.resolve(__dirname,'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'local-spendos.config.json'),'utf8'));
(async()=>{
 const destination=path.join(root,'local-spendos-runtime');fs.mkdirSync(destination,{recursive:true});
 const db=new DatabaseSync(config.posDatabase,{readOnly:true});
 const filename=path.join(destination,'pos-before-integration-'+Date.now()+'.db');
 await backup(db,filename);db.close();
 console.log(JSON.stringify({backup:filename}));
})().catch(e=>{console.error(e);process.exitCode=1;});
