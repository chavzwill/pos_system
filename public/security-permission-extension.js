(()=>{'use strict';
const EXPLICIT_ONLY=new Set(['customers_sensitive','settings_integrations']);
function extendPermissionTree(){
  const app=window.App;
  if(!app||!Array.isArray(app._permissionTree))return false;
  const customers=app._permissionTree.find(mod=>mod&&mod.key==='customers');
  if(customers&&Array.isArray(customers.subs)&&!customers.subs.some(sub=>sub&&sub.key==='customers_sensitive')){
    customers.subs.push({key:'customers_sensitive',label:'View / Edit Sensitive Customer Identity Data'});
  }
  const settings=app._permissionTree.find(mod=>mod&&mod.key==='settings');
  if(settings&&Array.isArray(settings.subs)&&!settings.subs.some(sub=>sub&&sub.key==='settings_integrations')){
    settings.subs.push({key:'settings_integrations',label:'Manage Integrations & Secrets'});
  }
  if(!app.__ttExplicitOnlyPermissionCanWrapped&&typeof app.can==='function'){
    const originalCan=app.can.bind(app);
    app.can=function(key){
      if(EXPLICIT_ONLY.has(key))return this.currentUser?.permissions?.[key]===true;
      return originalCan(key);
    };
    app.__ttExplicitOnlyPermissionCanWrapped=true;
  }
  return true;
}
function boot(){
  if(extendPermissionTree())return;
  let tries=0;
  const timer=setInterval(()=>{tries+=1;if(extendPermissionTree()||tries>=40)clearInterval(timer);},100);
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
