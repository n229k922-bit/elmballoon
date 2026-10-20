// Local deterministic/mocked tests only. No deploy, credentials or real sends.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=[
'test-order-record-workflow','test-conversation-planner','test-conversation-adversarial','test-conversation-order-routing','test-conversation-specifications','test-quantity-integrity','test-conversation-personas','test-order-isolation','test-sensitive-conversation','test-sensitive-runtime','test-everyday-simulation','test-independent-simulation','test-calendar-security','test-manager-mobile','test-manager-intake','test-manager-history','test-capacity-safety','test-operational-metrics','test-manager-freshness','test-manager-safety-ui','test-manager-friendly-console','test-site-dialogue','test-ai-disclosure','test-line-e2e','test-manager-policy','test-manager-readiness','test-manager-migration-rehearsal','test-four-role-scenarios','test-schedule-proof','test-schedule-atomicity','test-schedule-proof-preflight','test-stage-site-image-change','test-manager-media','test-manager-image-archive','test-manager-health','test-manager-setup','test-manager-operational-readiness','test-backup-manager','test-manager-runtime','test-order-knowledge-import',
];
const results=[];
for(const name of files){
 const started=Date.now(),result=spawnSync(process.execPath,[`tools/${name}.mjs`],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 const passed=result.status===0&&!result.error;
 results.push({name,passed,durationMs:Date.now()-started,...(!passed?{detail:String(result.error||result.stderr||result.stdout).slice(-10000)}:{})});
 console.log(`${passed?'PASS':'FAIL'} ${name}`);
}
const report={checkedAt:new Date().toISOString(),scope:'local_mocked_no_real_LINE',files:results.length,passed:results.filter(result=>result.passed).length,failed:results.filter(result=>!result.passed).length,results};
const index=process.argv.indexOf('--report');if(index>=0){if(!process.argv[index+1])throw Error('Missing report path');fs.writeFileSync(process.argv[index+1],JSON.stringify(report,null,2));}
console.log(JSON.stringify({files:report.files,passed:report.passed,failed:report.failed}));
if(report.failed)process.exitCode=1;
