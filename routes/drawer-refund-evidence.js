'use strict';
const express=require('express');
const router=express.Router();
const {db}=require('../database');
const {requireAuth}=require('../lib/permissions');

router.get('/sessions/:id',requireAuth,async(req,res,next)=>{
  try{
    const {rows:[session]}=await db.execute({sql:`SELECT ds.*,d.name drawer_name,b.name branch_name,e.first_name||' '||e.last_name employee_name FROM drawer_sessions ds LEFT JOIN cash_drawers d ON d.id=ds.drawer_id LEFT JOIN branches b ON b.id=ds.branch_id LEFT JOIN employees e ON e.id=ds.employee_id WHERE ds.id=?`,args:[req.params.id]});
    if(!session)return next();
    const {rows:tenders}=await db.execute({sql:`SELECT payment_method,COUNT(DISTINCT transaction_id) tx_count,ROUND(COALESCE(SUM(amount),0),2) total FROM (
      SELECT tp.transaction_id,tp.payment_method,tp.amount FROM transaction_payments tp JOIN transactions t ON t.id=tp.transaction_id WHERE t.drawer_session_id=? AND t.status!='voided'
      UNION ALL
      SELECT t.id,t.payment_method,t.total FROM transactions t WHERE t.drawer_session_id=? AND t.status!='voided' AND NOT EXISTS(SELECT 1 FROM transaction_payments tp2 WHERE tp2.transaction_id=t.id)
    ) GROUP BY payment_method ORDER BY payment_method`,args:[req.params.id,req.params.id]});
    const {rows:refunds}=await db.execute({sql:`SELECT l.payment_method,COUNT(DISTINCT s.id) refund_count,ROUND(COALESCE(SUM(l.amount),0),2) total FROM retail_refund_settlements s JOIN retail_refund_settlement_legs l ON l.settlement_id=s.id WHERE s.drawer_session_id=? GROUP BY l.payment_method ORDER BY l.payment_method`,args:[req.params.id]}).catch(()=>({rows:[]}));
    const refundBy=new Map(refunds.map(x=>[String(x.payment_method),Number(x.total||0)]));
    const tenderBy=new Map(tenders.map(x=>[String(x.payment_method),Number(x.total||0)]));
    const methods=[...new Set([...tenderBy.keys(),...refundBy.keys()])];
    session.tenders=tenders;
    session.refunds=refunds;
    session.net_tenders=methods.map(method=>({payment_method:method,gross_tender:Number((tenderBy.get(method)||0).toFixed(2)),refunds:Number((refundBy.get(method)||0).toFixed(2)),net_movement:Number(((tenderBy.get(method)||0)-(refundBy.get(method)||0)).toFixed(2))}));
    session.cash_refunds=Number((refundBy.get('cash')||0).toFixed(2));
    session.cash_net_movement=Number(((tenderBy.get('cash')||0)-(refundBy.get('cash')||0)).toFixed(2));
    const {rows:[reconciliation]}=await db.execute({sql:`SELECT dr.*,e.first_name||' '||e.last_name reconciled_by_name FROM drawer_reconciliations dr LEFT JOIN employees e ON e.id=dr.reconciled_by WHERE dr.session_id=?`,args:[req.params.id]});
    session.reconciliation=reconciliation||null;
    if(session.reconciliation){const {rows:notes}=await db.execute({sql:`SELECT rnc.denomination_id,rnc.quantity,cd.value,cd.label,cd.currency,cd.sort_order FROM reconciliation_note_counts rnc JOIN currency_denominations cd ON cd.id=rnc.denomination_id WHERE rnc.reconciliation_id=? ORDER BY cd.sort_order,cd.value DESC`,args:[session.reconciliation.id]});session.reconciliation.note_counts=notes;}
    res.json(session);
  }catch(e){res.status(500).json({error:e.message});}
});
module.exports=router;
