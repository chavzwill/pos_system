(()=>{'use strict';
function approvals(){return window.TotalToolsDepartmentApprovals;}
function harden(root=document){
 const panel=root.querySelector?.('#tt-purchasing-workspace');if(!panel)return;
 const direct=[...panel.querySelectorAll('[data-action="approve"],[data-action="reject"]')];
 if(!direct.length)return;
 const row=direct[0].closest('.tt-purch__action-row');
 direct.forEach(button=>button.remove());
 if(!row||row.querySelector('[data-open-department-approvals]'))return;
 const button=document.createElement('button');
 button.type='button';button.dataset.openDepartmentApprovals='true';button.textContent='Review in Department Approvals';
 button.addEventListener('click',async()=>{
  try{await approvals()?.open?.();}
  catch(error){alert(approvals()?.friendlyError?.(error)||'Department Approvals could not open. Try again.');}
 });
 row.appendChild(button);
 const note=document.createElement('span');note.className='tt-purch__approval-note';note.textContent='An authorized department manager must approve or reject this request.';row.appendChild(note);
}
new MutationObserver(()=>queueMicrotask(()=>harden())).observe(document.documentElement,{subtree:true,childList:true});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>harden(),{once:true});else harden();
})();
