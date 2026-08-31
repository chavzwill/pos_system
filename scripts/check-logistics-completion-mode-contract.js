'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const handoff=read('routes/logistics-repair-handoff.js'),commercial=read('routes/logistics-commercial-handoff.js'),repairUi=read('public/repair-operations.js'),commercialUi=read('public/logistics-commercial-handoff.js'),locationUi=read('public/logistics-location-intelligence.js');
new vm.Script(handoff,{filename:'repair logistics handoff'});new vm.Script(commercial,{filename:'commercial logistics handoff'});new vm.Script(repairUi,{filename:'repair operations UI'});new vm.Script(commercialUi,{filename:'commercial logistics UI'});new vm.Script(locationUi,{filename:'location intelligence UI'});
const checks=[
 ['repair logistics is mounted through commercial dispatch',commercial.includes("router.use(require('./logistics-repair-handoff'))")],
 ['repair handoff uses exact work order and customer equipment',handoff.includes('repair_equipment_links')&&handoff.includes('customer_equipment')&&handoff.includes('equipment_serial')],
 ['repair pickup and return are distinct job types',handoff.includes("'repair_pickup'")&&handoff.includes("'repair_return'")],
 ['cancelled repair cannot dispatch',handoff.includes('Cancelled repairs cannot be forwarded to Dispatch')],
 ['return dispatch requires completed repair stage',handoff.includes('Repair return delivery is only available after repair completion/signoff')],
 ['repair handoff requires real customer and branch addresses',handoff.includes('Repair logistics requires a usable customer address')&&handoff.includes('Repair branch requires a usable address before dispatch')],
 ['duplicate open repair logistics jobs are reused',handoff.includes("status NOT IN ('completed','cancelled')")&&handoff.includes('prior(')],
 ['repair dispatch snapshot preserves work order customer branch and equipment',handoff.includes('snapshot={work_order:')&&handoff.includes('customer:')&&handoff.includes('equipment:')],
 ['repair timeline receives dispatch handoff evidence',handoff.includes('repair_timeline_events')&&handoff.includes("'logistics_handoff'")],
 ['repair UI only exposes pickup on early stages',repairUi.includes("['intake','pending_deposit']")&&repairUi.includes('Send pickup to Dispatch')],
 ['repair UI only exposes return at completion stages',repairUi.includes("['complete','awaiting_pickup']")&&repairUi.includes('Send return delivery')],
 ['print renderer recognizes repair work orders',commercialUi.includes("d.document_kind==='repair_work_order'")&&commercialUi.includes('Customer equipment')],
 ['repair print packet preserves immutable snapshot wording',commercialUi.includes('rental or repair record later changes')],
 ['verified locations expose free OpenStreetMap',locationUi.includes('openstreetmap.org')&&locationUi.includes('Open free map')],
 ['route stops expose free browser directions',locationUi.includes('fossgis_osrm_car')&&locationUi.includes('Open free directions')],
 ['mapping explicitly avoids paid subscription dependency',locationUi.includes('do not require a paid map subscription')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Completion mode logistics: ${name}`);if(!ok)failed++;}if(failed){console.error(`Completion mode logistics contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Completion mode logistics contract OK (${checks.length} checks).`);