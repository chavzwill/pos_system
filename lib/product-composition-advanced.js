'use strict';
const {getAvailableQty}=require('./inventory-stock-status');
const {removeFromPool,addComposition}=require('./inventory-movement-valuation');
const {getTrackingProfile}=require('./inventory-traceability');

const r4=v=>{const n=Number(v);return Number.isFinite(n)?Number(n.toFixed(4)):0;};

function allocationWeights(composition){
  const cs=composition?.components||[];if(!cs.length)throw new Error('Composition requires at least one component');
  if(composition.cost_allocation_mode==='percentage'){
    const weights=cs.map(c=>Number(c.allocation_weight||0)),total=weights.reduce((a,b)=>a+b,0);
    if(Math.abs(total-100)>0.01)throw new Error('Percentage cost allocation must total 100%');return weights.map(x=>x/100);
  }
  if(composition.cost_allocation_mode==='explicit'){
    const weights=cs.map(c=>Number(c.explicit_cost_per_parent||0)),total=weights.reduce((a,b)=>a+b,0);
    if(total<=0)throw new Error('Explicit component cost allocation requires positive component values');return weights.map(x=>x/total);
  }
  const weights=cs.map(c=>Math.max(0,Number(c.component_cost||0)*Number(c.quantity_per_parent||0))),total=weights.reduce((a,b)=>a+b,0);
  if(total<=0)throw new Error('Relative-cost allocation requires component cost evidence or an explicit allocation method');return weights.map(x=>x/total);
}

async function adjustPhysical(executor,productId,branchId,delta,reference,reason){
  const {rows:[inv]}=await executor.execute({sql:'SELECT stock_qty,min_stock FROM branch_inventory WHERE product_id=? AND branch_id=?',args:[productId,branchId]});
  const before=Number(inv?.stock_qty||0),after=r4(before+Number(delta));if(after<-1e-9)throw new Error(`Inventory transformation would make product ${productId} negative at branch ${branchId}`);
  await executor.execute({sql:`INSERT INTO branch_inventory(product_id,branch_id,stock_qty,min_stock,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(product_id,branch_id) DO UPDATE SET stock_qty=excluded.stock_qty,updated_at=CURRENT_TIMESTAMP`,args:[productId,branchId,Math.max(0,after),Number(inv?.min_stock||0)]});
  const {rows:[sum]}=await executor.execute({sql:'SELECT COALESCE(SUM(stock_qty),0) qty FROM branch_inventory WHERE product_id=?',args:[productId]});
  await executor.execute({sql:'UPDATE products SET stock_qty=? WHERE id=?',args:[Number(sum?.qty||0),productId]});
  await executor.execute({sql:'INSERT INTO stock_movements(product_id,branch_id,quantity_change,type,reason,reference) VALUES(?,?,?,?,?,?)',args:[productId,branchId,delta,'product_composition',reason,reference]});
}

async function validateSerializedMarriage(executor,composition,parentQuantity,serialAssignments=[]){
  const qty=Number(parentQuantity);const assignments=Array.isArray(serialAssignments)?serialAssignments:[];
  const requirements=[];
  for(const c of composition.components||[]){
    const profile=await getTrackingProfile(executor,Number(c.component_product_id));
    if(profile.tracking_mode!=='serial')continue;
    if(qty!==1)throw new Error('A kit containing serialized components must be assembled one physical kit at a time');
    const required=Number(c.quantity_per_parent||0);
    if(!Number.isInteger(required)||required<=0)throw new Error(`Serialized component ${c.component_name||c.component_product_id} requires a whole-number kit quantity`);
    const supplied=assignments.filter(a=>Number(a.component_product_id)===Number(c.component_product_id));
    if(supplied.length!==required)throw new Error(`${c.component_name||'Serialized component'} requires exactly ${required} serial assignment${required===1?'':'s'} for this kit`);
    if(new Set(supplied.map(a=>String(a.serial_id))).size!==supplied.length)throw new Error(`Duplicate serial assignment supplied for ${c.component_name||c.component_product_id}`);
    requirements.push({component_product_id:Number(c.component_product_id),required});
  }
  if(assignments.length){
    const permitted=new Set((composition.components||[]).map(c=>Number(c.component_product_id)));
    for(const a of assignments)if(!permitted.has(Number(a.component_product_id)))throw new Error('Serial assignment references a product that is not a component of this kit');
    if(new Set(assignments.map(a=>String(a.serial_id))).size!==assignments.length)throw new Error('The same serial cannot be married into a kit more than once');
  }
  return requirements;
}

