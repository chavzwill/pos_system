(()=>{'use strict';
const replacements=new Map([
  ['CI Runtime Administrators','Administrator'],
  ['CI Administrator','System Administrator'],
  ['Fast role-aware shell','Operations workspace']
]);
let scheduled=false;
function cleanText(root=document){
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  const nodes=[];let n;
  while((n=walker.nextNode()))nodes.push(n);
  for(const node of nodes){const raw=node.nodeValue;const trimmed=raw&&raw.trim();if(trimmed&&replacements.has(trimmed))node.nodeValue=raw.replace(trimmed,replacements.get(trimmed));}
}
function polish(){scheduled=false;cleanText(document.body);}
function queue(){if(scheduled)return;scheduled=true;requestAnimationFrame(polish);}
const observer=new MutationObserver(queue);
observer.observe(document.documentElement,{subtree:true,childList:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',polish,{once:true});else polish();
})();