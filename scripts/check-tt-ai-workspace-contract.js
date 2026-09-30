'use strict';
const fs=require('fs');
const path=require('path');

const root=path.join(__dirname,'..');
const ui=fs.readFileSync(path.join(root,'public','tt-ai-workspace.js'),'utf8');
const css=fs.readFileSync(path.join(root,'public','tt-ai-workspace.css'),'utf8');
const shell=fs.readFileSync(path.join(root,'public','app-shell.html'),'utf8');

const checks=[
  ['workspace assets are loaded by the staff shell',shell.includes('/tt-ai-workspace.css')&&shell.includes('/tt-ai-workspace.js')],
  ['launcher is injected into authenticated shell topbar',ui.includes("document.querySelector('.shell-topbar')")&&ui.includes("id='tt-ai-launcher'")],
  ['launcher opens TT AI without a separate navigation route',ui.includes("button.addEventListener('click',open)")],
  ['question calls only the read-only TT AI query gateway',ui.includes("api('/api/tt-ai/query',{method:'POST'")],
  ['service capability controls composer availability',ui.includes("capabilities?.query===false")&&ui.includes('setComposer')],
  ['structured answer text is supported',ui.includes("result?.answer&&typeof result.answer==='object'")&&ui.includes('result.answer.text')],
  ['structured evidence data becomes cards',ui.includes('cardsFrom')&&ui.includes('answer.data')],
  ['assistant text is escaped before HTML rendering',ui.includes('esc(answer.text)')],
  ['company evidence is shown separately',ui.includes('evidenceFrom')&&ui.includes('Evidence used')],
  ['UI makes read-only boundary visible',ui.includes('Read only')&&ui.includes('No operational changes can be made')],
  ['no direct operational mutation endpoint is called',!/(\/api\/(?:products|rentals|work-orders|purchase|transactions)[^'"]*['"],?\{method:['"](?:POST|PUT|PATCH|DELETE))/i.test(ui)],
  ['mobile launcher treatment exists',css.includes('.tt-ai-launcher span{display:none}')],
];

const failed=checks.filter(([,ok])=>!ok);
for(const [label,ok] of checks)console.log(`${ok?'PASS':'FAIL'} - ${label}`);
if(failed.length){
  console.error(`TT AI workspace contract failed: ${failed.length} check(s)`);
  process.exit(1);
}
console.log(`TT AI workspace contract passed: ${checks.length}/${checks.length}`);
