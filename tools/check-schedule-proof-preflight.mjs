import {pathToFileURL} from 'node:url';

const TEST_WORKER = 'elm-balloon-admin-line-secretary-test';
const ACCOUNT = '169dba5165188f599e49323315ac1fd6';
const REQUIRED = ['BROWSER_RENDERING_TOKEN','CLOUDFLARE_ACCOUNT_ID','SCHEDULE_PROOF_PAGE_URL','MANAGER_APP_ORIGIN','SECRETARY_KV'];

// Only existence/type is returned. Secret/plain binding values are never returned
// or logged. The fixed route cannot target production or modify a binding.
export async function checkTestProofBindings(apiToken,fetcher=fetch) {
  if (!apiToken) return {worker:TEST_WORKER,ready:false,reason:'missing_operator_api_token',missing:REQUIRED};
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${TEST_WORKER}/settings`,{
    method:'GET',headers:{Authorization:`Bearer ${apiToken}`},signal:AbortSignal.timeout(15000)
  });
  if (!response.ok) return {worker:TEST_WORKER,ready:false,reason:`settings_http_${response.status}`};
  const body = await response.json();
  if (body.success !== true || !Array.isArray(body.result?.bindings)) return {worker:TEST_WORKER,ready:false,reason:'invalid_settings_response'};
  const bindings=body.result.bindings;
  const present=REQUIRED.filter(name=>bindings.some(binding=>binding.name===name &&
    (name==='BROWSER_RENDERING_TOKEN'?binding.type==='secret_text':name==='SECRETARY_KV'?binding.type==='kv_namespace':binding.type==='plain_text' && !!binding.text)));
  const missing=REQUIRED.filter(name=>!present.includes(name));
  return {worker:TEST_WORKER,ready:missing.length===0,present,missing,scope:'binding_existence_only',imageCaptureVerified:false};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--remote-test')) {
    console.log(JSON.stringify({ready:false,reason:'read_only_remote_check_requires_explicit_remote_test_flag',usage:'node tools/check-schedule-proof-preflight.mjs --remote-test',requiredEnvironment:'CLOUDFLARE_API_TOKEN'},null,2));
    process.exitCode=2;
  } else {
    try {const result=await checkTestProofBindings(process.env.CLOUDFLARE_API_TOKEN);console.log(JSON.stringify(result,null,2));process.exitCode=result.ready?0:2;}
    catch {console.log(JSON.stringify({worker:TEST_WORKER,ready:false,reason:'settings_check_failed'}));process.exitCode=2;}
  }
}
