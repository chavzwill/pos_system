'use strict';
const {db}=require('../database');
const {getAvailableQty}=require('./inventory-stock-status');
const {ensureInventoryMovementValuation,removeFromPool,addComposition}=require('./inventory-movement-valuation');
const {ensureInventoryTraceability}=require('./inventory-traceability');

let readyPromise=null;
const TYPES=new Set(['virtual_bundle','assembled_kit','procurement_kit']);
const ALLOCATION_MODES=new Set(['relative_cost','percentage','explicit']);
const r4=v=>{const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(4)):0;};

async function ensureProductComposition(){
  if(readyPromise)return readyPromise;
  readyPromise=(async()=>{
    await ensureInventoryMovementValuation();
    await ensureInventoryTraceability();
    await db.batch([
      {sql:`CREATE TABLE IF NOT EXISTS product_compositions(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_product_id INTEGER NOT NULL REFERENCES products(id),
        composition_type TEXT NOT NULL,
        name TEXT NOT NULL,
        cost_allocation_mode TEXT NOT NULL DEFAULT 'relative_cost',
        active INTEGER NOT NULL DEFAULT 1,
        created_by_employee_id INTEGER REFERENCES employees(id),
        updated_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(parent_product_id,composition_type)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS product_composition_components(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        composition_id INTEGER NOT NULL REFERENCES product_compositions(id),
        component_product_id INTEGER NOT NULL REFERENCES products(id),
        quantity_per_parent REAL NOT NULL,
        allocation_weight REAL,
        explicit_cost_per_parent REAL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(composition_id,component_product_id)
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS product_kit_instances(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kit_number TEXT NOT NULL UNIQUE,
        composition_id INTEGER NOT NULL REFERENCES product_compositions(id),
        parent_product_id INTEGER NOT NULL REFERENCES products(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        status TEXT NOT NULL DEFAULT 'assembled',
        source_operation_id INTEGER,
        created_by_employee_id INTEGER REFERENCES employees(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        disassembled_at DATETIME
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS product_kit_instance_components(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kit_instance_id INTEGER NOT NULL REFERENCES product_kit_instances(id),
        component_product_id INTEGER NOT NULL REFERENCES products(id),
        quantity REAL NOT NULL,
        serial_id INTEGER REFERENCES inventory_serials(id),
        lot_id INTEGER REFERENCES inventory_lots(id),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS product_composition_operations(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_number TEXT NOT NULL UNIQUE,
        composition_id INTEGER NOT NULL REFERENCES product_compositions(id),
        operation_type TEXT NOT NULL,
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        parent_quantity REAL NOT NULL,
        reason TEXT NOT NULL,
        employee_id INTEGER REFERENCES employees(id),
        tracked_value_moved REAL NOT NULL DEFAULT 0,
        cost_gap_quantity REAL NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`},
      {sql:`CREATE TABLE IF NOT EXISTS product_composition_operation_lines(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id INTEGER NOT NULL REFERENCES product_composition_operations(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        role TEXT NOT NULL,
        quantity_change REAL NOT NULL,
        tracked_quantity REAL NOT NULL DEFAULT 0,
        tracked_value REAL NOT NULL DEFAULT 0,
        legacy_quantity REAL NOT NULL DEFAULT 0,
        details TEXT
      )`},
      {sql:'CREATE INDEX IF NOT EXISTS idx_composition_parent ON product_compositions(parent_product_id,active)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_kit_instance_branch ON product_kit_instances(branch_id,status,parent_product_id)'},
      {sql:'CREATE INDEX IF NOT EXISTS idx_composition_operation ON product_composition_operations(composition_id,created_at,id)'}
    ],'write');
  })().catch(e=>{readyPromise=null;throw e;});
  return readyPromise;
}

