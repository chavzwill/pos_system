'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const lib=read('lib/unit-of-measure.js'),route=read('routes/unit-of-measure.js'),retail=read('routes/retail-uom-guard.js'),checkout=read('routes/retail-checkout-hardening.js'),transactions=read('routes/transactions.js'),quoteGuard=read('routes/quotation-uom-guard.js'),quoteFlow=read('routes/quotation-workflow-hardening.js'),sales=read('public/sales-workspace.js'),quotes=read('public/quotations-workspace.js');
const checks=[
 ['explicit package sell price is persisted',lib.includes('sell_price REAL')&&route.includes('sell_price=excluded.sell_price')],
 ['derived and explicit sell economics share one authoritative resolver',lib.includes('function resolveSellEconomics')&&lib.includes("pricing_mode:explicit==null?'derived':'explicit'")],
 ['commerce UOM response exposes effective package price',route.includes('effective_sell_price')&&route.includes('base_equivalent_sell_price')],
 ['POS UOM guard recomputes package economics server-side',retail.includes('resolveSellEconomics(product.price,resolved)')&&retail.includes('line.uom_base_unit_price=economics.base_unit_price')],
 ['POS UOM guard does not trust client product price',retail.includes("SELECT id,name,sku,price,tax_rate FROM products")&&retail.includes('line.unit_price=economics.base_unit_price')],
 ['checkout hardening validates using authoritative UOM base price',checkout.includes('line.uom_base_unit_price != null ? Number(line.uom_base_unit_price)')],
 ['completed transaction engine posts authoritative UOM base price',transactions.includes('item.uom_base_unit_price != null ? Number(item.uom_base_unit_price)')],
 ['quotation UOM guard runs before quotation workflow controls',quoteFlow.indexOf("router.use(require('./quotation-uom-guard'))")<quoteFlow.indexOf("router.use(requirePermission('quotations'))")],
 ['quotation quantities normalize to base inventory quantity',quoteGuard.includes('line.quantity=baseQuantity')],
 ['quotation prices normalize to base-equivalent economics',quoteGuard.includes('line.unit_price=economics.base_unit_price')],
 ['quotation source splits normalize with the same UOM factor',quoteGuard.includes('Number(src.quantity||0)*factor')],
 ['quotation UOM history snapshots entered and base economics',quoteGuard.includes("sourceType:'quotation'")&&quoteGuard.includes('enteredUnitPrice:e.enteredUnitPrice')],
 ['POS workspace exposes selectable selling units',sales.includes('data-uom=')&&sales.includes('effective_sell_price')],
 ['POS payload sends entered selling UOM',sales.includes('uom_code:i.uom_code')],
 ['POS totals use entered-unit price rather than base price',sales.includes('i.entered_unit_price??i.unit_price??0')],
 ['POS receipts recover transaction UOM evidence',sales.includes('source_type=transaction')&&sales.includes('entered_quantity')],
 ['quotation workspace recovers and displays UOM evidence',quotes.includes('source_type=quotation')&&quotes.includes('entered_unit_price')]
];
let failed=0;for(const[n,ok]of checks){console.log(`${ok?'PASS':'FAIL'} UOM commercial: ${n}`);if(!ok)failed++;}if(failed){console.error(`UOM commercial contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`UOM commercial contract OK (${checks.length} checks).`);
