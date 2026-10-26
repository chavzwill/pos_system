'use strict';
const router=require('express').Router(),{db}=require('../database'),{can}=require('../lib/permissions'),m=require('../lib/rental-maintenance-board');
const {sql}=m;
router.post('/plans',m.mutate('plan:create',(ex,req)=>m.asset(ex,req,req.body.asset_id),m.schedule));
router.post('/plans/:id/start',m.mutate('plan:start',(ex,req)=>m.plan(ex,req,req.params.id),m.start));
router.post('/plans/:id/cancel',m.mutate('plan:cancel',(ex,req)=>m.plan(ex,req,req.params.id),m.cancel));
router.post('/maintenance/:id/complete',m.mutate('maintenance:complete',(ex,req)=>m.maintenance(ex,req,req.params.id),m.complete));
router.get('/',async(req,res)=>{res.set('Cache-Control','private, no-store');try{
 m.staff(req);let branch=req.query.branch_id==null?(m.cross(req)?null:Number(req.employee.default_branch_id)):Number(req.query.branch_id);if(branch!=null){if(!Number.isSafeInteger(branch)||branch<1)throw m.fail('INVALID_BRANCH','Select a valid assigned branch',req.query.branch_id==null?403:400);m.scope(req,branch);}
 const limit=req.query.limit==null?40:Number(req.query.limit),status=req.query.status||'all',q=String(req.query.q||'').trim(),after=String(req.query.after||'');const cursor=after.match(/^([0-4]):((?:plan|maintenance):[1-9]\d*)$/);
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!['all','open','scheduled','in_progress','completed','cancelled'].includes(status)||q.length>100||after&&!cursor)throw m.fail('INVALID_FILTER','Invalid maintenance board filter or page cursor',400);
 await m.ensureSchema();const lookupArgs=branch==null?[]:[branch],lookupWhere=branch==null?'1=1':'a.branch_id=?';const now=new Date().toISOString(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Jamaica',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),args=branch==null?[]:[branch],where=branch==null?'1=1':'a.branch_id=?';
 if(req.query.asset_id!=null&&req.query.asset_id!==''){const aid=m.id(req.query.asset_id);args.push(aid);}
 const recordWhere=where+(args.length>lookupArgs.length?' AND a.id=?':'');
 const cte=`WITH scoped AS (SELECT a.*,p.name product_name,p.sku,b.name branch_name FROM rental_assets a JOIN products p ON p.id=a.product_id JOIN branches b ON b.id=a.branch_id WHERE ${recordWhere}),
 records AS (
 SELECT 'plan:'||p.id key,p.id plan_id,p.asset_id,a.asset_number,a.product_name,a.sku,a.branch_id,a.branch_name,a.status asset_status,p.service_type,p.reason,p.due_date,p.priority,p.version,p.maintenance_id,
 CASE WHEN p.maintenance_id IS NOT NULL THEN CASE WHEN t.ended_at IS NULL THEN 'in_progress' ELSE 'completed' END ELSE p.status END status,t.started_at,t.ended_at,COALESCE(ROUND(t.direct_cost*100),0) recorded_cost_cents,t.evidence_ref,
 CASE WHEN t.id IS NULL THEN 0 ELSE MAX(0,(julianday(COALESCE(t.ended_at,?))-julianday(t.started_at))*24) END downtime_hours,
 CASE WHEN p.maintenance_id IS NOT NULL AND t.id IS NULL THEN 'Original maintenance source missing' WHEN t.id IS NOT NULL AND t.ended_at IS NULL AND a.status!='maintenance' THEN 'Asset lifecycle is '||a.status WHEN p.maintenance_id IS NULL AND p.status='scheduled' AND a.status!='active' THEN 'Asset lifecycle is '||a.status WHEN p.maintenance_id IS NULL AND p.status='scheduled' AND EXISTS(SELECT 1 FROM rental_asset_allocations r WHERE r.asset_id=a.id AND r.released_at IS NULL) THEN 'Active rental assignment' WHEN p.maintenance_id IS NULL AND p.status='scheduled' AND EXISTS(SELECT 1 FROM rental_asset_maintenance o WHERE o.asset_id=a.id AND o.ended_at IS NULL) THEN 'Other maintenance is open' ELSE NULL END blocked_reason
 FROM rental_maintenance_plans p JOIN scoped a ON a.id=p.asset_id LEFT JOIN rental_asset_maintenance t ON t.id=p.maintenance_id
 UNION ALL
 SELECT 'maintenance:'||t.id,NULL,t.asset_id,a.asset_number,a.product_name,a.sku,a.branch_id,a.branch_name,a.status,t.maintenance_type,t.notes,NULL,'normal',NULL,t.id,CASE WHEN t.ended_at IS NULL THEN 'in_progress' ELSE 'completed' END,t.started_at,t.ended_at,ROUND(t.direct_cost*100),t.evidence_ref,MAX(0,(julianday(COALESCE(t.ended_at,?))-julianday(t.started_at))*24),CASE WHEN t.ended_at IS NULL AND a.status!='maintenance' THEN 'Asset lifecycle is '||a.status ELSE NULL END
 FROM rental_asset_maintenance t JOIN scoped a ON a.id=t.asset_id WHERE NOT EXISTS(SELECT 1 FROM rental_maintenance_plans p WHERE p.maintenance_id=t.id)),
 searched AS (SELECT *,CASE WHEN status='in_progress' THEN 0 WHEN status='scheduled' AND due_date<? THEN 1 WHEN status='scheduled' THEN 2 WHEN status='completed' THEN 3 ELSE 4 END sort_rank FROM records WHERE (?='' OR asset_number LIKE ? ESCAPE '\\' OR product_name LIKE ? ESCAPE '\\' OR service_type LIKE ? ESCAPE '\\'))`;
 const search='%'+q.replace(/[\\%_]/g,x=>'\\'+x)+'%',params=[...args,now,now,today,q,search,search,search];
 const counts=(await db.execute(sql(cte+` SELECT COUNT(*) all_count,COALESCE(SUM(status='scheduled'),0) scheduled,COALESCE(SUM(status='scheduled' AND due_date<?),0) overdue,COALESCE(SUM(status='in_progress'),0) in_progress,COALESCE(SUM(status='completed'),0) completed,COALESCE(SUM(status='cancelled'),0) cancelled FROM searched`,[...params,today]))).rows[0];
 const filter=status==='all'?'1=1':status==='open'?"status IN('scheduled','in_progress')":"status=?",filterArgs=['all','open'].includes(status)?[]:[status];
 const result=(await db.execute(sql(cte+` SELECT * FROM searched WHERE ${filter} AND (sort_rank>? OR (sort_rank=? AND key>?)) ORDER BY sort_rank,key LIMIT ?`,[...params,...filterArgs,cursor?Number(cursor[1]):-1,cursor?Number(cursor[1]):-1,cursor?.[2]||'',limit+1]))).rows;
 const rows=result.slice(0,limit).map(r=>({...r,recorded_cost_cents:m.integer(Number(r.recorded_cost_cents)),downtime_hours:Math.round(Number(r.downtime_hours||0)*10)/10,overdue:r.status==='scheduled'&&r.due_date<today}));
 const assets=(await db.execute(sql(`SELECT a.id,a.asset_number,a.product_name,a.sku,a.branch_id,a.branch_name,a.status FROM (${`SELECT a.*,p.name product_name,p.sku,b.name branch_name FROM rental_assets a JOIN products p ON p.id=a.product_id JOIN branches b ON b.id=a.branch_id WHERE ${lookupWhere}`}) a ORDER BY a.asset_number LIMIT 1000`,lookupArgs))).rows;
 const branches=(await db.execute(sql('SELECT id,name FROM branches WHERE active=1'+(m.cross(req)?'':' AND id=?')+' ORDER BY name',m.cross(req)?[]:[Number(req.employee.default_branch_id)]))).rows;
 res.json({rows,assets,branches,counts:Object.fromEntries(Object.entries(counts).map(([k,v])=>[k==='all_count'?'all':k,Number(v)])),next_cursor:result.length>limit?rows.at(-1).sort_rank+':'+rows.at(-1).key:null,as_of:today,branch_id:branch,permissions:{manage:can(req.employee.permissions,'rentals_manage'),cross_branch:m.cross(req)},methodology:'Scheduling does not take an asset offline. Downtime starts at actual service start. Costs reuse original maintenance evidence; supplier invoices, stock and payments remain separate.'});
 }catch(e){m.sendError(res,e);}});
module.exports=router;
