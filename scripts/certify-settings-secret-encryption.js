'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const { createClient } = require('@libsql/client');
const { revealSettingValue, isEncryptedSettingValue } = require('../lib/secureSettings');

const DB_FILES = ['pos.db','pos.db-shm','pos.db-wal'];
const KEY = 'UE9TLUNJLVNldHRpbmdzLUtleS0zMi1CeXRlcy0xMjM=';
const SMTP_SECRET = 'smtp-runtime-secret-A9!';
const WOO_SECRET = 'woo-runtime-secret-B8!';

function cleanDb(){ for(const file of DB_FILES){ try{fs.rmSync(file,{force:true});}catch(_){}} }
function run(extraEnv={}){
  return spawnSync(process.execPath,['scripts/production-settings-secret-preflight.js'],{
    cwd:process.cwd(),
    env:{...process.env,NODE_ENV:'production',TURSO_DATABASE_URL:'',TURSO_AUTH_TOKEN:'',POS_SETTINGS_ENCRYPTION_KEY:'',...extraEnv},
    encoding:'utf8',
  });
}
function assert(condition,message){if(!condition)throw new Error(message);}

async function main(){
  if(process.env.TURSO_DATABASE_URL)throw new Error('Settings encryption certification must use isolated local SQLite, not Turso.');
  cleanDb();
  try{
    const seed=createClient({url:'file:pos.db'});
    try{
      await seed.execute('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      await seed.execute({sql:'INSERT INTO settings(key,value) VALUES(?,?),(?,?)',args:['email_smtp_pass',SMTP_SECRET,'woo_consumer_secret',WOO_SECRET]});
    }finally{seed.close();}

    const missing=run();
    assert(missing.status!==0,'Production secret preflight unexpectedly accepted configured plaintext secrets without an encryption key.');
    assert(/SECURITY SETTINGS BLOCK/i.test(`${missing.stdout}\n${missing.stderr}`),'Missing-key failure did not use the settings security block.');

    const invalid=run({POS_SETTINGS_ENCRYPTION_KEY:'not-a-valid-32-byte-key'});
    assert(invalid.status!==0,'Production secret preflight unexpectedly accepted an invalid encryption key.');

    const migrated=run({POS_SETTINGS_ENCRYPTION_KEY:KEY});
    assert(migrated.status===0,`Settings secret migration failed: ${String(migrated.stderr||migrated.stdout).slice(0,600)}`);

    const db=createClient({url:'file:pos.db'});
    let firstCiphertexts;
    try{
      const {rows}=await db.execute({sql:"SELECT key,value FROM settings WHERE key IN ('email_smtp_pass','woo_consumer_secret') ORDER BY key",args:[]});
      assert(rows.length===2,'Expected two protected secret rows after migration.');
      for(const row of rows){
        assert(isEncryptedSettingValue(String(row.value||'')),`${row.key} is not encrypted at rest.`);
        assert(!String(row.value).includes(SMTP_SECRET)&&!String(row.value).includes(WOO_SECRET),`${row.key} ciphertext contains plaintext secret material.`);
      }
      firstCiphertexts=Object.fromEntries(rows.map(row=>[row.key,String(row.value)]));
      const previous=process.env.POS_SETTINGS_ENCRYPTION_KEY;
      process.env.POS_SETTINGS_ENCRYPTION_KEY=KEY;
      try{
        assert(revealSettingValue('email_smtp_pass',firstCiphertexts.email_smtp_pass)===SMTP_SECRET,'SMTP secret did not decrypt to its original value.');
        assert(revealSettingValue('woo_consumer_secret',firstCiphertexts.woo_consumer_secret)===WOO_SECRET,'WooCommerce secret did not decrypt to its original value.');
      }finally{
        if(previous===undefined)delete process.env.POS_SETTINGS_ENCRYPTION_KEY;else process.env.POS_SETTINGS_ENCRYPTION_KEY=previous;
      }
    }finally{db.close();}

    const second=run({POS_SETTINGS_ENCRYPTION_KEY:KEY});
    assert(second.status===0,'Idempotent settings secret preflight rerun failed.');
    const verify=createClient({url:'file:pos.db'});
    try{
      const {rows}=await verify.execute({sql:"SELECT key,value FROM settings WHERE key IN ('email_smtp_pass','woo_consumer_secret') ORDER BY key",args:[]});
      for(const row of rows)assert(String(row.value)===firstCiphertexts[row.key],`${row.key} was unnecessarily re-encrypted on an idempotent preflight.`);
    }finally{verify.close();}

    const wrongKey=Buffer.alloc(32,7).toString('base64');
    const wrong=run({POS_SETTINGS_ENCRYPTION_KEY:wrongKey});
    assert(wrong.status!==0,'Encrypted settings unexpectedly passed preflight with the wrong key.');

    console.log('Settings secret encryption certification passed: production fails closed without a key, migrates plaintext once, decrypts correctly, is idempotent, and rejects the wrong key.');
  }finally{cleanDb();}
}

main().catch(error=>{console.error(error&&error.stack||error);cleanDb();process.exit(1);});
