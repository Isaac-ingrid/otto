// Operator-owned synthetic lab acceptance. Secrets/cookies stay in this root process only.
import{readFileSync,writeFileSync}from'node:fs';
import{DatabaseSync}from'node:sqlite';
import{execFileSync}from'node:child_process';
import{randomUUID}from'node:crypto';
const RELEASE='/opt/otto/releases/4f66827',LOCAL='http://127.0.0.1:8787',PUBLIC='https://115.29.164.8';
const THREAD='t_01M72FJVV7GMGYT5FMHKADECSW',URL='https://github.com/Isaac-ingrid/otto-write-lab/pull/1',HEAD='88d4ce3f98bcc13fd3b1a21811a1c6ac3d04a852';
const state={startedAt:new Date().toISOString(),status:'running',stage:'setup',synthetic:true,source:'4f66827',steps:[],proposals:[]};
const save=()=>writeFileSync(RELEASE+'/acceptance.json',JSON.stringify(state,null,2)+'\n',{mode:0o600});
const assert=(ok,code)=>{if(!ok)throw Error(code);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function query(sql,...args){const db=new DatabaseSync('/var/lib/otto/steward.sqlite',{readOnly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}}
const stats=()=>Object.fromEntries(['sh_run','sh_worker','outbox','sh_followup','sh_routine'].map(t=>[t,query(`SELECT COUNT(*) AS n FROM ${t}`)[0].n]));
let key,cookie,csrf,watchId;
const req=async(path,body)=>{const response=await fetch(LOCAL+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+key,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});assert(response.ok,'owner_api_failed');return response.json();};
const workspace=async()=>{const r=await fetch(PUBLIC+'/app/api/workspace',{headers:{cookie},signal:AbortSignal.timeout(20000)});assert(r.status===200,'workspace_failed');const data=await r.json();csrf=data.csrf;return data;};
const webPost=async(path,body)=>{const r=await fetch(PUBLIC+'/app/api/'+path,{method:'POST',headers:{cookie,origin:PUBLIC,'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});return r.status;};
async function waitFor(fn,test,label,timeout=180000){const until=Date.now()+timeout;while(Date.now()<until){const value=await fn();if(test(value))return value;await sleep(1000);}throw Error(label);}
async function runMessage(text,suffix){const id=`deploy-confirm-${randomUUID()}-${suffix}`;await req('/api/messages',{id,text});return id;}
async function settled(id){await waitFor(()=>query('SELECT status,resultStatus FROM sh_run WHERE operationId=?','user:'+id)[0],r=>r?.status==='settled','model_turn_timeout');}
function proposalFor(id){return query('SELECT * FROM sh_pr_watch_approval WHERE sourceRef=?','user:'+id)[0];}
async function readyProposal(id){await settled(id);const p=await waitFor(()=>proposalFor(id),p=>p?.status==='pending','proposal_missing',10000);state.proposals.push(p.id);await waitFor(()=>query('SELECT * FROM sh_outbound WHERE id=?','prwatchapproval:'+p.id)[0],r=>r?.status==='sent'&&r.providerMsgId,'proposal_message_not_sent',10000);return p;}
function watch(){return query('SELECT * FROM sh_pr_watch WHERE id=?',watchId)[0];}
async function restart(){execFileSync('systemctl',['restart','otto'],{stdio:'ignore'});await waitFor(async()=>{try{return(await req('/api/pr-watches')).watches;}catch{return null;}},x=>Array.isArray(x),'restart_failed',30000);}
async function press(p,verb,requestId){const cardId='prwatchapproval:'+p.id;await workspace();const status=await webPost('actions',{id:requestId,cardId,action:`prwatch:${p.id}:${verb}`});assert(status===202,'workspace_action_failed');await waitFor(()=>query('SELECT status FROM sh_pr_watch_approval WHERE id=?',p.id)[0],x=>x?.status!=='pending','confirmation_timeout',10000);return status;}
try{
 save();for(const line of readFileSync('/etc/otto/.dev.vars','utf8').split(/\r?\n/)){const m=/^\s*SERVER_KEY\s*=\s*(.*?)\s*$/.exec(line);if(m)key=m[1].replace(/^(['"])(.*)\1$/,'$2');}assert(!!key,'missing_owner_key');
 const original=stats();state.before=original;assert(query("SELECT COUNT(*) AS n FROM sh_pr_watch WHERE status='active'")[0].n===0,'unexpected_existing_active_watch');
 const login=await req('/api/login-link',{});assert(new globalThis.URL(login.url).origin===PUBLIC,'unexpected_login_origin');const lr=await fetch(login.url,{redirect:'manual',signal:AbortSignal.timeout(20000)});assert(lr.status===303,'browser_login_failed');cookie=lr.headers.get('set-cookie')?.split(';')[0];assert(!!cookie,'browser_cookie_missing');await workspace();state.browserSession=true;
 state.stage='create_proposal';save();
 const createId=await runMessage(`部署验收：请在事项 ${THREAD} 下持续盯住 ${URL}，仅看 commit statuses，每60秒检查，期限60分钟。只生成专用确认提案，等我按确认按钮后再开始；不要派 worker、不要设 follow-up 或 routine。这是 synthetic status 机制验收，不是真实 CI。`,'create');state.createMessageId=createId;
 const p=await readyProposal(createId),c=JSON.parse(p.command);
 assert(c.action==='create'&&c.threadId===THREAD&&c.url===URL&&c.evidenceMode==='statuses-only'&&c.intervalSeconds===60&&c.expiresInMinutes===60,'create_preview_mismatch');state.createProposalId=p.id;state.createTuple=c;
 assert(query("SELECT COUNT(*) AS n FROM sh_pr_watch WHERE status='active'")[0].n===0,'created_before_confirmation');
 const card=query('SELECT * FROM sh_outbound WHERE id=?','prwatchapproval:'+p.id)[0];const beforeReply=stats().sh_run;
 await req('/api/messages',{id:'deploy-quote-'+randomUUID(),text:'同意，确认执行',replyTo:card.providerMsgId});await sleep(1000);
 assert(stats().sh_run===beforeReply,'plain_reply_started_model');assert(query("SELECT COUNT(*) AS n FROM sh_pr_watch WHERE status='active'")[0].n===0,'plain_reply_applied_watch');state.plainReplyDidNotAuthorize=true;
 state.stage='restart_pending';save();await restart();assert(proposalFor(createId)?.status==='pending','pending_proposal_lost');assert(query("SELECT COUNT(*) AS n FROM sh_pr_watch WHERE status='active'")[0].n===0,'restart_applied_pending_watch');state.pendingSurvivedRestart=true;
 const beforeConfirm=stats().sh_run;state.createActionStatus=await press(p,'confirm','deploy-create-'+randomUUID());
 watchId='pw_'+p.id.slice(6);state.watchId=watchId;
 assert(watch()?.status==='active','confirmed_watch_not_active');assert(stats().sh_run===beforeConfirm,'confirmation_started_model');state.confirmationModelFree=true;
 const wf=await workspace();assert(!wf.attention.some(x=>x.id==='prwatchapproval:'+p.id),'confirmed_card_still_open');
 const stale=await webPost('actions',{id:'deploy-stale-'+randomUUID(),cardId:'prwatchapproval:'+p.id,action:`prwatch:${p.id}:confirm`});assert(stale===409,'stale_button_not_refused');state.staleReplayStatus=stale;
 state.stage='first_scheduler_observation';save();
 const first=await waitFor(()=>watch(),w=>w?.checkedAt!=null&&w.status==='active'&&(w.head===HEAD||w.lastError!==null),'initial_poll_not_observed',150000);
 assert(first.lastError===null,'github_evidence_failed');assert(first.observedState==='waiting','synthetic_status_not_pending');state.firstCheckedAt=first.checkedAt;state.observedHead=first.head;
 const noticesBefore=query('SELECT COUNT(*) AS n FROM sh_pr_watch_notice WHERE watchId=?',watchId)[0].n;
 const runsBeforeRestart=stats().sh_run;state.stage='restart_active';save();await restart();assert(watch()?.status==='active','active_watch_not_recovered');
 const next=await waitFor(()=>watch(),w=>w?.checkedAt>first.checkedAt&&w.status==='active','recovered_scheduler_not_observed',180000);
 assert(stats().sh_run===runsBeforeRestart,'polling_started_model');assert(query('SELECT COUNT(*) AS n FROM sh_pr_watch_notice WHERE watchId=?',watchId)[0].n===noticesBefore,'duplicate_progress_notice');state.recoveredCheckedAt=next.checkedAt;state.pollingAndRecoveryModelFree=true;state.noDuplicateProgressNotice=true;
 state.stage='list';save();const listId=await runMessage('部署验收：现在都在盯哪些 PR？只列出，不创建或取消任何跟进。','list');state.listMessageId=listId;await settled(listId);assert(watch()?.status==='active','listing_changed_watch');assert(!proposalFor(listId),'listing_proposed_mutation');
 state.stage='cancel_proposal';save();const cancelId=await runMessage(`部署验收：取消 PR 跟进 ${watchId}。`,'cancel');state.cancelMessageId=cancelId;
 const cp=await readyProposal(cancelId),cc=JSON.parse(cp.command);assert(cc.action==='cancel'&&cc.watch.id===watchId&&cc.watch.threadId===THREAD&&cc.watch.url===URL&&cc.watch.evidenceMode==='statuses-only','cancel_preview_mismatch');assert(watch()?.status==='active','cancelled_before_confirmation');state.cancelProposalId=cp.id;
 const beforeCancel=stats().sh_run;state.cancelActionStatus=await press(cp,'confirm','deploy-cancel-'+randomUUID());assert(watch()?.status==='cancelled','cancel_not_applied');assert(stats().sh_run===beforeCancel,'cancel_confirmation_started_model');
 const checked=watch().checkedAt;state.stage='post_cancel';save();await sleep(70000);assert(watch().status==='cancelled'&&watch().checkedAt===checked,'cancelled_watch_polled');
 const after=stats();state.after=after;assert(after.sh_run-original.sh_run===3,'unexpected_model_runs');for(const table of ['sh_worker','outbox','sh_followup','sh_routine'])assert(after[table]===original[table],'unexpected_worker_or_schedule');
 assert(query("SELECT COUNT(*) AS n FROM sh_pr_watch WHERE status='active'")[0].n===0,'left_active_test_watch');state.noWorkerOrFollowup=true;state.modelRunsAdded=3;state.activeTestWatches=0;state.status='passed';state.finishedAt=new Date().toISOString();save();console.log('Live owner-confirmation lifecycle passed; only whitelisted receipt fields saved.');
}catch(error){state.status='failed';state.failureCode=typeof error?.message==='string'&&/^[a-z_]+$/.test(error.message)?error.message:'private_acceptance_failure';state.finishedAt=new Date().toISOString();save();console.error('Live acceptance failed at stage '+state.stage+' ('+state.failureCode+').');process.exitCode=1;}
finally{
 if(key){
  if(watchId&&watch()?.status==='active'){try{await req('/api/pr-watches',{action:'cancel',id:watchId});state.cleanupOwnerApi=true;}catch{state.cleanupFailed=true;}}
  for(const id of state.proposals){try{const p=query('SELECT status FROM sh_pr_watch_approval WHERE id=?',id)[0];if(p?.status==='pending')await req('/api/actions',{cardMsgId:'prwatchapproval:'+id,action:`prwatch:${id}:decline`});}catch{state.cleanupFailed=true;}}
 }
 if(cookie){try{await workspace();state.logoutStatus=await webPost('logout',{});}catch{state.logoutStatus=0;}}
 save();
}
