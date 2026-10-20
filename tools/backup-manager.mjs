import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync, constants } from 'node:sqlite';
import { pathToFileURL, fileURLToPath } from 'node:url';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function files(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), {withFileTypes:true}).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are excluded; provide their actual source explicitly');
    return entry.isDirectory() ? files(root, relative) : [{relative, data:fs.readFileSync(path.join(root, relative))}];
  });
}
function outsideRepository(target) {
  const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const relative = path.relative(repository, path.resolve(target));
  if (!relative || (!relative.startsWith('..'+path.sep) && !path.isAbsolute(relative))) throw new Error('Backup must be outside repository');
}
export function createBackup({sources, output, key, sqlFile, kvFile}) {
  outsideRepository(output);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('A 32-byte encryption key is required');
  const entries = sources.flatMap((source,index) => files(path.resolve(source)).map(file => ({name:`source-${index+1}/${file.relative.replaceAll('\\','/')}`, data:file.data.toString('base64'),sha256:hash(file.data),size:file.data.length})));
  for(const [name,file] of [['d1.sql',sqlFile],['kv.json',kvFile]]) if(file) {
    const data=fs.readFileSync(file); entries.push({name,data:data.toString('base64'),sha256:hash(data),size:data.length});
  }
  if (!entries.length) throw new Error('No files to back up');
  const manifest={version:1,createdAt:new Date().toISOString(),scope:{knowledge:sources.length>0,d1:Boolean(sqlFile),kv:Boolean(kvFile)},entries};
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(gzipSync(JSON.stringify(manifest))),cipher.final()]);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,Buffer.concat([Buffer.from('ELMBKP01'),iv,cipher.getAuthTag(),encrypted]),{flag:'wx',mode:0o600});
  return verifyBackup({archive:output,key});
}
export function verifyBackup({archive,key}) {
  const raw=fs.readFileSync(archive);
  if(raw.subarray(0,8).toString()!=='ELMBKP01')throw new Error('Unsupported backup format');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,raw.subarray(8,20));decipher.setAuthTag(raw.subarray(20,36));
  const manifest=JSON.parse(gunzipSync(Buffer.concat([decipher.update(raw.subarray(36)),decipher.final()])));
  if(manifest.version!==1||!Array.isArray(manifest.entries))throw new Error('Invalid manifest');
  for(const entry of manifest.entries) {
    const data=Buffer.from(entry.data,'base64');
    if(data.length!==entry.size||hash(data)!==entry.sha256)throw new Error('Backup hash mismatch');
    if(entry.name.includes('..')||path.isAbsolute(entry.name))throw new Error('Unsafe archive path');
  }
  const sql=manifest.entries.find(entry=>entry.name==='d1.sql');
  let database=null;
  if(sql) {
    const db=new DatabaseSync(':memory:');
    try {
      db.setAuthorizer((action,arg1,arg2)=> {
        if([constants.SQLITE_ATTACH,constants.SQLITE_DETACH].includes(action))return constants.SQLITE_DENY;
        if(action===constants.SQLITE_FUNCTION&&['load_extension','writefile','readfile'].includes(String(arg2||arg1).toLowerCase()))return constants.SQLITE_DENY;
        if(action===constants.SQLITE_PRAGMA&&['writable_schema','temp_store_directory','data_store_directory'].includes(String(arg1).toLowerCase()))return constants.SQLITE_DENY;
        return constants.SQLITE_OK;
      });
      db.exec(Buffer.from(sql.data,'base64').toString('utf8'));
      const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      database={integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,tables:tables.map(({name})=>({name,count:db.prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"','""')}"`).get().n}))};
      if(database.integrity!=='ok')throw new Error('Restored database integrity check failed');
    } finally {db.close();}
  }
  const kv=manifest.entries.find(entry=>entry.name==='kv.json');
  let kvEntries=null;
  if(kv) {
    const parsed=JSON.parse(Buffer.from(kv.data,'base64').toString('utf8'));
    if(!Array.isArray(parsed)||parsed.some(row=>typeof row.key!=='string'||typeof row.valueBase64!=='string'))throw new Error('KV export must be an array of {key,valueBase64,metadata?,expiration?}');
    if(new Set(parsed.map(row=>row.key)).size!==parsed.length)throw new Error('Duplicate KV keys');
    kvEntries=parsed.length;
  }
  return {version:manifest.version,createdAt:manifest.createdAt,files:manifest.entries.length,bytes:manifest.entries.reduce((n,e)=>n+e.size,0),scope:manifest.scope,archiveSha256:hash(raw),verified:true,database,kvEntries,offDeviceVerified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const [mode,configFile]=process.argv.slice(2);
    if(!['create','verify'].includes(mode)||!configFile)throw new Error('Usage: node tools/backup-manager.mjs create|verify PRIVATE_CONFIG.json');
    const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
    if(mode==='create'&&config.generateKeyFile&&!process.env.ELM_BACKUP_KEY_BASE64) {
      outsideRepository(config.keyFile);
      fs.mkdirSync(path.dirname(config.keyFile),{recursive:true});
      fs.writeFileSync(config.keyFile,crypto.randomBytes(32),{flag:'wx',mode:0o600});
    }
    const key=process.env.ELM_BACKUP_KEY_BASE64?Buffer.from(process.env.ELM_BACKUP_KEY_BASE64,'base64'):fs.readFileSync(config.keyFile);
    console.log(JSON.stringify(mode==='create'?createBackup({...config,key}):verifyBackup({...config,key}),null,2));
  }catch { console.error('Backup failed. Check private configuration, encryption key and source/export files. No remote changes were made.');process.exitCode=1; }
}