async function getComposition(executor,id){
  await ensureProductComposition();
  const {rows:[row]}=await executor.execute({sql:`SELECT pc.*,p.name parent_product_name,p.sku parent_sku FROM product_compositions pc JOIN products p ON p.id=pc.parent_product_id WHERE pc.id=?`,args:[id]});
  if(!row)return null;
  const {rows:components}=await executor.execute({sql:`SELECT c.*,p.name component_name,p.sku component_sku,p.cost component_cost,p.price component_price FROM product_composition_components c JOIN products p ON p.id=c.component_product_id WHERE c.composition_id=? AND c.active=1 ORDER BY c.sort_order,c.id`,args:[id]});
  row.components=components;return row;
}

async function calculateAvailability(executor,composition,branchId){
  if(!composition?.components?.length)return {available_kits:0,components:[]};
  let kits=Infinity;const components=[];
  for(const c of composition.components){
    const state=await getAvailableQty(executor,c.component_product_id,branchId);const required=Number(c.quantity_per_parent||0);
    const possible=required>0?Math.floor((state.available+1e-9)/required):0;kits=Math.min(kits,possible);
    components.push({...c,...state,required_per_kit:required,possible_kits:possible});
  }
  return {available_kits:Number.isFinite(kits)?Math.max(0,kits):0,components};
}

function allocationWeights(composition){
  const cs=composition.components;if(!cs.length)throw new Error('Composition requires at least one component');
  if(composition.cost_allocation_mode==='percentage'){
    const weights=cs.map(c=>Number(c.allocation_weight||0));const total=weights.reduce((a,b)=>a+b,0);if(Math.abs(total-100)>0.01)throw new Error('Percentage cost allocation must total 100%');return weights.map(x=>x/100);
  }
  if(composition.cost_allocation_mode==='explicit'){
    const weights=cs.map(c=>Number(c.explicit_cost_per_parent||0));const total=weights.reduce((a,b)=>a+b,0);if(total<=0)throw new Error('Explicit component cost allocation requires positive component values');return weights.map(x=>x/total);
  }
  const weights=cs.map(c=>Math.max(0,Number(c.component_cost||0)*Number(c.quantity_per_parent||0)));const total=weights.reduce((a,b)=>a+b,0);if(total<=0)throw new Error('Relative-cost allocation requires component cost evidence or an explicit allocation method');return weights.map(x=>x/total);
}

