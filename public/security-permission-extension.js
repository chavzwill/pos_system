(()=>{'use strict';
function extendPermissionTree(){
  const app=window.App;
  if(!app||!Array.isArray(app._permissionTree))return false;
  const customers=app._permissionTree.find(mod=>mod&&mod.key==='customers');
  if(!customers||!Array.isArray(customers.subs))return false;
  if(!customers.subs.some(sub=>sub&&sub.key==='customers_sensitive')){
    customers.subs.push({key:'customers_sensitive',label:'View / Edit Sensitive Customer Identity Data'});
  }
  if(!app.__ttSensitivePermissionCanWrapped&&typeof app.can==='function'){
    const originalCan=app.can.bind(app);
    app.can=function(key){
      if(key==='customers_sensitive')return this.currentUser?.permissions?.customers_sensitive===true;
      return originalCan(key);
    };
    app.__ttSensitivePermissionCanWrapped=true;
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
