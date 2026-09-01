'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/logistics-route-planning.js'),parent=read('routes/logistics-intelligence.js'),ui=read('public/logistics-route-planning.js'),deferred=read('public/shell-deferred.js');
new vm.Script(route,{filename:'logistics route planning'});new vm.Script(parent,{filename:'logistics parent'});new vm.Script(ui,{filename:'logistics route planning ui'});
const checks=[
 ['route planning mounted inside logistics',parent.includes("router.use(require('./logistics-route-planning'))")],
 ['route guard executes before standalone field assignment',parent.indexOf("router.use(require('./logistics-route-planning'))")<parent.indexOf("router.use(require('./logistics-field-execution'))")],
 ['routes are durable first-class records',route.includes('dispatch_routes')&&route.includes('route_number')&&route.includes('route_date')],
 ['route stops map exact dispatch jobs',route.includes('dispatch_route_stops')&&route.includes('dispatch_job_id INTEGER NOT NULL UNIQUE')],
 ['driver shifts are durable',route.includes('dispatch_driver_shifts')&&route.includes('start_time')&&route.includes('end_time')],
 ['shift creation requires active driver',route.includes('Shift employee must be an active driver')],
 ['route release requires driver vehicle and stops',route.includes('Route requires a driver and vehicle before release')&&route.includes('Route requires at least one dispatch stop')],
 ['vehicle weight capacity enforced',route.includes('exceeds vehicle capacity')&&route.includes('total_planned_weight_kg')&&route.includes('capacity_kg')],
 ['vehicle volume capacity enforced',route.includes('total_planned_volume_m3')&&route.includes('capacity_volume_m3')],
 ['driver shift window is checked',route.includes('Planned route falls outside the driver available shift')],
 ['released route conflict checks other routes',route.includes('Driver or vehicle is already committed to')],
 ['route release also checks standalone field execution',route.includes('standalone dispatch')&&route.includes('dispatch_executions')],
 ['standalone assignment cannot steal released route resources',route.includes('Driver or vehicle is reserved by route')],
 ['released routed job cannot be individually assigned',route.includes('assign and execute it through the route plan')],
 ['in transit or closed job cannot be newly routed',route.includes('Closed or already in-transit jobs cannot be newly routed')],
 ['active field execution blocks route replanning',route.includes('Job already has active field execution and cannot be replanned into a route')],
 ['draft routes support explicit stop sequencing',route.includes('/routes/:id/resequence')&&route.includes('stop_sequence')],
 ['route release assigns driver vehicle and scheduled status to jobs',route.includes("status='scheduled'")&&route.includes("'route_released'")],
 ['manifest preserves stop order loads and commercial route labels',route.includes('/routes/:id/manifest')&&route.includes('planned_load')&&route.includes('origin:')&&route.includes('destination:')],
 ['planner does not fabricate road optimization',parent.includes('Distance/ETA values are only exposed when normalized locations, verified coordinates and travel evidence exist')&&parent.includes('Priority and route sequencing use verified deadlines, assignment state, dispatcher order, driver shifts and vehicle capacity')],
 ['command center exposes route identity',parent.includes('route_number')&&parent.includes('route_status')],
 ['route planner UI can create routes',ui.includes('Create route')&&ui.includes("api('/routes'")],
 ['route planner UI adds jobs with load estimates',ui.includes('planned_weight_kg')&&ui.includes('planned_volume_m3')&&ui.includes('/stops')],
 ['route planner UI exposes release and manifest',ui.includes('Release route')&&ui.includes('View manifest')],
 ['route planner is deferred through shell',deferred.includes('/logistics-route-planning.js')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Logistics route planning: ${name}`);if(!ok)failed++;}if(failed){console.error(`Logistics route planning contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Logistics route planning contract OK (${checks.length} checks).`);