async function adjustPhysical(executor,productId,branchId,delta,reference,reason){
  const {rows:[inv]}=await executor.execute({sql:'SELECT stock_qty,min_stock FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,branchId]});
  const before=Number(inv?.stock_qty||0),after=r4(before+Number(delta));if(after<-1e-9)throw new Error(`Inventory transformation would make product ${productId} negative at branch ${branchId}`);
  await executor.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=excluded.stock_qty,updated_at=CURRENT_TIMESTAMP`,args:[productId,branchId,Math.max(0,after),Number(inv?.min_stock||0)]});
  const {rows:[sum]}=await executor.execute({sql:'SELECT COALESCE(SUM(stock_qty),0) qty FROM branch_inventory WHERE product_id=?',args:[productId]});
  await executor.execute({sql:'UPDATE products SET stock_qty=? WHERE id=?',args:[Number(sum?.qty||0),productId]});
  await executor.execute({sql:'INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reason,reference) VALUES(?,?,?,?,?,?)',args:[productId,branchId,delta,'product_composition',reason,reference]});
}

async function transformBreakPack(executor,{composition,branchId,parentQuantity,employeeId,reason}){
  const qty=Number(parentQuantity);if(!Number.isFinite(qty)||qty<=0)throw new Error('Parent quantity must be greater than zero');
  if(!String(reason||'').trim())throw new Error('Break-pack reason is required');
  if(composition.composition_type==='virtual_bundle')throw new Error('Virtual bundles do not create or consume parent inventory');
  const state=await getAvailableQty(executor,composition.parent_product_id,branchId);if(state.available+1e-9<qty)throw new Error(`Only ${state.available} parent units are available to break pack`);
  const opNo=`KBR-${Date.now()}-${Math.floor(Math.random()*10000)}`;
  const op=await executor.execute({sql:`INSERT INTO product_composition_operations(operation_number,composition_id,operation_type,branch_id,parent_quantity,reason,employee_id) VALUES(?,?, 'break_pack',?,?,?,?)`,args:[opNo,composition.id,branchId,qty,String(reason).trim(),employeeId||null]});
  const opId=Number(op.lastInsertRowid),parentComp=await removeFromPool(executor,composition.parent_product_id,branchId,qty,'product_break_pack',opId);
  await adjustPhysical(executor,composition.parent_product_id,branchId,-qty,opNo,reason);
  const weights=allocationWeights(composition);const trackedRatio=qty>0?Number(parentComp.tracked||0)/qty:0;const unknownRatio=qty>0?(Number(parentComp.legacy||0)+Number(parentComp.shortage||0))/qty:0;
  for(let i=0;i<composition.components.length;i++){
    const c=composition.components[i],childQty=r4(qty*Number(c.quantity_per_parent));const value=r4(Number(parentComp.value||0)*weights[i]);
    await adjustPhysical(executor,c.component_product_id,branchId,childQty,opNo,`Break pack from ${composition.parent_product_name}: ${reason}`);
    await addComposition(executor,c.component_product_id,branchId,{tracked:r4(childQty*trackedRatio),value,legacy:r4(childQty*unknownRatio)},'product_break_pack',opId);
    await executor.execute({sql:`INSERT INTO product_composition_operation_lines(operation_id,product_id,role,quantity_change,tracked_quantity,tracked_value,legacy_quantity,details) VALUES(?,?,?,?,?,?,?,?)`,args:[opId,c.component_product_id,'component',childQty,r4(childQty*trackedRatio),value,r4(childQty*unknownRatio),`Created from ${qty} ${composition.parent_product_name}`]});
  }
  await executor.execute({sql:`INSERT INTO product_composition_operation_lines(operation_id,product_id,role,quantity_change,tracked_quantity,tracked_value,legacy_quantity,details) VALUES(?,?,?,?,?,?,?,?)`,args:[opId,composition.parent_product_id,'parent',-qty,-Number(parentComp.tracked||0),-Number(parentComp.value||0),-Number(parentComp.legacy||0),'Parent inventory decomposed into components']});
  await executor.execute({sql:'UPDATE product_composition_operations SET tracked_value_moved=?,cost_gap_quantity=? WHERE id=?',args:[Number(parentComp.value||0),Number(parentComp.shortage||0),opId]});
  return {operation_id:opId,operation_number:opNo};
}

async function transformAssemble(executor,{composition,branchId,parentQuantity,employeeId,reason,serialAssignments=[]}){
  const qty=Number(parentQuantity);if(!Number.isFinite(qty)||qty<=0)throw new Error('Parent quantity must be greater than zero');
  if(composition.composition_type==='virtual_bundle')throw new Error('Virtual bundles are not physically assembled');
  if(!String(reason||'').trim())throw new Error('Assembly reason is required');
  const availability=await calculateAvailability(executor,composition,branchId);if(availability.available_kits+1e-9<qty)throw new Error(`Only ${availability.available_kits} complete kits can be assembled from available components`);
  const opNo=`KAS-${Date.now()}-${Math.floor(Math.random()*10000)}`;
  const op=await executor.execute({sql:`INSERT INTO product_composition_operations(operation_number,composition_id,operation_type,branch_id,parent_quantity,reason,employee_id) VALUES(?,?, 'assemble',?,?,?,?)`,args:[opNo,composition.id,branchId,qty,String(reason).trim(),employeeId||null]});
  const opId=Number(op.lastInsertRowid);let totalValue=0,totalUnknown=0;
  for(const c of composition.components){
    const childQty=r4(qty*Number(c.quantity_per_parent));const comp=await removeFromPool(executor,c.component_product_id,branchId,childQty,'product_assembly',opId);totalValue+=Number(comp.value||0);totalUnknown+=Number(comp.shortage||0)+Number(comp.legacy||0);
    await adjustPhysical(executor,c.component_product_id,branchId,-childQty,opNo,`Assembly into ${composition.parent_product_name}: ${reason}`);
    await executor.execute({sql:`INSERT INTO product_composition_operation_lines(operation_id,product_id,role,quantity_change,tracked_quantity,tracked_value,legacy_quantity,details) VALUES(?,?,?,?,?,?,?,?)`,args:[opId,c.component_product_id,'component',-childQty,-Number(comp.tracked||0),-Number(comp.value||0),-Number(comp.legacy||0),`Consumed into ${qty} ${composition.parent_product_name}`]});
  }
  await adjustPhysical(executor,composition.parent_product_id,branchId,qty,opNo,reason);
  await addComposition(executor,composition.parent_product_id,branchId,{tracked:qty,value:r4(totalValue)},'product_assembly',opId);
  if(totalUnknown>1e-9)await executor.execute({sql:`INSERT OR IGNORE INTO inventory_cost_evidence_gaps(source_type,source_id,product_id,branch_key,gap_type,quantity,details) VALUES(?,?,?,?,?,?,?)`,args:['product_assembly',String(opId),composition.parent_product_id,branchId,'kit_assembly_partial_cost_evidence',qty,'One or more component quantities lacked complete acquisition-cost evidence. Known component value was preserved; the assembled parent requires valuation review for the missing portion.']});
  await executor.execute({sql:`INSERT INTO product_composition_operation_lines(operation_id,product_id,role,quantity_change,tracked_quantity,tracked_value,legacy_quantity,details) VALUES(?,?,?,?,?,?,?,?)`,args:[opId,composition.parent_product_id,'parent',qty,qty,r4(totalValue),0,'Parent kit assembled from component inventory']});
  let kitInstance=null;
  if(Array.isArray(serialAssignments)&&serialAssignments.length){
    if(qty!==1)throw new Error('Exact serialized marriage currently requires assembling one kit instance at a time');
    const kitNumber=`KIT-${String(opId).padStart(8,'0')}`;
    const kr=await executor.execute({sql:`INSERT INTO product_kit_instances(kit_number,composition_id,parent_product_id,branch_id,status,source_operation_id,created_by_employee_id) VALUES(?,?,?,?, 'assembled',?,?,?)`,args:[kitNumber,composition.id,composition.parent_product_id,branchId,opId,employeeId||null]});
    const kitId=Number(kr.lastInsertRowid);
    for(const a of serialAssignments){
      const serialId=Number(a.serial_id),componentProductId=Number(a.component_product_id);const c=composition.components.find(x=>Number(x.component_product_id)===componentProductId);if(!c)throw new Error('Serialized kit assignment references a product that is not a component of this kit');
      const {rows:[serial]}=await executor.execute({sql:`SELECT * FROM inventory_serials WHERE id=? AND product_id=? AND branch_id=? AND status='available'`,args:[serialId,componentProductId,branchId]});if(!serial)throw new Error(`Serial ${serialId} is not available at this branch for kit marriage`);
      await executor.execute({sql:`UPDATE inventory_serials SET status='kit_component',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='available'`,args:[serialId]});
      await executor.execute({sql:`INSERT INTO product_kit_instance_components(kit_instance_id,component_product_id,quantity,serial_id) VALUES(?,?,1,?)`,args:[kitId,componentProductId,serialId]});
      await executor.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,'kit_married',1,'kit_instance',?,?,?)`,args:[componentProductId,branchId,serialId,String(kitId),employeeId||null,`Serial married into ${kitNumber}`]});
    }
    kitInstance={id:kitId,kit_number:kitNumber};
  }
  await executor.execute({sql:'UPDATE product_composition_operations SET tracked_value_moved=?,cost_gap_quantity=? WHERE id=?',args:[r4(totalValue),r4(totalUnknown),opId]});
  return {operation_id:opId,operation_number:opNo,kit_instance:kitInstance};
}

module.exports={TYPES,ALLOCATION_MODES,ensureProductComposition,getComposition,calculateAvailability,transformBreakPack,transformAssemble};
