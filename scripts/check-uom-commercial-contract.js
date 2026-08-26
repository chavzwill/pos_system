'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const lib=read('lib/unit-of-measure.js'),route=read('routes/unit-of-measure.js'),retail=read('routes/retail-uom-guard.js'),checkout=read('routes/retail-checkout-hardening.js'),transactions=read('routes/transactions.js'),quoteGuard=read('routes/quotation-uom-guard.js'),quoteFlow=read('routes/quotation-workflow-hardening.js'),returnGuard=read('routes/retail-return-uom-guard.js'),server=read('server.js'),sales=read('public/sales-workspace.js'),quotes=read('public/quotations-workspace.js');
const checks=[
 ['explicit package sell price is persisted',lib.includes('sell_price REAL')&&route.includes('sell_price=excluded.sell_price')],
 ['derived and explicit sell economics share one authoritative resolver',lib.includes('function resolveSellEconomics')&&lib.includes("pricing_mode:explicit==null?'derived':'explicit'")],
 ['commerce UOM response exposes effective package price',route.includes('effective_sell_price')&&route.includes('base_equivalent_sell_price')],
 ['package barcode resolver is role-safe commerce API',route.includes("router.get('/commerce/resolve-barcode'")&&route.includes('commerceAllowed(req)')],
 ['package barcode resolver only resolves active sellable conversions',route.includes('c.active=1 AND c.sell_allowed=1')],
 ['package barcode resolver returns authoritative unit economics',route.includes('base_equivalent_sell_price:economics.base_unit_price')&&route.includes('effective_sell_price:economics.entered_unit_price')],
 ['duplicate package barcode assignment is rejected',route.includes('This packaging barcode is already assigned to another unit conversion')],
 ['POS UOM guard recomputes package economics server-side',retail.includes('resolveSellEconomics(product.price,resolved)')&&retail.includes('line.uom_base_unit_price=economics.base_unit_price')],
 ['POS UOM guard does not trust client product price',retail.includes("SELECT id,name,sku,price,tax_rate FROM products")&&retail.includes('line.unit_price=economics.base_unit_price')],
 ['POS UOM snapshots link to saved transaction lines',retail.includes('sourceLineId:saved?.id||null')],
 ['checkout hardening validates using authoritative UOM base price',checkout.includes('line.uom_base_unit_price != null ? Number(line.uom_base_unit_price)')],
 ['completed transaction engine posts authoritative UOM base price',transactions.includes('item.uom_base_unit_price != null ? Number(item.uom_base_unit_price)')],
 ['quotation UOM guard runs before quotation workflow controls',quoteFlow.indexOf("router.use(require('./quotation-uom-guard'))")<quoteFlow.indexOf("router.use(requirePermission('quotations'))")],
 ['quotation quantities normalize to base inventory quantity',quoteGuard.includes('line.quantity=baseQuantity')],
 ['quotation prices normalize to base-equivalent economics',quoteGuard.includes('line.unit_price=economics.base_unit_price')],
 ['quotation source splits normalize with the same UOM factor',quoteGuard.includes('Number(src.quantity||0)*factor')],
 ['quotation UOM history snapshots entered and base economics',quoteGuard.includes("sourceType:'quotation'")&&quoteGuard.includes('enteredUnitPrice:e.enteredUnitPrice')],
 ['quotation UOM snapshots link deterministically to response lines',quoteGuard.includes('rows[e.inputIndex]')&&quoteGuard.includes('sourceLineId:match?.id||null')],
 ['POS workspace exposes selectable selling units',sales.includes('data-uom=')&&sales.includes('effective_sell_price')],
 ['POS payload sends entered selling UOM',sales.includes('uom_code:i.uom_code')],
 ['POS totals use entered-unit price rather than base price',sales.includes('i.entered_unit_price??i.unit_price??0')],
 ['POS receipts recover transaction UOM evidence',sales.includes('source_type=transaction')&&sales.includes('entered_quantity')],
 ['quotation workspace recovers and displays UOM evidence',quotes.includes('source_type=quotation')&&quotes.includes('entered_unit_price')],
 ['return UOM normalization runs before return identity traceability',server.indexOf("require('./routes/retail-return-uom-guard')")>=0&&server.indexOf("require('./routes/retail-return-uom-guard')")<server.indexOf("require('./routes/retail-return-traceability-guard')")],
 ['legacy return requests remain base-unit compatible',returnGuard.includes("const explicitUom=String(line.uom_code||line.unit||'').trim()")&&returnGuard.includes("saleSnap?.base_uom||null")],
 ['explicit return UOM converts to authoritative base quantity',returnGuard.includes("resolveProductUom(db,txItem.product_id,requestedUom,'movement')")&&returnGuard.includes('line.quantity=baseQuantity')],
 ['return conversion cannot exceed original sold base quantity',returnGuard.includes('baseQuantity-Number(txItem.quantity||0)>1e-9')],
 ['lot-return allocation follows explicit return conversion',returnGuard.includes('Array.isArray(line.lots)&&explicitUom')&&returnGuard.includes('resolved.factor_to_base')],
 ['return UOM history snapshots entered and base evidence',returnGuard.includes("sourceType:'return'")&&returnGuard.includes('enteredUnitPrice:e.enteredUnitPrice')]
];
let failed=0;for(const[n,ok]of checks){console.log(`${ok?'PASS':'FAIL'} UOM commercial: ${n}`);if(!ok)failed++;}if(failed){console.error(`UOM commercial contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`UOM commercial contract OK (${checks.length} checks).`);
