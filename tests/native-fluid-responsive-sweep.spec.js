import { test, expect } from '@playwright/test';

const user = process.env.POS_TEST_USER || 'admin';
const password = process.env.POS_TEST_PASSWORD || '123456';

const CRITICAL_WORKSPACES = [
  'sales','inventory','purchasing','rentals','repairs','dispatch','crm','administration','accounting','reports'
];

async function login(page){
  await page.goto('/');
  const form=page.locator('#shell-login');
  if(await form.count()){
    await form.locator('input[name="username"]').fill(user);
    await form.locator('input[name="password"]').fill(password);
    await form.locator('button[type="submit"],button').first().click();
  }
  if(await page.locator('#tt-password-change').count()) test.skip(true,'Use a non-forced-password POS_TEST_USER for responsive sweep.');
  await expect(page.locator('.shell-app')).toBeVisible({timeout:12_000});
}

async function measure(page){
  return page.evaluate(()=>{
    const vw=document.documentElement.clientWidth;
    const vh=document.documentElement.clientHeight;
    const overflow=Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-vw;
    const visible=el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
    const clipped=[];
    for(const el of [...document.querySelectorAll('[role="dialog"],dialog[open],[class*="overlay"],[class*="drawer"],[class*="panel"]')].filter(visible).slice(0,120)){
      const r=el.getBoundingClientRect();
      const x=Math.max(0,-r.left)+Math.max(0,r.right-vw);
      const y=Math.max(0,-r.top)+Math.max(0,r.bottom-vh);
      if(x>24||y>Math.max(72,vh*.25))clipped.push({id:el.id||'',className:String(el.className||'').slice(0,120),x:Math.round(x),y:Math.round(y)});
    }
    return {overflow:Math.max(0,overflow),clipped:clipped.slice(0,10)};
  });
}

function viewportHeight(width,mode){
  if(mode==='portrait') return Math.max(568,Math.round(width*1.78));
  if(mode==='landscape') return Math.max(320,Math.round(width*.62));
  return Math.max(600,Math.round(width*.62));
}

test('fluid responsive sweep from 320px through 2560px has no dead zones',async({page})=>{
  test.setTimeout(300_000);
  await page.setViewportSize({width:1280,height:800});
  await login(page);
  const registered=await page.evaluate(()=>Object.keys(window.TotalToolsWorkspaceLoader?.assets||{}));
  const targets=CRITICAL_WORKSPACES.filter(k=>registered.includes(k));
  expect(targets.length).toBeGreaterThanOrEqual(6);

  const failures=[];
  const widths=[];
  for(let width=320;width<=960;width+=40)widths.push({width,mode:'portrait'});
  for(let width=600;width<=1180;width+=40)widths.push({width,mode:'landscape'});
  for(let width=1000;width<=1600;width+=50)widths.push({width,mode:'desktop'});
  for(let width=1680;width<=2560;width+=80)widths.push({width,mode:'desktop'});

  for(const sample of widths){
    const height=viewportHeight(sample.width,sample.mode);
    await page.setViewportSize({width:sample.width,height});
    const shell=await measure(page);
    if(shell.overflow>4||shell.clipped.length)failures.push({viewport:`${sample.width}x${height}`,workspace:'shell',...shell});

    for(const key of targets){
      const opened=await page.evaluate(async k=>{try{await window.TotalToolsShellOpen(k,k);return true;}catch{return false;}},key);
      if(!opened){failures.push({viewport:`${sample.width}x${height}`,workspace:key,kind:'open-failed'});continue;}
      await page.waitForTimeout(35);
      const state=await measure(page);
      if(state.overflow>4||state.clipped.length)failures.push({viewport:`${sample.width}x${height}`,workspace:key,...state});
    }
  }

  expect(failures,JSON.stringify(failures,null,2)).toEqual([]);
});
