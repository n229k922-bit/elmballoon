// Operator-only bootstrap for an app whose LINE entrance is not connected yet.
// SQL contains a hash only. The one-use URL is kept in an ignored private file.
import { randomBytes, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const options=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,args)=>index%2===0?[...pairs,[value,args[index+1]]]:pairs,[]));
const origin=new URL(options['--origin']);
const actor=options['--actor'];
const output=options['--output'];
if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.search||origin.hash||!/^[-a-zA-Z0-9_]{1,80}$/.test(actor||'')||!output?.endsWith('.private.json'))throw new Error('Explicit HTTPS origin, actor and new .private.json output are required.');
const token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
const expiresAt=new Date(Date.now()+30*60_000).toISOString();
await writeFile(output,JSON.stringify({url:origin.origin+'/manager#login='+token,expiresAt},null,2)+'\n',{flag:'wx',mode:0o600});
await writeFile(output+'.sql',`INSERT INTO manager_login_links(token_hash,actor,expires_at) VALUES ('${hash}','${actor}','${expiresAt}');\n`,{flag:'wx',mode:0o600});
console.log('Created a one-use 30-minute app entrance. Private URL was not printed.');
