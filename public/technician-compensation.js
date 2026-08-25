(() => {
  'use strict';

  const API = '/api/technician-compensation';
  const today = new Date().toISOString().slice(0, 10);
  const start30 = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const state = {
    open: false,
    tab: 'performance',
    performance: null,
    compensation: null,
    performanceStart: start30,
    performanceEnd: today,
    payDate: today,
    selectedTech: null,
    working: false,
  };

  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const money = n => new Intl.NumberFormat('en-JM',{style:'currency',currency:'JMD',maximumFractionDigits:2}).format(Number(n)||0);
  const pct = n => n == null ? '—' : Number(n).toFixed(1) + '%';
  const label = s => String(s || 'unavailable').replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());

  async function request(path, init={}) {
    const response = await fetch(API + path, {
      credentials:'same-origin',
      headers:{Accept:'application/json',...(init.body?{'Content-Type':'application/json'}:{}),...(init.headers||{})},
      ...init,
    });
    const payload = await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(payload.error || 'Technician intelligence is unavailable');
    return payload;
  }

  function authenticated(){
    if(document.querySelector('.shell-app')) return true;
    const login=document.getElementById('login-screen'), main=document.getElementById('main');
    if(login&&main) return getComputedStyle(login).display==='none' && getComputedStyle(main).display!=='none';
    return !!window.__TT_WORKSPACE_PROFILE__;
  }

  async function load(){
    if(!state.open) return;
    state.working=true; render();
    const perfQ='?start='+encodeURIComponent(state.performanceStart)+'&end='+encodeURIComponent(state.performanceEnd);
    const results=await Promise.allSettled([
      request('/performance/summary'+perfQ),
      request('/summary?date='+encodeURIComponent(state.payDate)),
    ]);
    state.performance=results[0].status==='fulfilled'?results[0].value:{error:results[0].reason?.message||'Performance intelligence unavailable',rows:[]};
    state.compensation=results[1].status==='fulfilled'?results[1].value:{error:results[1].reason?.message||'Compensation controls unavailable',rows:[]};
    const ids=(state.performance?.rows||[]).map(r=>Number(r.employee_id));
    if(state.selectedTech&&!ids.includes(Number(state.selectedTech))) state.selectedTech=null;
    state.working=false; render();
  }

  async function open(options={}){
    if(!authenticated()) return;
    if(options.tab==='compensation') state.tab='compensation';
    else if(options.tab==='performance') state.tab='performance';
    if(state.open){await load();return;}
    try{await request('/period');}catch(error){console.warn('Technician intelligence access denied:',error.message);return;}
    document.getElementById('tt-tech-pay-root')?.remove();
    const root=document.createElement('div');root.id='tt-tech-pay-root';document.body.appendChild(root);state.open=true;await load();
  }
  function close(){document.getElementById('tt-tech-pay-root')?.remove();state.open=false;state.selectedTech=null;}

  function teamStats(){
    const rows=state.performance?.rows||[];
    const scored=rows.filter(r=>r.scorecard?.overall_score!=null);
    const avg=arr=>arr.length?arr.reduce((a,b)=>a+Number(b||0),0)/arr.length:null;
    return {
      measured:rows.length,
      scored:scored.length,
      score:avg(scored.map(r=>r.scorecard.overall_score)),
      coverage:avg(rows.map(r=>r.scorecard?.evidence_coverage_percent||0)),
      eligible:rows.filter(r=>r.scorecard?.incentive_review?.eligible).length,
      flags:rows.reduce((n,r)=>n+(r.scorecard?.flags?.length||0),0),
    };
  }
  function metricTile(name,m){
    const available=m?.available;
    return `<article class="tt-tech-score__metric ${available?'':'is-unavailable'}"><div><small>${esc(label(name))}</small><strong>${available?pct(m.score):'No evidence'}</strong></div><span>${available?esc(m.note||'Verified evidence'):'Not inferred'}</span></article>`;
  }
  function bandClass(b){return ['exceptional','strong','solid'].includes(b)?'is-good':b==='watch'?'is-watch':b==='needs_improvement'?'is-risk':'is-muted';}
  function performanceRow(r){
    const s=r.scorecard||{}, score=s.overall_score;
    const q=s.metrics?.quality, cb=s.metrics?.comeback_control, eff=s.metrics?.efficiency, time=s.metrics?.timeliness;
    return `<button class="tt-tech-score__row ${Number(state.selectedTech)===Number(r.employee_id)?'is-selected':''}" data-tech="${Number(r.employee_id)}">
      <span class="tt-tech-score__person"><strong>${esc(r.first_name)} ${esc(r.last_name)}</strong><small>${esc(r.employee_number||'')} · ${Number(r.completed_tasks||0)} completed task${Number(r.completed_tasks||0)===1?'':'s'}</small></span>
      <span class="tt-tech-score__score"><strong>${score==null?'—':Number(score).toFixed(1)}</strong><small>${esc(label(s.performance_band))}</small></span>
      <span><strong>${pct(q?.score)}</strong><small>Quality</small></span>
      <span><strong>${pct(cb?.score)}</strong><small>Comeback control</small></span>
      <span><strong>${pct(eff?.score)}</strong><small>Efficiency</small></span>
      <span><strong>${pct(time?.score)}</strong><small>Timeliness</small></span>
      <span class="tt-tech-score__coverage"><strong>${Number(s.evidence_coverage_percent||0)}%</strong><small>Evidence</small></span>
      <span class="tt-tech-score__band ${bandClass(s.performance_band)}">${s.incentive_review?.eligible?'Incentive review':'Review evidence'}</span>
    </button>`;
  }
  function detailPanel(){
    const row=(state.performance?.rows||[]).find(r=>Number(r.employee_id)===Number(state.selectedTech));
    if(!row)return `<aside class="tt-tech-score__detail"><div class="tt-tech-pay__empty">Select a technician to inspect the evidence behind the score.</div></aside>`;
    const s=row.scorecard||{}, metrics=s.metrics||{};
    return `<aside class="tt-tech-score__detail">
      <div class="tt-tech-score__detail-head"><div><span>Evidence review</span><h3>${esc(row.first_name)} ${esc(row.last_name)}</h3><p>${esc(row.employee_number||'')} · ${esc(label(s.performance_band))}</p></div><div class="tt-tech-score__hero-score"><strong>${s.overall_score==null?'—':Number(s.overall_score).toFixed(1)}</strong><small>Overall</small></div></div>
      <div class="tt-tech-score__coverage-bar"><span style="width:${Math.max(0,Math.min(100,Number(s.evidence_coverage_percent||0)))}%"></span></div><p class="tt-tech-score__coverage-note">${Number(s.evidence_coverage_percent||0)}% of the weighted score has verified evidence. Missing dimensions are not assumed to be perfect.</p>
      <div class="tt-tech-score__metrics">${Object.entries(metrics).map(([k,v])=>metricTile(k,v)).join('')}</div>
      ${s.flags?.length?`<section class="tt-tech-score__flags"><strong>Review flags</strong>${s.flags.map(f=>`<p>${esc(f)}</p>`).join('')}</section>`:`<section class="tt-tech-score__clear"><strong>No current performance flags</strong><p>Available evidence did not trigger an anomaly or quality warning.</p></section>`}
      <section class="tt-tech-score__incentive ${s.incentive_review?.eligible?'is-eligible':''}"><strong>${s.incentive_review?.eligible?'Eligible for incentive review':'Not currently eligible for incentive review'}</strong><p>${esc(s.incentive_review?.policy||'Performance evidence never changes pay automatically.')}</p><small>Automatic pay change: No</small></section>
    </aside>`;
  }
  function performanceView(){
    const data=state.performance||{}, rows=(data.rows||[]).slice().sort((a,b)=>(b.scorecard?.overall_score??-1)-(a.scorecard?.overall_score??-1));
    const k=teamStats();
    if(data.error)return `<div class="tt-tech-pay__notice is-error">${esc(data.error)}</div>`;
    return `<div class="tt-tech-score">
      <div class="tt-tech-score__toolbar"><div><label>From<input type="date" id="tt-perf-start" value="${esc(state.performanceStart)}"></label><label>To<input type="date" id="tt-perf-end" value="${esc(state.performanceEnd)}"></label></div><p>Evidence-based performance. Quality and rework can outweigh raw speed.</p></div>
      <div class="tt-tech-score__kpis"><article><small>Technicians measured</small><strong>${k.measured}</strong><span>${k.scored} with scoreable evidence</span></article><article><small>Team performance</small><strong>${k.score==null?'—':k.score.toFixed(1)}</strong><span>Average scored result</span></article><article><small>Evidence coverage</small><strong>${k.coverage==null?'—':k.coverage.toFixed(0)+'%'}</strong><span>Weighted verified coverage</span></article><article><small>Incentive review</small><strong>${k.eligible}</strong><span>Review only · never automatic</span></article><article class="${k.flags?'is-attention':''}"><small>Review flags</small><strong>${k.flags}</strong><span>Quality, rework or anomaly flags</span></article></div>
      <div class="tt-tech-score__layout"><section class="tt-tech-score__list"><div class="tt-tech-score__list-head"><div><strong>Technician scorecards</strong><p>Overall results normalize only across dimensions that have evidence.</p></div><button type="button" data-refresh-performance>Refresh evidence</button></div>${rows.length?rows.map(performanceRow).join(''):'<div class="tt-tech-pay__empty">No technician performance evidence exists for this period.</div>'}</section>${detailPanel()}</div>
      <div class="tt-tech-score__method"><strong>Scoring methodology</strong><p>${esc(data.methodology||'Evidence-backed technician performance. Missing dimensions remain unavailable and are not inferred.')}</p></div>
    </div>`;
  }

  function evidence(row){
    const labels={time_entries:'Time',task_completion:'Tasks',attendance:'Attendance',overtime_hours:'OT',qc_first_pass:'QC',comeback_rework:'Rework',safety_events:'Safety'};
    return Object.entries(row.evidence||{}).map(([k,v])=>`<span class="${v==='unavailable'?'is-missing':''}">${esc(labels[k]||k)}: ${esc(v==='unavailable'?'Unavailable':'Verified')}</span>`).join('');
  }
  function payRow(row){
    const efficiency=row.efficiency_percent==null?'Efficiency unavailable':Number(row.efficiency_percent).toFixed(1)+'% allotted/actual';
    return `<tr><td><strong>${esc(row.first_name)} ${esc(row.last_name)}</strong><small>${esc(row.employee_number||'')}</small></td><td><strong>${Number(row.worked_hours||0).toFixed(2)} h</strong><small>${Number(row.worked_minutes||0).toFixed(1)} min</small></td><td><strong>${esc(row.completed_tasks)} completed</strong><small>${esc(efficiency)}</small></td><td class="tt-tech-pay__money">${money(row.hourly_rate)}</td><td class="tt-tech-pay__money">${money(row.base_pay)}</td><td class="tt-tech-pay__money">${money(row.adjustments_total)}</td><td class="tt-tech-pay__money">${money(row.payable_total)}</td><td><div class="tt-tech-pay__evidence">${evidence(row)}</div><div class="tt-tech-pay__actions"><button class="tt-action" data-rate="${Number(row.employee_id)}">Set rate</button><button class="tt-action" data-adjust="${Number(row.employee_id)}">Adjustment</button><button class="tt-action is-primary" data-finalize="${Number(row.employee_id)}">Finalize</button></div></td></tr>`;
  }
  function compensationView(){
    const s=state.compensation||{}, rows=s.rows||[];
    const period=s.period?`<strong>${esc(s.period.start)}</strong> → <strong>${esc(s.period.end)}</strong> · ${esc(s.period.label)}`:'Select a date to load the pay period.';
    if(s.error)return `<div class="tt-tech-pay__notice is-error">${esc(s.error)}</div>`;
    return `<div class="tt-tech-pay__comp"><div class="tt-tech-pay__toolbar"><label>Pay-period date<input type="date" id="tt-pay-date" value="${esc(state.payDate)}"></label><div class="tt-tech-pay__period">${period}</div></div><div class="tt-tech-pay__notice">Compensation is downstream of verified work evidence. Performance may support an approved incentive review, but this workspace never changes pay automatically.</div>${rows.length?`<div class="tt-tech-pay__table-wrap"><table><thead><tr><th>Technician</th><th>Verified time</th><th>Tasks / efficiency</th><th>Rate</th><th>Base pay</th><th>Adjustments</th><th>Payable</th><th>Evidence / controls</th></tr></thead><tbody>${rows.map(payRow).join('')}</tbody></table></div>`:'<div class="tt-tech-pay__empty">No completed technician timer evidence exists for this pay period.</div>'}<div id="tt-tech-pay-form" class="tt-tech-pay__form"></div></div>`;
  }

  function render(){
    const root=document.getElementById('tt-tech-pay-root');if(!root)return;
    root.innerHTML=`<div class="tt-tech-pay-overlay" data-pay-close><section class="tt-tech-pay" role="dialog" aria-modal="true" aria-labelledby="tt-tech-pay-title" onclick="event.stopPropagation()"><header class="tt-tech-pay__head"><div><span>Total Tools Repairs Intelligence</span><h2 id="tt-tech-pay-title">Technician Performance</h2><p>Quality, efficiency, timeliness, rework and evidence coverage — with compensation kept as a controlled downstream function.</p></div><button type="button" aria-label="Close technician performance" data-pay-close>×</button></header><nav class="tt-tech-pay__tabs"><button class="${state.tab==='performance'?'is-active':''}" data-tab="performance">Performance Intelligence</button><button class="${state.tab==='compensation'?'is-active':''}" data-tab="compensation">Compensation Controls</button></nav><div class="tt-tech-pay__body">${state.working?'<div class="tt-tech-pay__notice">Loading verified technician evidence…</div>':state.tab==='performance'?performanceView():compensationView()}</div></section></div>`;
    bind();
  }

  function bind(){
    const root=document.getElementById('tt-tech-pay-root');if(!root)return;
    root.querySelectorAll('[data-pay-close]').forEach(x=>x.addEventListener('click',close));
    root.querySelectorAll('[data-tab]').forEach(x=>x.addEventListener('click',()=>{state.tab=x.dataset.tab;render();}));
    root.querySelector('#tt-perf-start')?.addEventListener('change',e=>{state.performanceStart=e.target.value;void load();});
    root.querySelector('#tt-perf-end')?.addEventListener('change',e=>{state.performanceEnd=e.target.value;void load();});
    root.querySelector('[data-refresh-performance]')?.addEventListener('click',()=>void load());
    root.querySelectorAll('[data-tech]').forEach(x=>x.addEventListener('click',()=>{state.selectedTech=Number(x.dataset.tech);render();}));
    root.querySelector('#tt-pay-date')?.addEventListener('change',e=>{state.payDate=e.target.value;void load();});
    root.querySelectorAll('[data-rate]').forEach(x=>x.addEventListener('click',()=>showRate(Number(x.dataset.rate))));
    root.querySelectorAll('[data-adjust]').forEach(x=>x.addEventListener('click',()=>showAdjustment(Number(x.dataset.adjust))));
    root.querySelectorAll('[data-finalize]').forEach(x=>x.addEventListener('click',()=>void finalize(Number(x.dataset.finalize),x)));
  }
  function payTarget(id){return state.compensation?.rows?.find(r=>Number(r.employee_id)===Number(id));}
  function showRate(id){
    const row=payTarget(id),form=document.getElementById('tt-tech-pay-form');if(!row||!form)return;form.classList.add('is-open');
    form.innerHTML=`<h3>Set technician rate · ${esc(row.first_name)} ${esc(row.last_name)}</h3><form><div class="tt-tech-pay__form-grid"><label>Hourly rate<input name="hourly_rate" type="number" min="0" step="0.01" value="${Number(row.hourly_rate)||0}" required></label><label>Overtime rate<input name="overtime_rate" type="number" min="0" step="0.01" placeholder="Stored until verified OT evidence is available"></label><label>Effective from<input name="effective_from" type="date" value="${esc(state.compensation.period.start)}" required></label></div><label>Change note<textarea name="change_note" placeholder="Why is this rate changing?"></textarea></label><footer><button class="tt-action" type="button" data-form-cancel>Cancel</button><button class="tt-action is-primary" type="submit">Save rate</button></footer></form>`;
    form.querySelector('[data-form-cancel]').onclick=()=>{form.classList.remove('is-open');form.innerHTML='';};
    form.querySelector('form').onsubmit=async e=>{e.preventDefault();try{await request('/rates/'+id,{method:'PUT',body:JSON.stringify(Object.fromEntries(new FormData(e.currentTarget).entries()))});form.classList.remove('is-open');await load();}catch(err){alert(err.message);}};
    form.scrollIntoView({behavior:'smooth',block:'center'});
  }
  function showAdjustment(id){
    const row=payTarget(id),form=document.getElementById('tt-tech-pay-form');if(!row||!form)return;form.classList.add('is-open');
    form.innerHTML=`<h3>Controlled pay adjustment · ${esc(row.first_name)} ${esc(row.last_name)}</h3><form><div class="tt-tech-pay__form-grid"><label>Type<select name="adjustment_type"><option value="incentive">Approved incentive</option><option value="correction">Correction</option><option value="deduction">Authorized deduction</option><option value="other">Other</option></select></label><label>Amount<input name="amount" type="number" step="0.01" required></label></div><label>Audit note<textarea name="note" required placeholder="State the approved evidence and reason for this adjustment."></textarea></label><footer><button class="tt-action" type="button" data-form-cancel>Cancel</button><button class="tt-action is-primary" type="submit">Record adjustment</button></footer></form>`;
    form.querySelector('[data-form-cancel]').onclick=()=>{form.classList.remove('is-open');form.innerHTML='';};
    form.querySelector('form').onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget).entries());data.employee_id=id;data.period_start=state.compensation.period.start;data.period_end=state.compensation.period.end;try{await request('/adjustments',{method:'POST',body:JSON.stringify(data)});form.classList.remove('is-open');await load();}catch(err){alert(err.message);}};
    form.scrollIntoView({behavior:'smooth',block:'center'});
  }
  async function finalize(id,button){
    const row=payTarget(id);if(!row)return;if(!confirm(`Finalize ${row.first_name} ${row.last_name} for ${state.compensation.period.start} to ${state.compensation.period.end}? This freezes the current verified compensation evidence snapshot.`))return;button.disabled=true;try{await request('/finalize/'+id,{method:'POST',body:JSON.stringify({period_start:state.compensation.period.start,period_end:state.compensation.period.end})});alert('Verified technician compensation snapshot finalized.');await load();}catch(err){alert(err.message);}finally{button.disabled=false;}
  }

  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.open)close();});
  window.TotalToolsTechnicianCompensation={open,close,refresh:load};
})();
