import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createBackup,verifyBackup} from './backup-manager.mjs';

test('encrypted readback preserves binary and Japanese files and rehearses SQL and KV restoration',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'elm-backup-test-'));
 try {
  const source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'カルテ.txt'),'非公開サンプル');fs.writeFileSync(path.join(source,'image.bin'),Buffer.from([0,255,1,0]));
  const sqlFile=path.join(root,'source.sql');fs.writeFileSync(sqlFile,"CREATE TABLE orders(id TEXT, quantity INTEGER); INSERT INTO orders VALUES('SYNTHETIC',2);");
  const kvFile=path.join(root,'kv.json');fs.writeFileSync(kvFile,JSON.stringify([{key:'synthetic',valueBase64:'AP8BAA=='}]));
  const key=crypto.randomBytes(32),output=path.join(root,'backup.elmbak');
  const report=createBackup({sources:[source],sqlFile,kvFile,output,key});
  assert.equal(report.files,4);assert.equal(report.database.integrity,'ok');assert.deepEqual(report.database.tables,[{name:'orders',count:1}]);assert.equal(report.kvEntries,1);
  assert.equal(fs.readFileSync(output).includes(Buffer.from('非公開サンプル')),false);
  assert.deepEqual(verifyBackup({archive:output,key}),report);
  assert.throws(()=>verifyBackup({archive:output,key:crypto.randomBytes(32)}));
  const raw=fs.readFileSync(output);raw[raw.length-1]^=1;fs.writeFileSync(output,raw);assert.throws(()=>verifyBackup({archive:output,key}));
 }finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('backup rejects repository output and existing backups',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'elm-backup-safe-'));
 try {const source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'sample'),'test');const key=crypto.randomBytes(32),output=path.join(root,'backup');
 assert.throws(()=>createBackup({sources:[source],output:fileURLToPath(new URL('../unsafe.elmbak',import.meta.url)),key}),/outside repository/);
 createBackup({sources:[source],output,key});assert.throws(()=>createBackup({sources:[source],output,key}));
 }finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('SQL restore cannot attach or write a file outside its isolated database',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'elm-backup-sql-safe-'));
 try {const source=path.join(root,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'sample'),'test');const sqlFile=path.join(root,'dump.sql');
 fs.writeFileSync(sqlFile,"ATTACH DATABASE 'forbidden-restore.db' AS external;");
 assert.throws(()=>createBackup({sources:[source],sqlFile,output:path.join(root,'backup'),key:crypto.randomBytes(32)}));
 assert.equal(fs.existsSync('forbidden-restore.db'),false);
 }finally {fs.rmSync(root,{recursive:true,force:true});}
});
