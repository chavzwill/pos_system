const express=require('express');
const router=express.Router();
const {requireAuth}=require('../lib/permissions');
router.use(requireAuth);
const DOMAIN_RULES={
  sales:['pos','transactions','drawers','quotations'],
  service:['work_orders','services'],
  rentals:['rentals'],
  dispatch:['transfers'],
  inventory:['inventory','warehouse','cycle-counts','transfers'],
  purchasing:['purchase_requests','purchasing','suppliers'],
  crm:['customers','crm'],
  finance:['accounts','reports_financial','commissions'],
  people:['employees'],
  administration:['branches','security','settings'],
  marketing:['promotions','discount-cards','cash-back-cards']
};
function can(perms,key){if(!perms)return false;if(perms[key])return true;const prefix=key.replace(/[-]/g,'_')+'_';return Object.entries(perms).some(([k,v])=>v&&(k===key||k.startsWith(prefix)));}
function domainsFor(perms){return Object.entries(DOMAIN_RULES).filter(([,keys])=>keys.some(k=>can(perms,k))).map(([d])=>d);}
function inferPrimary(emp,domains){
  const n=String(emp.security_group_name||'').toLowerCase();
  const named=[
    ['dispatch','dispatch'],['dispatcher','dispatch'],['logistics','dispatch'],['delivery','dispatch'],['driver','dispatch'],['fleet','dispatch'],['routing','dispatch'],
    ['technician','service'],['service','service'],['repair','service'],
    ['cashier','sales'],['sales','sales'],['rental','rentals'],
    ['inventory','inventory'],['warehouse','inventory'],['purchas','purchasing'],
    ['finance','finance'],['account','finance'],['admin','administration'],['manager','administration']
  ];
  for(const [needle,d] of named)if(n.includes(needle)&&domains.includes(d))return d;
  return domains[0]||'dashboard';
}
router.get('/me',(req,res)=>{
  const emp=req.employee;
  const domains=domainsFor(emp.permissions||{});
  res.json({
    employee:{id:emp.id,name:[emp.first_name,emp.last_name].filter(Boolean).join(' '),security_group_name:emp.security_group_name,default_branch_id:emp.default_branch_id,default_branch_name:emp.default_branch_name},
    primary_workspace:inferPrimary(emp,domains),
    domains,
    permissions:emp.permissions||{},
    principle:'Navigation and Guided Mode are derived from the signed-in employee permissions. Employee type never grants access beyond RBAC.'
  });
});
module.exports=router;
