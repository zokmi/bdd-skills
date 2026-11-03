const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync,rmdirSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {once}=require('node:events');
const assert=require('node:assert/strict');
const {createInterface}=require('node:readline');
(async()=>{
const dir=mkdtempSync(join(tmpdir(),'bdd-compare-'));
const db=join(dir,'orders.sqlite');
const server=spawn(process.execPath,[join(__dirname,'quality-fixture.cjs'),'serve',db]);
const port=(await once(createInterface({input:server.stdout}),'line'))[0];
const url='http://127.0.0.1:'+port;
const mcp=spawn(process.env.ComSpec,['/d','/s','/c','npm exec --offline --yes --package=@playwright/mcp@0.0.84 -- playwright-mcp --headless --isolated'],{stdio:['pipe','pipe','inherit']});
const pending=new Map();let id=0;
createInterface({input:mcp.stdout}).on('line',line=>{
 const msg=JSON.parse(line);pending.get(msg.id)?.(msg);
});
function rpc(method,params){
 return new Promise((resolve,reject)=>{
 const key=++id;
 const timeout=setTimeout(()=>reject(Error(method+' timeout')),45000);
 pending.set(key,msg=>{clearTimeout(timeout);pending.delete(key);msg.error?reject(Error(JSON.stringify(msg.error))):resolve(msg.result);});
 mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');
 });
}
try{
await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'bdd-fixture',version:'1'}});
mcp.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
const requested=process.argv[2];
assert.ok(!requested || ['separate','batch'].includes(requested));
for(const mode of requested ? [requested] : ['separate','batch','batch','separate','separate','batch']){
 const start=performance.now();let calls=0;
 async function ui(name,args){
  calls++;const result=await rpc('tools/call',{name,arguments:args});
  if(result.isError)throw Error(JSON.stringify(result));
  return JSON.stringify(result.content);
 }
 const go='await page.goto('+JSON.stringify(url)+');';
 const title="if(await page.getByRole('heading').innerText()!=='Order 1')throw Error('heading');";
  const expectedState=process.argv[3]==='wrong-state'?'pending':'paid';
 const state="if(await page.getByRole('status').innerText()!=="+JSON.stringify(expectedState)+")throw Error('state');";
 try {
 if(mode==='separate'){
  await ui('browser_navigate',{url});
  for(const check of [title,state])await ui('browser_run_code_unsafe',{code:'async page=>{'+check+'}'});
 }else await ui('browser_run_code_unsafe',{code:'async page=>{'+go+title+state+'}'});
 await ui('browser_close',{});
 const response=await fetch(url+'/api/orders/1');
 assert.equal(response.status,200);
 assert.match(response.headers.get('content-type'),/^application\/json/);
 assert.deepEqual(await response.json(),{id:1,state:'paid'});
 const query=spawn(process.execPath,[join(__dirname,'quality-fixture.cjs'),'read',db]);
 let output='';query.stdout.on('data',c=>output+=c);
 assert.equal((await once(query,'close'))[0],0);
 assert.deepEqual(JSON.parse(output),{id:1,state:'paid'});
 console.log(JSON.stringify({mode,ms:Math.round(performance.now()-start),mcpCalls:calls,assertions:['heading','state','status','schema','body','db'],status:'PASSED',tokens:null}));
 }catch(error){
  console.log(JSON.stringify({mode,ms:Math.round(performance.now()-start),mcpCalls:calls,status:'FAILED',error:error.message}));
  process.exitCode=1;
 }
}
}finally{
 mcp.stdin.end();server.kill();await once(server,'exit');rmSync(db,{force:true});rmdirSync(dir);
}
})().catch(error=>{console.error(error);process.exitCode=1;});
