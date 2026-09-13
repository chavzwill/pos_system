'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth,can}=require('../lib/permissions');
router.use(requireAuth);
const norm=v=>String(v||'').trim();
const branchId=req=>req.employee?.default_branch_id||null;
const allowed=(req,key)=>can(req.employee?.permissions||{},key);
async function rows(sql,args=[]){try{return (await db.execute({sql,args})).rows||[];}catch{return[];}}
async function productMatches(q){const like=`%${q}%`;return rows(`SELECT id,name,sku,barcode,category_id,price FROM products WHERE active=1 AND (name LIKE ? OR sku LIKE ? OR barcode LIKE ?) ORDER BY CASE WHEN sku=? OR barcode=? THEN 0 ELSE 1 END,name LIMIT 12`,[like,like,like,q,q]);}
async function branchAvailability(productId){return rows(`SELECT b.id branch_id,b.name branch_name,COALESCE(bi.stock_qty,0) on_hand,COALESCE((SELECT SUM(r.quantity) FROM inventory_reservations r WHERE r.product_id=bi.product_id AND r.branch_id=bi.branch_id AND r.status='active' AND r.expires_at>CURRENT_TIMESTAMP),0) reserved,COALESCE((SELECT SUM(s.quantity) FROM inventory_stock_status_balances s WHERE s.product_id=bi.product_id AND s.branch_id=bi.branch_id AND s.status IN ('inspection','blocked','quarantine','damaged','expired')),0) restricted,COALESCE((SELECT GROUP_CONCAT(sb.bin_code||' ('||ROUND(pba.quantity,3)||')',', ') FROM product_bin_assignments pba JOIN storage_bins sb ON sb.id=pba.bin_id WHERE pba.product_id=bi.product_id AND pba.branch_id=bi.branch_id AND COALESCE(pba.quantity,0)>0),'') bin_code FROM branch_inventory bi JOIN branches b ON b.id=bi.branch_id WHERE bi.product_id=? AND b.active=1 ORDER BY b.name`,[productId]);}
async function incoming(productId){return rows(`SELECT po.id,po.po_number,po.branch_id,b.name branch_name,po.expected_date,po.status,poi.quantity_ordered,COALESCE(poi.quantity_received,0) quantity_received,MAX(0,poi.quantity_ordered-COALESCE(poi.quantity_received,0)) incoming_qty FROM purchase_order_items poi JOIN purchase_orders po ON po.id=poi.po_id LEFT JOIN branches b ON b.id=po.branch_id WHERE poi.product_id=? AND po.status NOT IN ('received','cancelled') AND poi.quantity_ordered>COALESCE(poi.quantity_received,0) ORDER BY po.expected_date,po.created_at LIMIT 30`,[productId]);}
async function transfers(productId){return rows(`SELECT t.id,t.transfer_number,t.status,t.from_branch_id,fb.name from_branch_name,t.to_branch_id,tb.name to_branch_name,i.quantity_requested,COALESCE(i.quantity_received,0) quantity_received,MAX(0,i.quantity_requested-COALESCE(i.quantity_received,0)) pending_qty FROM branch_transfer_items i JOIN branch_transfers t ON t.id=i.transfer_id LEFT JOIN branches fb ON fb.id=t.from_branch_id LEFT JOIN branches tb ON tb.id=t.to_branch_id WHERE i.product_id=? AND t.status IN ('pending','in_transit') ORDER BY t.created_at DESC LIMIT 30`,[productId]);}
async function explicitSubstitutes(productId){return rows(`SELECT p.id,p.name,p.sku,p.price,ps.note,'Approved substitute' confidence_label,1 staff_approved FROM product_substitutes ps JOIN products p ON p.id=ps.substitute_product_id WHERE ps.product_id=? AND COALESCE(ps.approved,1)=1 AND p.active=1 ORDER BY p.name LIMIT 10`,[productId]);}
async function structuredAlternatives(product){if(!product?.category_id)return[];const candidates=await rows(`SELECT id,name,sku,price FROM products WHERE active=1 AND category_id=? AND id<>? ORDER BY ABS(COALESCE(price,0)-?) LIMIT 8`,[product.category_id,product.id,Number(product.price||0)]);return candidates.map(p=>({...p,confidence_label:'Possible alternative — verify first',staff_approved:0,note:'Same product category; verify specifications before offering as equivalent.'}));}
router.get('/stock-finder',async(req,res)=>{
 try{
  const q=norm(req.query.q);if(q.length<2)return res.json({query:q,results:[]});
  if(!['inventory','warehouse','pos','purchasing','transfers'].some(k=>allowed(req,k)))return res.status(403).json({error:'Your role does not have stock lookup access'});
  const home=branchId(req),products=await productMatches(q),results=[];
  for(const product of products){
   let availability=await branchAvailability(product.id);
   availability=availability.map(x=>{const on_hand=Number(x.on_hand||0),reserved=Number(x.reserved||0),restricted=Number(x.restricted||0);return{...x,on_hand,reserved,restricted,available:Math.max(0,on_hand-restricted-reserved),is_home_branch:Number(x.branch_id)===Number(home)};});
   if(!allowed(req,'multi_branch_access')&&!allowed(req,'transfers'))availability=availability.filter(x=>x.is_home_branch);
   const purchase_orders=(await incoming(product.id)).map(x=>({...x,incoming_qty:Number(x.incoming_qty||0)}));
   const transferRows=(await transfers(product.id)).filter(x=>allowed(req,'multi_branch_access')||allowed(req,'transfers')||Number(x.to_branch_id)===Number(home)||Number(x.from_branch_id)===Number(home));
   const approved=await explicitSubstitutes(product.id),approvedIds=new Set(approved.map(x=>Number(x.id)));
   const structured=(await structuredAlternatives(product)).filter(x=>!approvedIds.has(Number(x.id)));
   results.push({product,home_branch_id:home,availability,purchase_orders,transfers:transferRows,alternatives:[...approved,...structured].slice(0,10)});
  }
  res.json({query:q,generated_at:new Date().toISOString(),results});
 }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
