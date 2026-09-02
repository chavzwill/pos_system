'use strict';
const bcrypt=require('bcryptjs');
const {db,ensureReady}=require('../database');
const {PERMISSION_TREE}=require('../lib/permissions');

async function main(){
  if(process.env.TURSO_DATABASE_URL) throw new Error('CI runtime bootstrap must use isolated local SQLite, not Turso.');
  await ensureReady();

  let {rows:[branch]}=await db.execute({sql:"SELECT * FROM branches WHERE active=1 ORDER BY id LIMIT 1",args:[]});
  if(!branch){
    const r=await db.execute({sql:"INSERT INTO branches(branch_code,name,address,city,state,active) VALUES(?,?,?,?,?,1)",args:['CI-01','CI Runtime Branch','1 Runtime Test Road','Kingston','Kingston']});
    ({rows:[branch]}=await db.execute({sql:'SELECT * FROM branches WHERE id=?',args:[Number(r.lastInsertRowid)]}));
  }

  const permissions={multi_branch_access:true};
  for(const mod of PERMISSION_TREE){permissions[mod.key]=true;for(const sub of mod.subs)permissions[sub.key]=true;}
  const groupName='CI Runtime Administrators';
  let {rows:[group]}=await db.execute({sql:'SELECT * FROM security_groups WHERE name=?',args:[groupName]});
  if(group){
    await db.execute({sql:'UPDATE security_groups SET description=?,permissions=? WHERE id=?',args:['Ephemeral local CI runtime authority',JSON.stringify(permissions),group.id]});
  }else{
    const r=await db.execute({sql:'INSERT INTO security_groups(name,description,permissions) VALUES(?,?,?)',args:[groupName,'Ephemeral local CI runtime authority',JSON.stringify(permissions)]});
    ({rows:[group]}=await db.execute({sql:'SELECT * FROM security_groups WHERE id=?',args:[Number(r.lastInsertRowid)]}));
  }

  const username=process.env.POS_TEST_USER||'admin';
  const password=process.env.POS_TEST_PASSWORD||'CI-Test-Auth!2026';
  const pin=process.env.POS_TEST_PIN||'864209';
  const [hash,pinHash]=await Promise.all([bcrypt.hash(password,12),bcrypt.hash(pin,12)]);
  let {rows:[employee]}=await db.execute({sql:'SELECT * FROM employees WHERE username=?',args:[username]});
  if(employee){
    await db.execute({sql:`UPDATE employees SET first_name='CI',last_name='Administrator',pin=?,password=?,must_change_password=0,active=1,security_group_id=?,default_branch_id=?,is_driver=1,is_operator=1,is_security=1 WHERE id=?`,args:[pinHash,hash,group.id,branch.id,employee.id]});
  }else{
    const n=Date.now().toString().slice(-8);
    const r=await db.execute({sql:`INSERT INTO employees(employee_number,first_name,last_name,username,pin,password,must_change_password,role,active,security_group_id,default_branch_id,is_driver,is_operator,is_security) VALUES(?,?,?,?,?,?,0,'admin',1,?,?,1,1,1)`,args:[`CI-${n}`,'CI','Administrator',username,pinHash,hash,group.id,branch.id]});
    ({rows:[employee]}=await db.execute({sql:'SELECT * FROM employees WHERE id=?',args:[Number(r.lastInsertRowid)]}));
  }
  await db.execute({sql:'INSERT OR IGNORE INTO employee_branches(employee_id,branch_id,is_default) VALUES(?,?,1)',args:[employee.id,branch.id]});
  await db.execute({sql:'UPDATE employee_branches SET is_default=CASE WHEN branch_id=? THEN 1 ELSE 0 END WHERE employee_id=?',args:[branch.id,employee.id]});

  console.log(JSON.stringify({database:'local SQLite',branch_id:branch.id,test_user:username,security_group_id:group.id},null,2));
}

main().then(()=>process.exit(0)).catch(err=>{console.error(err&&err.stack||err);process.exit(1);});
