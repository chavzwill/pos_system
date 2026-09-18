'use strict';
const {db}=require('../database');
const {can}=require('./permissions');

const MATCH_RANK=Object.freeze({
  exact_identifier:0,
  identifier_prefix:10,
  reviewed_alias:20,
  exact_name:30,
  name_prefix:40,
  token_match:50,
  fuzzy_match:60
});
const DOMAIN_PERMISSIONS=Object.freeze({
  product:['inventory','warehouse','pos','purchasing','purchase_requests','quotations','work_orders','rentals'],
  supplier:['suppliers','purchasing','purchase_requests','inventory'],
  customer:['customers','pos','transactions','quotations','rentals','work_orders','crm','accounts']
});
class PredictiveLookupError extends Error{
  constructor(message,{status=400,code='PREDICTIVE_LOOKUP_INVALID'}={}){super(message);this.status=status;this.code=code;}
}
const normalize=v=>String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/\s+/g,' ');
const escapeLike=v=>String(v??'').replace(/[\\%_]/g,m=>'\\'+m);
const searchPatterns=q=>{
  const clean=normalize(q);
  const tokens=clean.split(/[^a-z0-9]+/).filter(Boolean).sort((a,b)=>b.length-a.length);
  const seed=(tokens[0]||clean).slice(0,3);
  return{direct:`%${escapeLike(clean)}%`,seed:seed?`%${escapeLike(seed)}%`:`%${escapeLike(clean)}%`};
};
const boundedLimit=v=>Math.min(20,Math.max(1,Number(v)||8));
const rankCandidate=c=>MATCH_RANK[c?.match_kind]??99;
const hasPermission=(employee,domain)=>!!employee&&DOMAIN_PERMISSIONS[domain]?.some(k=>can(employee.permissions,k));
function levenshtein(a,b,max=2){
  a=normalize(a);b=normalize(b);
  if(Math.abs(a.length-b.length)>max)return max+1;
  const prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){
    let row=[i],min=row[0];
    for(let j=1;j<=b.length;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      row[j]=Math.min(row[j-1]+1,prev[j]+1,prev[j-1]+cost);
      min=Math.min(min,row[j]);
    }
    if(min>max)return max+1;
    for(let j=0;j<row.length;j++)prev[j]=row[j];
  }
  return prev[b.length];
}
function classifyMatch(query,{identifiers=[],aliases=[],name='',tokens=[]}={}){
  const q=normalize(query);
  const ids=identifiers.filter(Boolean).map(v=>({raw:String(v),norm:normalize(v)}));
  const exact=ids.find(x=>x.norm===q);if(exact)return{match_kind:'exact_identifier',matched_value:exact.raw};
  const prefix=ids.find(x=>x.norm.startsWith(q));if(prefix)return{match_kind:'identifier_prefix',matched_value:prefix.raw};
  const alias=aliases.filter(Boolean).map(v=>({raw:String(v),norm:normalize(v)})).find(x=>x.norm===q||x.norm.startsWith(q));
  if(alias)return{match_kind:'reviewed_alias',matched_value:alias.raw};
  const n=normalize(name);if(n===q)return{match_kind:'exact_name',matched_value:name};
  if(n.startsWith(q))return{match_kind:'name_prefix',matched_value:name};
  const tokenValues=[...tokens,String(name||'')].flatMap(v=>normalize(v).split(/[^a-z0-9]+/)).filter(Boolean);
  const token=tokenValues.find(v=>v.startsWith(q));if(token)return{match_kind:'token_match',matched_value:token};
  const queryTokens=q.split(/[^a-z0-9]+/).filter(Boolean);
  if(queryTokens.length>1){
    let fuzzy=false;
    const matched=queryTokens.every(part=>{
      if(tokenValues.some(v=>v.startsWith(part)))return true;
      const max=part.length>=7?2:part.length>=4?1:0;
      if(max&&tokenValues.some(v=>levenshtein(part,v,max)<=max)){fuzzy=true;return true;}
      return false;
    });
    if(matched)return{match_kind:fuzzy?'fuzzy_match':'token_match',matched_value:name||tokenValues[0]||''};
  }
  const typoMax=q.length>=7?2:q.length>=4?1:0;
  if(typoMax&&tokenValues.some(v=>levenshtein(q,v,typoMax)<=typoMax))return{match_kind:'fuzzy_match',matched_value:name||tokenValues[0]||''};
  return null;
}
async function ensureSchema(){
  await db.execute({sql:'SELECT 1 FROM lookup_aliases LIMIT 1',args:[]});
  return true;
}
function resolveBranch(employee,requested){
  const own=employee?.default_branch_id==null?null:String(employee.default_branch_id);
  if(requested==null||requested==='')return own;
  const wanted=String(requested);
  if(can(employee?.permissions,'branches')||can(employee?.permissions,'security_manage'))return wanted;
  if(own&&wanted===own)return own;
  throw new PredictiveLookupError('That branch is outside your search access.',{status:403,code:'PREDICTIVE_LOOKUP_BRANCH_FORBIDDEN'});
}
async function approvedAliases(entityType,ids){
  if(!ids.length)return new Map();
  const marks=ids.map(()=>'?').join(',');
  const {rows}=await db.execute({sql:`SELECT entity_id,alias FROM lookup_aliases WHERE entity_type=? AND status='approved' AND entity_id IN (${marks})`,args:[entityType,...ids]});
  const map=new Map();for(const row of rows||[]){const list=map.get(Number(row.entity_id))||[];list.push(row.alias);map.set(Number(row.entity_id),list);}return map;
}
async function productCandidates(q,employee,branchId,max){
  const patterns=searchPatterns(q),direct=patterns.direct,seed=patterns.seed;
  const args=[];let join='',stock='p.stock_qty';
  if(branchId){join=' LEFT JOIN branch_inventory bi ON bi.product_id=p.id AND bi.branch_id=?';args.push(branchId);stock='COALESCE(bi.stock_qty,0)';}
  const sql=`SELECT p.id,p.sku,p.barcode,p.model_number,p.name,p.description,p.price,p.cost,p.tax_rate,p.unit,p.supplier_id,p.category_id,${stock} stock_qty
    FROM products p${join}
    WHERE p.active=1 AND (
      p.sku LIKE ? ESCAPE '\\' OR p.barcode LIKE ? ESCAPE '\\' OR p.model_number LIKE ? ESCAPE '\\'
      OR p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\'
      OR p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\'
      OR EXISTS(SELECT 1 FROM lookup_aliases la WHERE la.entity_type='product' AND la.entity_id=p.id AND la.status='approved' AND (la.alias_normalized LIKE ? ESCAPE '\\' OR la.alias_normalized LIKE ? ESCAPE '\\'))
    ) LIMIT ?`;
  args.push(direct,direct,direct,direct,direct,seed,seed,direct,seed,Math.min(80,max*8));
  const {rows}=await db.execute({sql,args});
  const aliases=await approvedAliases('product',(rows||[]).map(r=>Number(r.id)));
  const canSeeCost=can(employee.permissions,'purchasing')||can(employee.permissions,'inventory');
  return (rows||[]).map(r=>{
    const match=classifyMatch(q,{identifiers:[r.sku,r.barcode,r.model_number],aliases:aliases.get(Number(r.id))||[],name:r.name,tokens:[r.description]});
    if(!match)return null;
    return{entity_type:'product',entity_id:Number(r.id),primary_label:r.name||r.sku,secondary_label:[r.sku,r.model_number].filter(Boolean).join(' · '),...match,availability:{branch_id:branchId||null,on_hand:Number(r.stock_qty||0)},context:{sku:r.sku||null,barcode:r.barcode||null,model_number:r.model_number||null,unit:r.unit||'each',price:Number(r.price||0),tax_rate:Number(r.tax_rate||0),category_id:r.category_id||null,...(canSeeCost?{cost:Number(r.cost||0)}:{})}};
  }).filter(Boolean);
}
async function variationCandidates(q,branchId,max){
  const {direct,seed}=searchPatterns(q);
  const {rows}=await db.execute({sql:`SELECT v.id variation_id,v.product_id,v.name variation_name,v.sku,v.barcode,v.price,v.cost,v.stock_qty,p.name product_name,p.tax_rate,p.unit FROM product_variations v JOIN products p ON p.id=v.product_id WHERE v.active=1 AND p.active=1 AND (v.sku LIKE ? ESCAPE '\\' OR v.barcode LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\') LIMIT ?`,args:[direct,direct,direct,seed,seed,Math.min(40,max*4)]});
  return (rows||[]).map(r=>{
    const match=classifyMatch(q,{identifiers:[r.sku,r.barcode],name:`${r.product_name} ${r.variation_name}`});if(!match)return null;
    return{entity_type:'product_variation',entity_id:Number(r.variation_id),parent_entity_id:Number(r.product_id),primary_label:`${r.product_name} — ${r.variation_name}`,secondary_label:r.sku||r.barcode||'',...match,availability:{branch_id:branchId||null,on_hand:Number(r.stock_qty||0)},context:{product_id:Number(r.product_id),variation_id:Number(r.variation_id),sku:r.sku||null,barcode:r.barcode||null,unit:r.unit||'each',price:Number(r.price||0),tax_rate:Number(r.tax_rate||0)}};
  }).filter(Boolean);
}
async function supplierCandidates(q,max){
  const {direct,seed}=searchPatterns(q);
  const {rows}=await db.execute({sql:`SELECT id,supplier_number,name,contact_name,email,phone FROM suppliers s WHERE active=1 AND (supplier_number LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR contact_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR contact_name LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM lookup_aliases la WHERE la.entity_type='supplier' AND la.entity_id=s.id AND la.status='approved' AND (la.alias_normalized LIKE ? ESCAPE '\\' OR la.alias_normalized LIKE ? ESCAPE '\\'))) LIMIT ?`,args:[direct,direct,direct,direct,direct,seed,seed,direct,seed,Math.min(60,max*6)]});
  const aliases=await approvedAliases('supplier',(rows||[]).map(r=>Number(r.id)));
  return (rows||[]).map(r=>{const match=classifyMatch(q,{identifiers:[r.supplier_number],aliases:aliases.get(Number(r.id))||[],name:r.name,tokens:[r.contact_name]});if(!match)return null;return{entity_type:'supplier',entity_id:Number(r.id),primary_label:r.name||r.supplier_number,secondary_label:r.supplier_number||r.contact_name||'',...match,context:{supplier_number:r.supplier_number||null,contact_name:r.contact_name||null,phone:r.phone||null,email:r.email||null}};}).filter(Boolean);
}
async function customerCandidates(q,max){
  const {direct,seed}=searchPatterns(q);
  const {rows}=await db.execute({sql:`SELECT id,customer_number,first_name,last_name,email,phone FROM customers c WHERE active=1 AND (customer_number LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR (first_name||' '||last_name) LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\' OR (first_name||' '||last_name) LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM lookup_aliases la WHERE la.entity_type='customer' AND la.entity_id=c.id AND la.status='approved' AND (la.alias_normalized LIKE ? ESCAPE '\\' OR la.alias_normalized LIKE ? ESCAPE '\\'))) LIMIT ?`,args:[direct,direct,direct,direct,direct,direct,seed,seed,seed,direct,seed,Math.min(60,max*6)]});
  const aliases=await approvedAliases('customer',(rows||[]).map(r=>Number(r.id)));
  return (rows||[]).map(r=>{const name=`${r.first_name||''} ${r.last_name||''}`.trim();const match=classifyMatch(q,{identifiers:[r.customer_number,r.phone,r.email],aliases:aliases.get(Number(r.id))||[],name});if(!match)return null;return{entity_type:'customer',entity_id:Number(r.id),primary_label:name||r.customer_number,secondary_label:r.customer_number||r.phone||r.email||'',...match,context:{customer_number:r.customer_number||null,first_name:r.first_name||'',last_name:r.last_name||'',phone:r.phone||null,email:r.email||null}};}).filter(Boolean);
}
async function lookup({domain,query,employee,branch_id,limit=8,include_variations=true}={}){
  await ensureSchema();
  const d=normalize(domain),q=normalize(query),max=boundedLimit(limit);
  if(!DOMAIN_PERMISSIONS[d])throw new PredictiveLookupError('That search type is not supported.',{status:400,code:'PREDICTIVE_LOOKUP_DOMAIN_INVALID'});
  if(!hasPermission(employee,d))throw new PredictiveLookupError('You do not have access to that search type.',{status:403,code:'PREDICTIVE_LOOKUP_FORBIDDEN'});
  if(q.length<2)return{query:q,domain:d,results:[],exact_match:null,ambiguous_exact:false};
  const branch=d==='product'?resolveBranch(employee,branch_id):null;
  const includeVariations=include_variations!==false&&String(include_variations)!=='false';let candidates=d==='product'?[...(await productCandidates(q,employee,branch,max)),...(includeVariations?await variationCandidates(q,branch,max):[])]:d==='supplier'?await supplierCandidates(q,max):await customerCandidates(q,max);
  candidates=candidates.sort((a,b)=>rankCandidate(a)-rankCandidate(b)||String(a.primary_label).localeCompare(String(b.primary_label))).slice(0,max);
  const exacts=candidates.filter(x=>x.match_kind==='exact_identifier');
  return{query:q,domain:d,results:candidates,exact_match:exacts.length===1?exacts[0]:null,ambiguous_exact:exacts.length>1};
}
module.exports={MATCH_RANK,DOMAIN_PERMISSIONS,PredictiveLookupError,normalize,rankCandidate,classifyMatch,boundedLimit,ensureSchema,lookup};
