'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const route=read('routes/logistics-location-intelligence.js'),parent=read('routes/logistics-intelligence.js'),ui=read('public/logistics-location-intelligence.js'),deferred=read('public/shell-deferred.js');
new vm.Script(route,{filename:'logistics location intelligence'});new vm.Script(parent,{filename:'logistics parent'});new vm.Script(ui,{filename:'logistics location intelligence ui'});
const checks=[
 ['location intelligence is mounted inside logistics',parent.includes("router.use(require('./logistics-location-intelligence'))")],
 ['dispatch locations are durable normalized records',route.includes('dispatch_locations')&&route.includes('address_line')&&route.includes('geocode_status')],
 ['coordinates are optional until verified',route.includes("DEFAULT 'unverified'")&&route.includes('last_verified_at')],
 ['coordinate ranges are validated',route.includes('lat>=-90')&&route.includes('lat<=90')&&route.includes('lng>=-180')&&route.includes('lng<=180')],
 ['commercial handoff addresses backfill automatically',route.includes('seedCommercialLocations')&&route.includes("req.path==='/command-center'")],
 ['commercial backfill preserves frozen source snapshot',route.includes('snapshot_json')&&route.includes('source_snapshot')],
 ['supplier and rental pickups reverse party branch direction',route.includes("['supplier_pickup','rental_pickup']")],
 ['job locations bind exact origin and destination',route.includes('dispatch_job_locations')&&route.includes('origin_location_id')&&route.includes('destination_location_id')],
 ['service zones are durable with pricing fields',route.includes('dispatch_service_zones')&&route.includes('base_delivery_fee')&&route.includes('per_km_fee')],
 ['travel evidence is durable and typed',route.includes('dispatch_travel_evidence')&&route.includes("['provider','observed','manual_verified']")],
 ['negative distance or travel time is rejected',route.includes('Distance/travel time must be non-negative')],
 ['route geography exposes exact stop coordinates',route.includes('/routes/:id/geography')&&route.includes('origin_latitude')&&route.includes('destination_longitude')],
 ['ETA requires verified coordinates',route.includes("origin_geocode_status!=='verified'")&&route.includes("destination_geocode_status!=='verified'"))],
 ['ETA requires travel evidence for route legs',route.includes('No ETA or road optimization is claimed')&&route.includes('dispatch_travel_evidence')],
 ['command center exposes location readiness',parent.includes('location_ready')&&parent.includes('location_unverified')],
 ['command center refuses fabricated ETA claims',parent.includes('Distance/ETA values are only exposed')],
 ['operator UI lists verified and unverified locations',ui.includes('Needs coordinates')&&ui.includes('Verified'))],
 ['operator UI can verify coordinates',ui.includes('Verify coordinates')&&ui.includes('/coordinates'))],
 ['operator UI can create service zones',ui.includes('Add service zone')&&ui.includes('/service-zones'))],
 ['operator UI inspects route geography evidence',ui.includes('Route geography')&&ui.includes('/geography'))],
 ['location intelligence UI is deferred through shell',deferred.includes('/logistics-location-intelligence.js')]
];
let failed=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} Logistics location intelligence: ${name}`);if(!ok)failed++;}if(failed){console.error(`Logistics location intelligence contract FAILED (${failed}/${checks.length} failed).`);process.exit(1)}console.log(`Logistics location intelligence contract OK (${checks.length} checks).`);