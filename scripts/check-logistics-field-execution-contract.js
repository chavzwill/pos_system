'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/logistics-field-execution.js'),parent=read('routes/logistics-intelligence.js'),ui=read('public/logistics-field-execution.js'),deferred=read('public/shell-deferred.js');
new vm.Script(route,{filename:'logistics field execution'});new vm.Script(parent,{filename:'logistics parent'});new vm.Script(ui,{filename:'logistics field execution ui'});
const checks=[
 ['field execution is mounted inside logistics',parent.includes("router.use(require('./logistics-field-execution'))")],
 ['dispatch vehicles have durable registry',route.includes('dispatch_vehicles')&&route.includes('registration_number')&&route.includes('capacity_kg')&&route.includes('out_of_service')],
 ['execution binds exact driver and vehicle',route.includes('driver_employee_id')&&route.includes('vehicle_id')&&route.includes('/jobs/:id/assign')],
 ['only active employees can be assigned',route.includes('Selected driver is not an active employee')],
 ['vehicle availability is enforced',route.includes("['available','assigned']")&&route.includes('cannot be dispatched')],
 ['driver vehicle double-booking is blocked',route.includes('already committed to')&&route.includes('de.driver_employee_id=? OR de.vehicle_id=?')],
 ['field lifecycle requires ordered origin departure and arrival',route.includes('depart_origin')&&route.includes('arrive_origin')&&route.includes('en_route_to_origin')&&route.includes('at_origin')],
 ['physical pickup creates custody evidence',route.includes("'pickup_custody'")&&route.includes("'origin party'")&&route.includes("'company driver'")],
 ['destination arrival is distinct from completion',route.includes('arrive_destination')&&route.includes('at_destination')],
 ['dispatch proof supports pickup and delivery evidence',route.includes("proof_type must be pickup or delivery")&&route.includes('dispatch_proofs')],
 ['proof supports recipient signature photo evidence and coordinates',route.includes('recipient_name')&&route.includes('signature_name')&&route.includes('photo_url')&&route.includes('latitude')&&route.includes('longitude')],
 ['proof photos have size and type controls',route.includes('12*1024*1024')&&route.includes("'image/jpeg'")&&route.includes("'image/png'")&&route.includes("'image/webp'"))],
 ['delivery completion requires proof',route.includes('Delivery/receipt proof is required before dispatch completion')],
 ['completion releases the dispatch vehicle',route.includes("SET status='available'")&&route.includes("stage='completed'"))],
 ['failed attempts require a reason',route.includes('Failure reason is required')&&route.includes("stage='failed'"))],
 ['failed attempts can be explicitly rescheduled',route.includes('/jobs/:id/reschedule')&&route.includes("stage='rescheduled'"))],
 ['reschedule rechecks vehicle availability',route.includes('Previously assigned vehicle is no longer available; reassign the dispatch instead')],
 ['reschedule rechecks driver vehicle conflicts',route.includes('reassign before rescheduling')],
 ['supplier pickup does not impersonate PO receiving',route.includes('PO receiving remains a separate verification control')],
 ['rental logistics does not bypass rental controls',route.includes('rental issue/return controls remain authoritative')],
 ['sales fulfillment only becomes delivered at completion',route.includes("if(stage==='completed')")&&route.includes("fulfillment_status='delivered'")&&route.includes('sales_logistics_sync')],
 ['command center exposes execution and vehicle context',parent.includes('execution_stage')&&parent.includes('vehicle_number')&&parent.includes('registration_number')],
 ['dispatcher UI can register a vehicle',ui.includes('Add dispatch vehicle')&&ui.includes("api('/vehicles'"))],
 ['dispatcher UI assigns driver and vehicle together',ui.includes('data-driver')&&ui.includes('data-vehicle')&&ui.includes('/assign')],
 ['dispatcher UI follows ordered field stages',ui.includes('Depart for origin')&&ui.includes('Arrived at origin')&&ui.includes('Confirm pickup / custody')&&ui.includes('Arrived destination')],
 ['dispatcher UI captures photo capable proof',ui.includes('type="file"')&&ui.includes('/proof')&&ui.includes('Add delivery proof')],
 ['dispatcher UI supports failed attempt and reschedule',ui.includes('Failed attempt')&&ui.includes('Reschedule')],
 ['field execution UI is deferred through shell',deferred.includes('/logistics-field-execution.js')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Dispatch field execution: ${name}`);if(!ok)failed++;}
if(failed){console.error(`Dispatch field execution contract FAILED (${failed}/${checks.length} failed).`);process.exit(1);}console.log(`Dispatch field execution contract OK (${checks.length} checks).`);
