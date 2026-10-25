'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {receipt,decision,HOURS,main} = require('./promote.cjs');
const sha = 'candidate';
const now = Date.parse('2026-10-25T12:00:00Z');
const run = {id:1,event:'push',head_sha:sha,created_at:new Date(now-HOURS).toISOString(),status:'completed',conclusion:'success'};
const pr = {number:1,state:'open',draft:false,head:{sha},labels:[],mergeable:true,mergeable_state:'clean'};
const fixture = changes => ({sha,now,run:{...run},pr:{...pr},...changes});
test('exactly 72 quiet hours and passing CI permit a merge',()=>assert.equal(decision(fixture()),null));
test('never promotes even one millisecond early',()=>assert.match(decision(fixture({now:now-1})),/72-hour/));
test('labels pause and removal resumes without resetting the receipt',()=>{
 assert.match(decision(fixture({pr:{...pr,labels:[{name:'do-not-merge'}]}})),/Paused/);
 assert.equal(decision(fixture()),null);
});
test('missing, malformed and stale push receipts block',()=>{
 for(const r of [null,{...run,head_sha:'old'},{...run,created_at:'bad'}])
  assert.match(decision(fixture({run:r})),/receipt/);
});
test('failed, cancelled, pending and skipped required CI block',()=>{
 for(const conclusion of ['failure','cancelled','skipped',null])
  assert.match(decision(fixture({run:{...run,conclusion}})),/validation/);
 assert.match(decision(fixture({run:{...run,status:'in_progress'}})),/validation/);
});
test('additional push CI and commit statuses cannot be ignored',()=>{
 assert.match(decision(fixture({extraRuns:[{status:'completed',conclusion:'failure'}]})),/Additional/);
 assert.match(decision(fixture({statuses:[{state:'pending'}]})),/status/);
});
test('duplicate PR approval holds do not replace successful push CI',()=>{
 assert.equal(decision(fixture({pr:{...pr,mergeable_state:'unstable'}})),null);
 assert.match(decision(fixture({pr:{...pr,mergeable_state:'unstable'},run:{...run,conclusion:'failure'}})),/validation/);
 assert.match(decision(fixture({pr:{...pr,mergeable_state:'blocked'}})),/clean/);
});
test('closed, draft, changed and conflicting PRs block',()=>{
 for(const p of [{...pr,state:'closed'},{...pr,draft:true},{...pr,head:{sha:'new'}},{...pr,mergeable:false},{...pr,mergeable_state:'behind'}])
  assert.ok(decision(fixture({pr:p})));
});
test('new pushes reset the timer even when a previously tested SHA returns',()=>{
 const newRun={...run,id:2,created_at:new Date(now).toISOString()};
 assert.equal(receipt([run,newRun],sha),newRun);
 assert.match(decision(fixture({run:receipt([run,newRun],sha)})),/72-hour/);
 assert.equal(receipt([run,{...newRun,head_sha:'different'}],sha),null);
});
test('rerunning CI preserves its original server creation time',()=>{
 const rerun={...run,run_attempt:2,updated_at:new Date(now).toISOString()};
 assert.equal(decision(fixture({run:receipt([rerun],sha)})),null);
});

function fake(options={}) {
 let merges=0, dispatches=0, approvals=0;
 const repository={default_branch:'main',full_name:'owner/repo',delete_branch_on_merge:false,allow_merge_commit:true};
 const controllerRun={...run,created_at:new Date(Date.now()-HOURS-10000).toISOString()};
 const api={
  repos:{get:async()=>({data:repository}),compareCommits:async()=>({data:{ahead_by:1,behind_by:0}}),listCommitStatusesForRef:async()=>[],merge:async()=>({status:201})},
  git:{getRef:async({ref})=>({data:{object:{sha:ref==='heads/testing'?sha:'release'}}})},
  pulls:{list:async()=>[{...pr,head:{sha,ref:'testing',repo:{full_name:'owner/repo'}}}],get:async()=>({data:{...pr,...options.pr}}),listReviews:async()=>[],merge:async args=>{assert.equal(args.merge_method,'merge');assert.equal(args.sha,sha);merges++;return {data:{merged:true}};},createReview:async()=>{approvals++;}},
  issues:{getLabel:async()=>({data:{}})},
  actions:{listWorkflowRuns:async()=>({data:{workflow_runs:options.runs??[controllerRun]}}),listWorkflowRunsForRepo:async()=>({data:{workflow_runs:[]}}),createWorkflowDispatch:async()=>{dispatches++;}},
 };
 const messages=[];
 const summary={addHeading(){return this;},addRaw(m){messages.push(m);return this;},async write(){}};
 return {github:{rest:api,paginate:async(fn,args)=>fn(args)},context:{repo:{owner:'owner',repo:'repo'}},core:{info(){},summary},
  result:()=>({merges,dispatches,approvals,messages})};
}
test('controller merges with an expected SHA and never approves PRs',async()=>{
 const f=fake();await main(f);assert.equal(f.result().merges,1);assert.equal(f.result().approvals,0);
});
test('controller honors the final label refresh',async()=>{
 const f=fake({pr:{labels:[{name:'do-not-merge'}]}});await main(f);assert.equal(f.result().merges,0);
});
test('missing push receipt dispatches validation and cannot merge',async()=>{
 const f=fake({runs:[]});await main(f);assert.equal(f.result().dispatches,1);assert.equal(f.result().merges,0);
});
