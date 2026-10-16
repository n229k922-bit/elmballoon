// Dedicated test-only QA login. Never use a link issued to the real owner.
// Creates one hash-only login record, logs out, then removes that QA record.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const base='https://elm-balloon-admin-line-secretary-test.n229k922.workers.dev';
const cwd=fileURLToPath(new URL('../workers/admin-line-secretary/',import.meta.url));
if(process.platform!=='win32')throw new Error('This local QA bootstrap uses PowerShell; no remote action taken.');
const sql=command=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
  `npx --yes wrangler@4.147.0 d1 execute elm-balloon-schedule-test --remote --config wrangler.test.toml --command "${command}" --json`],
  {cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
const actor='mobile-owner',expiry=new Date(Date.now()+5*60_000).toISOString();
let cookie=null,sessionHash=null,inserted=false;
try {
  // All interpolated values are fixed or generated hex/ISO; never user input.
  sql(`INSERT INTO manager_login_links(token_hash,actor,expires_at) VALUES ('${hash}','${actor}','${expiry}')`);inserted=true;
  const denied=await fetch(base+'/api/manager/readiness');assert.equal(denied.status,401);
  const login=await fetch(base+'/api/manager/session',{method:'POST',headers:{Origin:base,'X-Manager-Request':'1','Content-Type':'application/json'},body:JSON.stringify({token})});
  assert.equal(login.status,200,'dedicated QA login failed');cookie=login.headers.get('set-cookie')?.split(';')[0];
  const sessionToken=cookie?.slice(cookie.indexOf('=')+1);
  if(/^[a-f0-9]{64}$/u.test(sessionToken||''))sessionHash=createHash('sha256').update(sessionToken).digest('hex');
  assert.ok(sessionHash,'QA session cookie missing or malformed; login link will still be cleaned');
  const response=await fetch(base+'/api/manager/readiness?verify=line',{headers:{Cookie:cookie}});
  assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
  const report=await response.json();
  console.log(JSON.stringify({configurationReady:report.configurationReady,stage:report.stage,
    queueTransmissionEnabled:report.queueTransmissionEnabled,checks:report.checks,lineAccounts:report.lineAccounts,
    queues:report.queues,history:report.history,acceptance:report.acceptance},null,2));
  assert.equal(report.configurationReady,true,'readiness checks must all pass; diagnostics above contain no secrets');
  assert.equal(report.acceptance.productionApproved,false,'configuration check is not real LINE acceptance');
} finally {
  try {
    if(cookie) {
      const logout=await fetch(base+'/api/manager/logout',{method:'POST',headers:{Cookie:cookie,Origin:base,'X-Manager-Request':'1'},body:'{}'});
      assert.equal(logout.status,200);
      assert.equal((await fetch(base+'/api/manager/readiness',{headers:{Cookie:cookie}})).status,401);
    }
  } finally {
    try {
      if(sessionHash)sql(`DELETE FROM manager_sessions WHERE token_hash='${sessionHash}' AND actor='${actor}'`);
    } finally {
      if(inserted)sql(`DELETE FROM manager_login_links WHERE token_hash='${hash}' AND actor='${actor}'`);
    }
  }
}
