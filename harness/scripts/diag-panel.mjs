#!/usr/bin/env node
/** 诊断：在真实 control-panel 里发消息，抓网络，看 /api/chat 到底发生了什么 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL_BASE = "http://127.0.0.1:8790/";
const CDP = 9900 + Math.floor(Math.random() * 80);
const profile = mkdtempSync(join(tmpdir(), "dove-diag-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ["--headless=new","--disable-gpu","--no-sandbox","--hide-scrollbars",
  "--remote-debugging-port="+CDP,"--user-data-dir="+profile,"--window-size=1680,1050",URL_BASE], { stdio:["ignore","pipe","pipe"] });

let wsUrl=null;
for (let i=0;i<60;i++){ await sleep(300); try{ const l=await(await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); const p=l.find(t=>t.type==="page"&&t.webSocketDebuggerUrl); if(p){wsUrl=p.webSocketDebuggerUrl;break;} }catch{} }
const ws=new WebSocket(wsUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let id=0; const pending=new Map(); const reqs=[]; const errs=[];
ws.onmessage=(ev)=>{ const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
  if(m.method==="Network.requestWillBeSent"){ const u=m.params.request.url; if(u.includes("/api/")) reqs.push({phase:"req",url:u,method:m.params.request.method,body:(m.params.request.postData||"").slice(0,120)}); }
  if(m.method==="Network.responseReceived"){ const u=m.params.response.url; if(u.includes("/api/")) reqs.push({phase:"res",url:u,status:m.params.response.status,ct:m.params.response.headers["content-type"]||m.params.response.headers["Content-Type"]||""}); }
  if(m.method==="Network.loadingFailed"){ reqs.push({phase:"FAIL",err:m.params.errorText}); errs.push(m.params.errorText); }
  if(m.method==="Runtime.exceptionThrown"){ errs.push(m.params?.exceptionDetails?.exception?.description??"ex"); }
  if(m.method==="Runtime.consoleAPICalled"){ const txt=(m.params.args||[]).map(a=>a.value??a.description??"").join(" "); if(m.params.type==="error") errs.push("console: "+txt); else if(txt.includes("data:")||txt.includes("Failed")) reqs.push({phase:"console",txt:txt.slice(0,160)}); }
};
const send=(method,params={})=>new Promise((res,rej)=>{const i=++id;pending.set(i,m=>m.error?rej(new Error(method+":"+JSON.stringify(m.error))):res(m.result));ws.send(JSON.stringify({id:i,method,params}));setTimeout(()=>{if(pending.has(i)){pending.delete(i);rej(new Error(method+" 超时"));}},30000);});
await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
const ev=async(e)=>{const r=await send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails) throw new Error("页面抛错: "+(r.exceptionDetails.exception?.description??"")); return r.result?.value;};

await sleep(4000);
console.log("=== 界面上的按钮们 ===");
console.log(JSON.stringify(await ev("Array.from(document.querySelectorAll('button')).map((b,i)=>({i, txt:b.innerText.trim().slice(0,14), dis:b.disabled, title:b.title||'', aria:b.getAttribute('aria-label')||''}))"), null, 1));

const PORT = await ev(`(async()=>{const r=await fetch("http://127.0.0.1:8008/api/projects/create",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"诊断任务"})});return (await r.json()).project.port;})()`);
await ev(`localStorage.setItem("dove_port", "${PORT}"); "ok"`);
await send("Page.navigate",{url:URL_BASE}); await sleep(4500);
console.log("进入项目后 URL/标题:", await ev("document.title"), "| 有 textarea:", await ev("!!document.querySelector('textarea')"));

reqs.length = 0;
console.log("\n=== 输入并回车 ===");
await ev(`(()=>{const el=document.querySelector('textarea');const p=HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(el,'只回复两个字：你好');el.dispatchEvent(new Event('input',{bubbles:true}));el.focus();return el.value;})()`);
await ev(`(()=>{const el=document.querySelector('textarea');el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));return 'sent';})()`);

for (let i=0;i<12;i++){ await sleep(1500); }
console.log("\n=== /api/ 网络活动 ===");
for (const r of reqs.slice(0,30)) console.log(" ", JSON.stringify(r));
console.log("\n=== 错误 ===");
console.log(errs.length ? errs.slice(0,6).join("\n  ") : "(无)");
console.log("\n=== 界面文字（尾部 500）===");
console.log((await ev("document.body.innerText")).slice(-500));
ws.close(); chrome.kill("SIGKILL"); await sleep(400);