async function buildVirtualSalePlan(executor,composition,branchId,parentQuantity=1){
  const qty=Number(parentQuantity);if(composition.composition_type!=='virtual_bundle')throw new Error('Sale plans are only generated for virtual bundles');
  if(!Number.isFinite(qty)||qty<=0)throw new Error('Bundle sale quantity must be greater than zero');
  const reservationLines=[];let availableBundles=Infinity;const componentState=[];
  for(const c of composition.components||[]){
    const required=r4(Number(c.quantity_per_parent||0)*qty);if(required<=0)throw new Error('Virtual bundle component quantity must be greater than zero');
    const state=await getAvailableQty(executor,Number(c.component_product_id),Number(branchId));
    const perBundle=Number(c.quantity_per_parent||0);const possible=perBundle>0?Math.floor((state.available+1e-9)/perBundle):0;
    availableBundles=Math.min(availableBundles,possible);
    reservationLines.push({product_id:Number(c.component_product_id),quantity:required,bundle_component:true,composition_id:Number(composition.id),parent_product_id:Number(composition.parent_product_id)});
    componentState.push({product_id:Number(c.component_product_id),sku:c.component_sku,name:c.component_name,required_quantity:required,required_per_bundle:perBundle,available:state.available,restricted:state.restricted,reserved:state.reserved||0,possible_bundles:possible});
  }
  if(!Number.isFinite(availableBundles))availableBundles=0;
  if(availableBundles+1e-9<qty)throw Object.assign(new Error(`Only ${availableBundles} complete ${composition.name} bundle${availableBundles===1?' is':'s are'} currently available`),{status:409});
  return {composition_id:Number(composition.id),parent_product_id:Number(composition.parent_product_id),bundle_name:composition.name,bundle_quantity:qty,available_bundles:availableBundles,reservation_lines:reservationLines,components:componentState};
}

