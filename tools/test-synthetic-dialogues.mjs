import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve('docs/simulations/2026-10-16');
let checks = 0;
for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  assert.equal(data.synthetic, true, name); checks++;
}
const knowledge = JSON.parse(fs.readFileSync(path.join(dir, 'knowledge-candidates.json'), 'utf8'));
assert.equal(knowledge.activation_allowed, false);
assert.equal(knowledge.candidates.length, 12);
for (const candidate of knowledge.candidates) {
  assert.equal(candidate.activation_allowed, false);
  for (const ref of candidate.sources) {
    assert(!ref.file.includes('private'));
    const data = JSON.parse(fs.readFileSync(path.join(dir, ref.file), 'utf8'));
    assert((data.turns ?? data.feedback ?? []).some(t => t.caseId === ref.caseId), `${candidate.id}: ${ref.file}#${ref.caseId}`);
    checks++;
  }
}
for (let round = 1; round <= 4; round++) {
  for (const role of ['customer', 'clerk']) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, `${role}-round${round}.json`), 'utf8'));
    assert.equal(data.turns.length, 6);
    assert.equal(new Set(data.turns.map(t => t.caseId)).size, 6);
    for (const t of data.turns) assert.equal(t.customerId, `SIM-C${t.caseId.slice(3)}`);
    checks++;
  }
}
const replay = JSON.parse(fs.readFileSync(path.join(dir, 'runtime-replay.json'), 'utf8'));
assert.equal(replay.notLiveLine, true);
assert.equal(replay.managerRoleDecisionsApplied, false);
assert.equal(replay.realKnowledgeImports, 0);
assert.equal(replay.customerTurns, 24);
assert(replay.findings.some(f => f.id === 'SIM-F01'));
assert(replay.findings.some(f => f.id === 'SIM-F02'));
console.log(JSON.stringify({ artifactValidation: 'passed', checks, businessAcceptance: 'not_passed', reproducedIssues: replay.findings.length }));
