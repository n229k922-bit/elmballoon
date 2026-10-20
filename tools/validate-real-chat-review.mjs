// Read-only evidence validation. No database, network, import, or activation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
assert.equal(args.length,2,'Use --evidence-dir <private local directory>');
assert.equal(args[0],'--evidence-dir');
const root=fs.realpathSync(args[1]);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'review-manifest.private.json'),'utf8'));
const notes=fs.readFileSync(path.join(root,'reviewed-conversations.private.md'),'utf8');
const candidates=JSON.parse(fs.readFileSync(new URL('../docs/knowledge/2026-10-19-real-chat-candidates.json',import.meta.url),'utf8'));
assert.equal(manifest.synthetic,false);assert.equal(manifest.activation_allowed,false);
assert.equal(manifest.server_import_performed,false);assert.equal(manifest.message_send_performed,false);
assert.equal(manifest.cases.length,5);assert.equal(new Set(manifest.cases.map(c=>c.id)).size,5);
for(const entry of manifest.files){
 assert.equal(path.basename(entry.name),entry.name,'Evidence name must not escape archive');
 const bytes=fs.readFileSync(path.join(root,entry.name));
 assert.equal(bytes.length,entry.bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256,'Evidence hash mismatch');
}
assert.equal(manifest.full_screenshots,26);
assert.equal(candidates.synthetic,false);assert.equal(candidates.activation_allowed,false);
assert.equal(candidates.candidates.length,16);
for(const candidate of candidates.candidates){
 assert.equal(candidate.activation_allowed,false);
 for(const id of candidate.source_cases){assert(manifest.cases.some(c=>c.id===id));assert(notes.includes(`## ${id}`));}
}
console.log(JSON.stringify({validation:'passed',reviewedThreads:5,fullScreenshots:26,verifiedExcerpts:manifest.excerpt_screenshots,candidates:16,activationAllowed:false,uniqueNewOrders:'not_established',serverImport:false}));
