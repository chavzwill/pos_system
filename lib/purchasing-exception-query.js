'use strict';
// Aggregate each evidence source separately to avoid multiplying receipt or invoice counts.
function buildQuery(tables,financial){
 const source=(name,columns)=>tables.has(name)?`SELECT ${columns} FROM ${name}`:'SELECT '+columns.split(',').map(x=>'NULL AS '+x.trim()).join(',')+' WHERE 0';
 return `WITH
 orders AS (SELECT p.id po_id,p.po_number,p.status,p.expected_date,s.name supplier_name FROM purchase_orders p LEFT JOIN suppliers s ON s.id=p.supplier_id WHERE p.branch_id=?),
 shortages AS (SELECT po_item_id,SUM(ABS(variance_quantity)) qty FROM (${source('purchase_receipt_exceptions','po_item_id,exception_type,variance_quantity')}) WHERE exception_type='shortage' GROUP BY po_item_id),
 etas AS (${source('purchase_backorder_updates','id,po_item_id,expected_date')}),
 delivery AS (SELECT l.po_id,SUM(CASE WHEN o.status IN ('approved','sent','partial') AND MAX(0,l.quantity_ordered-COALESCE(l.quantity_received,0)-COALESCE(s.qty,0))>0.000001 AND date(COALESCE((SELECT e.expected_date FROM etas e WHERE e.po_item_id=l.id ORDER BY e.id DESC LIMIT 1),o.expected_date))<date(?) THEN 1 ELSE 0 END) overdue_lines FROM purchase_order_items l JOIN orders o ON o.po_id=l.po_id LEFT JOIN shortages s ON s.po_item_id=l.id GROUP BY l.po_id),
 receipts AS (SELECT * FROM (${source('purchase_receipts','id,po_id')}) WHERE po_id IN (SELECT po_id FROM orders)),
 receipt_items AS (SELECT * FROM (${source('purchase_receipt_items','id,receipt_id,quantity_received,unit_cost')}) WHERE receipt_id IN (SELECT id FROM receipts)),
 posted AS (SELECT * FROM (${source('supplier_invoices','id,purchase_order_id,subtotal,status')}) WHERE purchase_order_id IN (SELECT po_id FROM orders)),
 captures AS (SELECT * FROM (${source('captured_supplier_invoices','id,purchase_order_id,subtotal,status')}) WHERE purchase_order_id IN (SELECT po_id FROM orders)),
 posted_links AS (SELECT * FROM (${source('supplier_invoice_receipt_allocations','supplier_invoice_id,purchase_receipt_item_id,quantity_invoiced,invoice_line_cents,invoice_unit_cost_cents')}) WHERE purchase_receipt_item_id IN (SELECT id FROM receipt_items)),
 captured_links AS (SELECT * FROM (${source('captured_supplier_invoice_receipts','captured_invoice_id,purchase_receipt_item_id,quantity_invoiced,invoice_line_cents,invoice_unit_cost_cents')}) WHERE purchase_receipt_item_id IN (SELECT id FROM receipt_items)),
 controls AS (${source('supplier_invoice_match_controls','supplier_invoice_id,match_status')}),
 replacements AS (${source('supplier_return_replacements','replacement_receipt_item_id,quantity')}),
 reserved AS (SELECT purchase_receipt_item_id item_id,SUM(quantity_invoiced) qty FROM (SELECT purchase_receipt_item_id,quantity_invoiced FROM posted_links UNION ALL SELECT l.purchase_receipt_item_id,l.quantity_invoiced FROM captured_links l JOIN captures c ON c.id=l.captured_invoice_id AND c.status='captured' UNION ALL SELECT replacement_receipt_item_id,quantity FROM replacements) GROUP BY purchase_receipt_item_id),
 unbilled AS (SELECT r.po_id,SUM(CASE WHEN i.quantity_received-COALESCE(a.qty,0)>0.000001 THEN 1 ELSE 0 END) unbilled_lines FROM receipts r JOIN orders o ON o.po_id=r.po_id JOIN receipt_items i ON i.receipt_id=r.id LEFT JOIN reserved a ON a.item_id=i.id GROUP BY r.po_id),
 link_totals AS (SELECT 'posted' kind,l.supplier_invoice_id invoice_id,SUM(l.invoice_line_cents) allocated_cents,SUM(CASE WHEN l.invoice_unit_cost_cents!=ROUND(i.unit_cost*100) THEN 1 ELSE 0 END) cost_differences FROM posted_links l JOIN receipt_items i ON i.id=l.purchase_receipt_item_id GROUP BY l.supplier_invoice_id UNION ALL SELECT 'captured',l.captured_invoice_id,SUM(l.invoice_line_cents),SUM(CASE WHEN l.invoice_unit_cost_cents!=ROUND(i.unit_cost*100) THEN 1 ELSE 0 END) FROM captured_links l JOIN receipt_items i ON i.id=l.purchase_receipt_item_id GROUP BY l.captured_invoice_id),
 invoices AS (SELECT 'posted' kind,p.id,p.purchase_order_id po_id,p.subtotal,COALESCE(m.match_status,'unreviewed') match_status FROM posted p JOIN orders o ON o.po_id=p.purchase_order_id LEFT JOIN controls m ON m.supplier_invoice_id=p.id WHERE p.status!='void' UNION ALL SELECT 'captured',c.id,c.purchase_order_id,c.subtotal,'captured' FROM captures c JOIN orders o ON o.po_id=c.purchase_order_id WHERE c.status='captured'),
 invoice_flags AS (SELECT i.po_id,SUM(CASE WHEN ROUND(i.subtotal*100)>COALESCE(l.allocated_cents,0) THEN 1 ELSE 0 END) unmatched_invoices,SUM(CASE WHEN i.match_status NOT IN ('matched','approved_exception') AND (COALESCE(l.cost_differences,0)>0 OR COALESCE(l.allocated_cents,0)>ROUND(i.subtotal*100) OR i.match_status LIKE '%variance%') THEN 1 ELSE 0 END) invoice_variances FROM invoices i LEFT JOIN link_totals l ON l.kind=i.kind AND l.invoice_id=i.id GROUP BY i.po_id),
 metrics AS (SELECT o.*,COALESCE(d.overdue_lines,0) overdue_lines,COALESCE(u.unbilled_lines,0) unbilled_lines,${financial?'COALESCE(f.unmatched_invoices,0)':'0'} unmatched_invoices,${financial?'COALESCE(f.invoice_variances,0)':'0'} invoice_variances FROM orders o LEFT JOIN delivery d ON d.po_id=o.po_id LEFT JOIN unbilled u ON u.po_id=o.po_id LEFT JOIN invoice_flags f ON f.po_id=o.po_id WHERE (?='' OR o.po_number LIKE ? ESCAPE '\\' OR o.supplier_name LIKE ? ESCAPE '\\')),
 attention AS (SELECT * FROM metrics WHERE overdue_lines>0 OR unbilled_lines>0 OR unmatched_invoices>0 OR invoice_variances>0)
 `;
}
module.exports={buildQuery};
