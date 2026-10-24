const {test,expect}=require('@playwright/test');
const path=require('node:path');
const jobs=[
 {id:1,job_number:'DSP-001',status:'unassigned',priority:'urgent',origin_label:'Kingston branch',destination_label:'Ocho Rios customer',job_type:'delivery',promised_at:'2020-01-01T12:00:00Z'},
 {id:2,job_number:'DSP-002',status:'scheduled',priority:'normal',origin_label:'Warehouse',destination_label:'St Ann branch',job_type:'transfer',scheduled_for:'2030-01-01T12:00:00Z'},
 {id:3,job_number:'DSP-003',status:'scheduled',execution_stage:'assigned',assignee_employee_id:7,assignee_name:'Test Driver',priority:'normal',origin_label:'Kingston',destination_label:'Port Maria',job_type:'delivery'},
 {id:4,job_number:'DSP-004',status:'in_transit',execution_stage:'in_transit',assignee_employee_id:7,assignee_name:'Test Driver',priority:'high',origin_label:'Ocho Rios',destination_label:'Kingston',job_type:'delivery'},
 {id:5,job_number:'DSP-005',status:'delayed',execution_stage:'failed',priority:'high',origin_label:'Warehouse',destination_label:'Customer <script>',job_type:'delivery'}
];
for(const width of [1440,768,390])test('dispatch lanes, controls and search at '+width,async({page})=>{
 await page.setViewportSize({width,height:1000});
 await page.route('http://dispatch.test/**',route=>{
  const url=route.request().url();
  if(url.endsWith('/me'))return route.fulfill({json:{permissions:{dispatch_view:true,dispatch_plan:true}}});
  if(url.includes('/command-center'))return route.fulfill({json:{summary:{open_jobs:5},jobs,uncovered_transfers:[]}});
  return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body></body></html>'});
 });
 await page.goto('http://dispatch.test/');
 await page.addStyleTag({path:path.resolve('public/ui-tokens.css')});
 await page.addStyleTag({path:path.resolve('public/ui-workspaces.css')});
 await page.addScriptTag({path:path.resolve('public/logistics-intelligence.js')});
 await page.evaluate(()=>window.TotalToolsLogisticsIntelligence.open());
 for(const lane of ['unassigned','scheduled','assigned','transit','exceptions'])await expect(page.locator(`[data-lane="${lane}"] .tt-li-job`)).toHaveCount(1);
 await expect(page.locator('[data-job="1"]')).toContainText('Overdue');
 await expect(page.locator('.tt-dispatch-team')).toContainText('2 open jobs');
 await expect(page.locator('[data-job="5"] script')).toHaveCount(0);
 const control=page.locator('[data-job="1"] .tt-dispatch-open');await control.click();await expect(control).toHaveAttribute('aria-expanded','true');
 const box=await page.locator('[data-job="1"]').boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
 await control.click();await expect(control).toHaveAttribute('aria-expanded','false');
 await page.locator('#tt-li-search').fill('Port Maria');await expect(page.locator('.tt-li-job')).toHaveCount(1);await expect(page.locator('.tt-li-job')).toContainText('DSP-003');
 await page.locator('#tt-li-search').fill('');await expect(page.locator('.tt-li-job')).toHaveCount(5);
 await page.screenshot({path:test.info().outputPath('dispatch-'+width+'.png'),fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
