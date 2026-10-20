import test from 'node:test';
import assert from 'node:assert/strict';
import {checkTestProofBindings} from './check-schedule-proof-preflight.mjs';
test('preflight uses fixed test GET route and reports only binding names, never secret/plain values',async()=>{
  const response=await checkTestProofBindings('operator-secret',async(url,options)=>{
    assert.match(url,/\/elm-balloon-admin-line-secretary-test\/settings$/);assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer operator-secret');
    return Response.json({success:true,result:{bindings:[{name:'BROWSER_RENDERING_TOKEN',type:'secret_text',text:'hidden-browser-secret'},{name:'CLOUDFLARE_ACCOUNT_ID',type:'plain_text',text:'private-account'},{name:'SCHEDULE_PROOF_PAGE_URL',type:'plain_text',text:'private-url'},{name:'MANAGER_APP_ORIGIN',type:'plain_text',text:'private-origin'},{name:'SECRETARY_KV',type:'kv_namespace',namespace_id:'private-namespace'}]}});
  });
  assert.equal(response.ready,true);assert.equal(response.imageCaptureVerified,false);assert.doesNotMatch(JSON.stringify(response),/hidden-browser-secret|private-|operator-secret/);
});
test('missing token, wrong binding type, failed API or malformed result never pass preflight',async()=>{
  assert.equal((await checkTestProofBindings('',()=>{throw new Error('must_not_fetch');})).ready,false);
  const missing=await checkTestProofBindings('mock',async()=>Response.json({success:true,result:{bindings:[{name:'BROWSER_RENDERING_TOKEN',type:'plain_text',text:'wrong'}]}}));
  assert.ok(missing.missing.includes('BROWSER_RENDERING_TOKEN'));
  assert.equal((await checkTestProofBindings('mock',async()=>new Response('',{status:403}))).ready,false);
  assert.equal((await checkTestProofBindings('mock',async()=>Response.json({success:false}))).ready,false);
});
