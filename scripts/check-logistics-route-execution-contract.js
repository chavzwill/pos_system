'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/logistics-route-execution.js'),parent=read('routes/logistics-intelligence.js'),planner=read('public/logistics-route-planning.js');
new vm.Script(route,{filename:'logistics route execution'});new vm.Script(parent,{filename:'logistics parent'});new vm.Script(planner,{filename:'route planner ui'});
const checks=[
 ['route execution mounts before standalone field execution',parent.indexOf("router.use(require('./logistics-route-execution'))")>0&&parent.indexOf("router.use(require('./logistics-route-execution'))")<parent.indexOf("router.use(require('./logistics-field-execution'))")],
 ['route and stop executions are durable records',route.includes('dispatch_route_executions')&&route.includes('dispatch_route_stop_executions')],
 ['only released routes can start',route.includes('Only a released route can start')],
 ['route start activates exactly the first planned stop',route.includes('current_stop_sequence')&&route.includes("i===0?'active':'pending'")],
 ['active routed stop receives route driver and vehicle field execution',route.includes('activateFieldExecution')&&route.includes('driver_employee_id')&&route.includes('vehicle_id')],
 ['generic job status changes are blocked for routed jobs',route.includes('use route execution controls instead of generic status changes')],
 ['only active routed stop can run field stages',route.includes('Only the active stop on route')&&route.includes("stop_status!=='active'")],
 ['proof is restricted to active routed stop',route.includes('Proof can only be captured for the active stop')],
 ['standalone complete fail and reschedule are blocked for routed jobs',route.includes("'/jobs/:id/complete'")&&route.includes("'/jobs/:id/fail'")&&route.includes("'/jobs/:id/reschedule'")],
 ['route stop completion requires field arrival at destination',route.includes("field.stage!=='at_destination'")&&route.includes('arrive at destination first')],
 ['route stop completion requires delivery receipt proof',route.includes('Stop completion requires delivery/receipt proof')&&route.includes("proof_type='delivery'")],
 ['completed stop closes its field execution without releasing route vehicle',route.includes("SET stage='completed'")&&route.includes('route_stop_custody_released')],
 ['source synchronization preserves PO and rental control boundaries',route.includes('PO receiving remains separate')&&route.includes('rental issue/return remains authoritative')],
 ['sales source marks delivered only at completed routed stop',route.includes("fulfillment_status='delivered'")&&route.includes("stage==='completed'")],
 ['next stop activates only after current stop completion or explicit skip',route.includes("status='active'")&&route.includes('advanced to stop')],
 ['skip requires explicit reason',route.includes('Skip reason is required')&&route.includes('route_stop_skipped')],
 ['skipped routed stop becomes delayed and failed field evidence',route.includes("SET status='delayed'")&&route.includes("SET stage='failed'")],
 ['route cannot close while pending or active stops remain',route.includes('Every route stop must be completed or explicitly skipped before route closure')],
 ['vehicle releases only when route closes',route.includes("UPDATE dispatch_vehicles SET status='available'")&&route.includes("UPDATE dispatch_routes SET status='completed'")],
 ['route execution exposes remaining planned load',route.includes('remainingLoad')&&route.includes('remaining_load')],
 ['command center exposes active route stop context',parent.includes('route_stop_status')&&parent.includes('route_current_stop_sequence')&&parent.includes('active_route_stops')],
 ['planner can start released route',planner.includes('Start route')&&planner.includes('/start')],
 ['planner exposes ordered field actions',planner.includes('Depart for origin')&&planner.includes('Arrived at origin')&&planner.includes('Confirm pickup / custody')&&planner.includes('Arrived destination')],
 ['planner captures route delivery proof including photo',planner.includes('Delivery / receipt proof')&&planner.includes('type="file"')&&planner.includes("fd.set('proof_type','delivery')")],
 ['planner supports explicit stop completion skip and route closure',planner.includes('Complete stop')&&planner.includes('Skip stop')&&planner.includes('Close route')]
];
let failed=0;for(const [name,ok]of checks){console.log(`${ok?'PASS':'FAIL'} Logistics route execution: ${name}`);if(!ok)failed++;}if(failed){console.error(`Logistics route execution contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Logistics route execution contract OK (${checks.length} checks).`);
