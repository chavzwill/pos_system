'use strict';

function normalizeSupplierInvoiceNumber(value){
  return String(value||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
}

function isNormalizedSupplierInvoiceConflict(error){
  const message=String(error?.message||error||'');
  return message.includes('ux_supplier_invoices_supplier_normalized_active')||
    message.includes('supplier_invoices.supplier_id, supplier_invoices.normalized_invoice_number');
}

module.exports={normalizeSupplierInvoiceNumber,isNormalizedSupplierInvoiceConflict};
