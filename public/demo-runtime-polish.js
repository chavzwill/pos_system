(()=>{'use strict';
const replacements=new Map([
  ['CI Runtime Administrators','Administrator'],
  ['CI Administrator','System Administrator'],
  ['Fast role-aware shell','Operations workspace']
]);
function cleanText(root=document){
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  const nodes=[];let n;
  while((n=walker.nextNode()))nodes.push(n);
  for(const node of nodes){const raw=node.nodeValue;const trimmed=raw&&raw.trim();if(trimmed&&replacements.has(trimmed))node.nodeValue=raw.replace(trimmed,replacements.get(trimmed));}
}
function removeGuides(){document.querySelectorAll('#tt-guided-mode,.tt-guide-backdrop,.tt-guide,.shell-guide-native,.shell-guide-top').forEach(el=>el.remove());}
function polish(){removeGuides();cleanText(document.body);}
const observer=new MutationObserver(()=>polish());
observer.observe(document.documentElement,{subtree:true,childList:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',polish,{once:true});else polish();
})();