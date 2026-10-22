'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'tt-ai-workspace.js'), 'utf8');

function runWorkspace(contextReply) {
  const requests=[];
  const nodes=new Map();
  let current=contextReply;
  const input={value:'',disabled:false,focus(){this.focused=true}};
  const send={disabled:false,textContent:'Ask'};
  const note={textContent:''};
  const form={};
  const thread={innerHTML:'',scrollHeight:100,scrollTop:0};
  const launcher={handlers:{},addEventListener(event,callback){this.handlers[event]=callback}};
  const topbar={insertAdjacentHTML(position,html){
    assert.equal(position,'beforeend');
    assert.match(html,/tt-ai-launcher/);
    nodes.set('tt-ai-launcher',launcher);
  }};
  const element=()=>{
    const item={id:'',innerHTML:'',className:'',remove(){nodes.delete(this.id)},
      querySelectorAll:()=>[],
      querySelector: selector=>selector==='#tt-ai-form'?form:selector==='#tt-ai-input'?input:null,
    };
    return item;
  };
  const document={
    documentElement:{},
    body:{appendChild(el){nodes.set(el.id,el)}},
    createElement:()=>element(),
    getElementById:id=>({
      'tt-ai-input':input,'tt-ai-send':send,
      'tt-ai-composer-note':note,'tt-ai-thread':thread,
    }[id]||nodes.get(id)||null),
    querySelector:selector=>selector==='.shell-topbar'?topbar:null,
    addEventListener:()=>{},
  };
  const window={};
  const fetch=async(url,options)=>{
    requests.push({url,options});
    if(url==='/api/tt-ai/context') {
      return current===null
        ? {ok:false,status:503,json:async()=>({code:'SERVICE_NOT_AVAILABLE',error:'Not connected'})}
        : {ok:true,json:async()=>current};
    }
    if(url==='/api/tt-ai/query') {
      return {ok:true,json:async()=>({
        kind:'verified',phase:'complete',
        answer:{text:'Generator stock 2',data:{items:[{name:'Generator',sku:'GEN-55',stock_qty:2}]}},
        evidence:[{source:'pos',tool:'pos.products.search'}],
      })};
    }
    throw new Error('Unexpected browser request '+url);
  };
  vm.runInNewContext(script,{
    window,document,fetch,MutationObserver:class{observe(){}},
    Intl,Date,console,Set,Map,Number,
  },{filename:'tt-ai-workspace.js'});
  return {window,requests,nodes,input,send,note,thread,launcher,setContext:v=>{current=v}};
}

test('failed employee context means no false readiness or active question submit',async()=>{
  const app=runWorkspace(null);
  await app.window.TotalToolsTTAI.open();
  const markup=app.nodes.get('tt-ai-workspace').innerHTML;
  assert.match(markup,/Service not connected/);
  assert.doesNotMatch(markup,/>Company data ready</);
  assert.equal(app.input.disabled,true);
  assert.equal(app.send.disabled,true);
  await app.window.TotalToolsTTAI.ask('Show me generator stock');
  assert.deepEqual(app.requests.map(x=>x.url),['/api/tt-ai/context']);
});

test('connected staff can ask through only TT AI read gateway and reopen clears history',async()=>{
  const app=runWorkspace({
    employee_id:42,branch_id:'2',
    capabilities:{query:true,products:true},
    runtime:{configured:true,service_reachable:true,retail_purchasing:{}},
  });
  await app.window.TotalToolsTTAI.open();
  assert.equal(app.input.disabled,false);
  assert.match(app.nodes.get('tt-ai-workspace').innerHTML,/Company data ready/);
  await app.window.TotalToolsTTAI.ask('Do we have generators in stock?');
  assert.deepEqual(app.requests.map(x=>x.url),
    ['/api/tt-ai/context','/api/tt-ai/query']);
  assert.equal(app.requests[1].options.method,'POST');
  assert.match(app.thread.innerHTML,/Generator stock 2/);
  app.setContext(null);
  await app.window.TotalToolsTTAI.open();
  assert.equal(app.input.disabled,true);
  assert.doesNotMatch(app.thread.innerHTML,/Generator stock 2/);
  assert.equal(app.requests.length,3);
});

test('authenticated shell topbar launcher opens the read-only workspace',async()=>{
  const app=runWorkspace({
    employee_id:42,branch_id:'2',
    capabilities:{query:true,products:true},
    runtime:{configured:true,service_reachable:true,retail_purchasing:{}},
  });
  assert.equal(typeof app.launcher.handlers.click,'function');
  await app.launcher.handlers.click();
  assert.ok(app.nodes.has('tt-ai-workspace'));
  assert.match(app.nodes.get('tt-ai-workspace').innerHTML,/Read only/);
  assert.deepEqual(app.requests.map(x=>x.url),['/api/tt-ai/context']);
});
