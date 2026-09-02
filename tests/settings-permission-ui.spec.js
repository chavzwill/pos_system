import { test, expect } from '@playwright/test';

test.describe('Legacy UI explicit-only settings authority',()=>{
  test('broad Settings does not imply Integration Settings authority',async({page})=>{
    await page.goto('/app-shell.html');
    await page.evaluate(()=>{
      window.App={
        _permissionTree:[
          {key:'customers',subs:[]},
          {key:'settings',subs:[{key:'settings_company'},{key:'settings_tax'},{key:'settings_integrations'}]},
        ],
        currentUser:{permissions:{settings:true}},
        can(key){
          const permissions=this.currentUser?.permissions||{};
          const mod=this._permissionTree.find(m=>m.key===key);
          if(mod)return !!permissions[key]||mod.subs.some(s=>!!permissions[s.key]);
          const parent=this._permissionTree.find(m=>m.subs.some(s=>s.key===key));
          if(parent){
            if(Object.prototype.hasOwnProperty.call(permissions,key))return !!permissions[key];
            return !!permissions[parent.key];
          }
          return !!permissions[key];
        },
      };
    });
    await page.addScriptTag({url:'/security-permission-extension.js'});
    await page.waitForFunction(()=>window.App?.__ttExplicitOnlyPermissionCanWrapped===true);

    expect(await page.evaluate(()=>window.App.can('settings'))).toBe(true);
    expect(await page.evaluate(()=>window.App.can('settings_company'))).toBe(true);
    expect(await page.evaluate(()=>window.App.can('settings_integrations'))).toBe(false);

    await page.evaluate(()=>{window.App.currentUser.permissions.settings_integrations=true;});
    expect(await page.evaluate(()=>window.App.can('settings_integrations'))).toBe(true);

    await page.evaluate(()=>{
      window.App.currentUser.permissions={customers:true};
    });
    expect(await page.evaluate(()=>window.App.can('customers_sensitive'))).toBe(false);
    await page.evaluate(()=>{window.App.currentUser.permissions.customers_sensitive=true;});
    expect(await page.evaluate(()=>window.App.can('customers_sensitive'))).toBe(true);
  });
});