async function transformDisassembleInstance(executor,{composition,kitInstanceId,employeeId,reason}){
  if(!String(reason||'').trim())throw new Error('Kit disassembly reason is required');
  const {rows:[kit]}=await executor.execute({sql:`SELECT * FROM product_kit_instances WHERE id=?`,args:[Number(kitInstanceId)]});
  if(!kit)throw Object.assign(new Error('Kit instance not found'),{status:404});
  if(String(kit.status)!=='assembled')throw Object.assign(new Error(`Kit ${kit.kit_number} is not assembled and cannot be disassembled again`),{status:409});
  if(Number(kit.composition_id)!==Number(composition.id))throw new Error('Kit instance does not belong to the selected composition');
  const state=await getAvailableQty(executor,Number(composition.parent_product_id),Number(kit.branch_id));
  if(state.available<1)throw Object.assign(new Error(`The parent kit ${kit.kit_number} is not available at its branch for disassembly`),{status:409});
  const {rows:instanceComponents}=await executor.execute({sql:`SELECT kc.*,s.status serial_status,s.serial_number FROM product_kit_instance_components kc LEFT JOIN inventory_serials s ON s.id=kc.serial_id WHERE kc.kit_instance_id=? ORDER BY kc.id`,args:[kit.id]});
  for(const ic of instanceComponents){if(ic.serial_id&&ic.serial_status!=='kit_component')throw Object.assign(new Error(`Serial ${ic.serial_number||ic.serial_id} is no longer in kit_component status; reconcile identity before disassembly`),{status:409});}

  const opNo=`KDS-${Date.now()}-${Math.floor(Math.random()*10000)}`;
  const op=await executor.execute({sql:`INSERT INTO product_composition_operations(operation_number,composition_id,operation_type,branch_id,parent_quantity,reason,employee_id) VALUES(?,?,'disassemble',?,1,?,?)`,args:[opNo,composition.id,kit.branch_id,String(reason).trim(),employeeId||null]});
  const opId=Number(op.lastInsertRowid);const parentComp=await removeFromPool(executor,composition.parent_product_id,kit.branch_id,1,'kit_disassembly',opId);
  await adjustPhysical(executor,composition.parent_product_id,kit.branch_id,-1,opNo,reason);
  const weights=allocationWeights(composition);const knownValue=Number(parentComp.value||0);let knownAllocated=0;
  for(let i=0;i<composition.components.length;i++){
    const c=composition.components[i],childQty=r4(Number(c.quantity_per_parent||0));let value=i===composition.components.length-1?r4(knownValue-knownAllocated):r4(knownValue*weights[i]);knownAllocated=r4(knownAllocated+value);
    const totalParentPhysical=Number(parentComp.tracked||0)+Number(parentComp.legacy||0)+Number(parentComp.shortage||0);const trackedRatio=totalParentPhysical>0?Number(parentComp.tracked||0)/totalParentPhysical:0;const unknownRatio=totalParentPhysical>0?(Number(parentComp.legacy||0)+Number(parentComp.shortage||0))/totalParentPhysical:1;
    await adjustPhysical(executor,c.component_product_id,kit.branch_id,childQty,opNo,`Disassembled ${kit.kit_number}: ${reason}`);
    await addComposition(executor,c.component_product_id,kit.branch_id,{tracked:r4(childQty*trackedRatio),value,legacy:r4(childQty*unknownRatio)},'kit_disassembly',opId);
    await executor.execute({sql:`INSERT INTO product_composition_operation_lines(operation_id,product_id,role,quantity_change,tracked_quantity,tracked_value,legacy_quantity,details) VALUES(?,?,?,?,?,?,?,?)`,args:[opId,c.component_product_id,'component',childQty,r4(childQty*trackedRatio),value,r4(childQty*unknownRatio),`Restored from ${kit.kit_number}`]});
  }
  await executor.execute({sql:`INSERT INTO product_composition_operation_lines(operation_id,product_id,role,quantity_change,tracked_quantity,tracked_value,legacy_quantity,details) VALUES(?,?,?,?,?,?,?,?)`,args:[opId,composition.parent_product_id,'parent',-1,-Number(parentComp.tracked||0),-knownValue,-Number(parentComp.legacy||0),`Disassembled kit instance ${kit.kit_number}`]});
  for(const ic of instanceComponents){
    if(!ic.serial_id)continue;
    const result=await executor.execute({sql:`UPDATE inventory_serials SET status='available',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='kit_component'`,args:[ic.serial_id]});
    if(Number(result.rowsAffected||0)!==1)throw new Error(`Serial ${ic.serial_number||ic.serial_id} changed during disassembly; operation aborted`);
    await executor.execute({sql:`INSERT INTO inventory_identity_events(product_id,branch_id,serial_id,event_type,quantity,reference_type,reference_id,employee_id,details) VALUES(?,?,?,'kit_unmarried',1,'kit_instance',?,?,?)`,args:[ic.component_product_id,kit.branch_id,ic.serial_id,String(kit.id),employeeId||null,`Serial released from ${kit.kit_number}`]});
  }
  const changed=await executor.execute({sql:`UPDATE product_kit_instances SET status='disassembled',disassembled_at=CURRENT_TIMESTAMP WHERE id=? AND status='assembled'`,args:[kit.id]});
  if(Number(changed.rowsAffected||0)!==1)throw Object.assign(new Error('Kit instance changed concurrently; reload and retry'),{status:409});
  await executor.execute({sql:'UPDATE product_composition_operations SET tracked_value_moved=?,cost_gap_quantity=? WHERE id=?',args:[knownValue,Number(parentComp.shortage||0),opId]});
  return {operation_id:opId,operation_number:opNo,kit_instance_id:Number(kit.id),kit_number:kit.kit_number,status:'disassembled',released_serials:instanceComponents.filter(x=>x.serial_id).map(x=>({serial_id:Number(x.serial_id),serial_number:x.serial_number,component_product_id:Number(x.component_product_id)}))};
}

module.exports={validateSerializedMarriage,buildVirtualSalePlan,transformDisassembleInstance};
