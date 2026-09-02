import { test, expect } from '@playwright/test';
import { createRequire } from 'module';

const require=createRequire(import.meta.url);
const { createClient }=require('@libsql/client');
const { isEncryptedSettingValue,revealSettingValue }=require('../lib/secureSettings');
const BASE='http://localhost:3001';
const ADMIN_USER=process.env.POS_TEST_USER||'admin';
const ADMIN_PASSWORD=process.env.POS_TEST_PASSWORD||'CI-Test-Auth!2026';

async function login(){
  const r=await fetch(`${BASE}/api/employees/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:ADMIN_USER,password:ADMIN_PASSWORD})});
  expect(r.status).toBe(200);
  return (r.headers.get('set-cookie')||'').split(';')[0];
}
async function api(cookie,method,path,body){
  const r=await fetch(`${BASE}${path}`,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json().catch(()=>null)};
}

test.describe('Integration secret encryption at rest',()=>{
  test('live Settings API writes authenticated ciphertext while reads remain masked',async()=>{
    expect(process.env.POS_SETTINGS_ENCRYPTION_KEY).toBeTruthy();
    const cookie=await login();
    const stamp=Date.now();
    const smtp=`SMTP-Live-${stamp}-A9!`;
    const wooKey=`ck_live_${stamp}_A7`;
    const wooSecret=`cs_live_${stamp}_B8`;

    const saved=await api(cookie,'PUT','/api/settings',{
      email_smtp_pass:smtp,
      woo_consumer_key:wooKey,
      woo_consumer_secret:wooSecret,
      reason:'Certify authenticated encryption for live integration secrets',
    });
    expect(saved.status,JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.changed_keys).toEqual(expect.arrayContaining(['email_smtp_pass','woo_consumer_key','woo_consumer_secret']));

    const db=createClient({url:'file:pos.db'});
    try{
      const {rows}=await db.execute({sql:"SELECT key,value FROM settings WHERE key IN ('email_smtp_pass','woo_consumer_key','woo_consumer_secret') ORDER BY key",args:[]});
      expect(rows).toHaveLength(3);
      const rawByKey=Object.fromEntries(rows.map(row=>[String(row.key),String(row.value)]));
      for(const [key,value] of Object.entries(rawByKey)){
        expect(isEncryptedSettingValue(value),`${key} is not encrypted at rest`).toBe(true);
        expect(value).not.toContain(smtp);
        expect(value).not.toContain(wooKey);
        expect(value).not.toContain(wooSecret);
      }
      expect(revealSettingValue('email_smtp_pass',rawByKey.email_smtp_pass)).toBe(smtp);
      expect(revealSettingValue('woo_consumer_key',rawByKey.woo_consumer_key)).toBe(wooKey);
      expect(revealSettingValue('woo_consumer_secret',rawByKey.woo_consumer_secret)).toBe(wooSecret);
    }finally{db.close();}

    const managed=await api(cookie,'GET','/api/settings/manage');
    expect(managed.status).toBe(200);
    expect(managed.body.values.email_smtp_pass).toBe('••••••••');
    expect(managed.body.values.woo_consumer_key).toBe('••••••••');
    expect(managed.body.values.woo_consumer_secret).toBe('••••••••');

    const wc=await api(cookie,'GET','/api/woocommerce/config');
    expect(wc.status).toBe(200);
    expect(wc.body.woo_consumer_key).toBe('••••••••');
    expect(wc.body.woo_consumer_secret).toBe('••••••••');
  });
});
