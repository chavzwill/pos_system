'use strict';
// Cash and credit are separate components of invoice settlement.
const creditAmountSql=alias=>`COALESCE((SELECT SUM(ca.amount_cents)/100.0 FROM supplier_credit_applications ca JOIN supplier_credit_notes cn ON cn.id=ca.credit_note_id WHERE ca.supplier_invoice_id=${alias}.id AND cn.status='posted'),0)`;
const outstandingSql=(alias='si',paid='COALESCE(a.paid,0)')=>`MAX(0,${alias}.total-${paid}-${creditAmountSql(alias)})`;
async function invoiceBalance(executor,id){
 const {rows:[r]}=await executor.execute({sql:`SELECT si.*,COALESCE((SELECT SUM(amount) FROM supplier_payment_allocations WHERE supplier_invoice_id=si.id),0) paid_amount,${creditAmountSql('si')} credited_amount FROM supplier_invoices si WHERE id=?`,args:[id]});
 if(!r)return null;
 return {...r,balance_cents:Math.max(0,Math.round(Number(r.total)*100)-Math.round(Number(r.paid_amount)*100)-Math.round(Number(r.credited_amount)*100))};
}
async function netSupplierAp(executor,branchId){
 const scoped=branchId!=null&&branchId!=='',where=scoped?' AND branch_id=?':'',args=[];
 if(scoped)args.push(branchId);
 // Legacy payments may have no branch even when their invoice allocations do.
 // Attribute allocated cash by the invoice; attribute only the unapplied
 // remainder by the payment branch. Count each payment dollar once.
 const cash=scoped?`(SELECT COALESCE(SUM(a.amount),0) FROM supplier_payment_allocations a JOIN supplier_invoices i ON i.id=a.supplier_invoice_id WHERE i.branch_id=?)+(SELECT COALESCE(SUM(MAX(0,p.amount-COALESCE((SELECT SUM(a.amount) FROM supplier_payment_allocations a WHERE a.payment_id=p.id),0))),0) FROM supplier_payments p WHERE p.branch_id=?)`:`(SELECT COALESCE(SUM(amount),0) FROM supplier_payments)`;
 if(scoped)args.push(branchId,branchId,branchId,branchId);
 const {rows:[r]}=await executor.execute({sql:`SELECT (SELECT COALESCE(SUM(total),0) FROM supplier_invoices WHERE status!='void'${where})-(${cash})-(SELECT COALESCE(SUM(total_cents),0)/100.0 FROM supplier_credit_notes WHERE status='posted'${where})+(SELECT COALESCE(SUM(r.amount_cents),0)/100.0 FROM supplier_credit_refunds r JOIN supplier_credit_notes c ON c.id=r.credit_note_id WHERE 1=1${scoped?' AND c.branch_id=?':''}) net_ap`,args});
 return Number(Number(r.net_ap).toFixed(2));
}
module.exports={creditAmountSql,outstandingSql,invoiceBalance,netSupplierAp};
