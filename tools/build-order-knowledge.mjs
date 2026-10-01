import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const normalize = text => text.replace(/\r\n?/g, '\n');

// Keep source text intact. Dates, customer identity and fulfillment are not inferred.
export function buildBundle(privateText, knowledgeText, createdAt = new Date().toISOString()) {
  const source = normalize(privateText);
  const lines = source.split('\n');
  const headings = lines.map((text, index) => ({ text, index })).filter(row => /^#{2,3} /.test(row.text));
  const records = [];
  const cardHeadings = new Set();
  function add(raw, heading, line, kind) {
    const digest = hash(raw);
    records.push({
      id: `legacy_${hash(`CUSTOMER_ORDER_CARDS_PRIVATE.md\n${heading}\n${digest}`).slice(0, 32)}`,
      source_hash: digest, source_file: 'CUSTOMER_ORDER_CARDS_PRIVATE.md',
      source_heading: heading, source_line: line, raw_text: raw,
      review_status: 'needs_review', linked_customer_id: null, created_at: createdAt,
      evidence_kind: kind, history_completeness: 'unverified', activation_allowed: false,
    });
  }
  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    const end = headings[i + 1]?.index ?? lines.length;
    if (/^### [ABC]-\d+ /.test(current.text)) {
      const cardKey = current.text.match(/^### ([ABC]-\d+)/)[1];
      if (cardHeadings.has(cardKey)) throw new Error('Duplicate card sections require review.');
      cardHeadings.add(cardKey);
      add(lines.slice(current.index, end).join('\n'), current.text.slice(4), current.index + 1, 'summarized_order');
    }
    if (/^## D\./.test(current.text)) {
      for (let j = current.index + 1; j < end; j++) {
        if (lines[j].startsWith('- ')) add(lines[j], current.text.slice(3), j + 1, 'limited_evidence');
      }
    }
  }
  if (!records.length) throw new Error('No supported card sections were found.');
  const knowledge = normalize(knowledgeText);
  const knowledgeLines = knowledge.split('\n');
  const cases = knowledgeLines.map((text, index) => ({ text, index })).filter(row => /^## ケース：/.test(row.text));
  const candidates = cases.map((section, i) => {
    const raw = knowledgeLines.slice(section.index, cases[i + 1]?.index ?? knowledgeLines.length).join('\n');
    return {
      id: `candidate_${hash(raw).slice(0, 32)}`, source_hash: hash(raw),
      source_file: 'REAL_CONVERSATION_KNOWLEDGE.md', source_heading: section.text.slice(3),
      source_line: section.index + 1, raw_text: raw, review_status: 'needs_review',
      approved_for_runtime: false, approved_for_pricing: false, created_at: createdAt,
    };
  });
  if (new Set(records.map(row => row.id)).size !== records.length) throw new Error('Duplicate card sections require review.');
  return {
    schema_version: 1, target: 'manager_imports', mode: 'review_only', created_at: createdAt,
    // This source snapshot retains contextual notes and headings not parsed as cards.
    private_source: { source_file: 'CUSTOMER_ORDER_CARDS_PRIVATE.md', source_hash: hash(source), raw_text: source },
    records, knowledge_candidates: candidates,
    activation_requirements: ['operator_verified_customer_link', 'source_review', 'explicit_activation'],
    quality_notes: ['No full-history completeness guarantee.', 'Historical prices and availability are not current business rules.', 'Source claims and inferences remain unverified.'],
  };
}

export async function runCli(args) {
  let privateFile = 'CUSTOMER_ORDER_CARDS_PRIVATE.md';
  let knowledgeFile = 'REAL_CONVERSATION_KNOWLEDGE.md';
  let output;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--validate') continue;
    if (!['--private', '--knowledge', '--output'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid arguments. Use --validate or --output <file.private.json>.');
    const value = args[++i];
    if (arg === '--private') privateFile = value;
    if (arg === '--knowledge') knowledgeFile = value;
    if (arg === '--output') output = value;
  }
  if (output && !basename(output).endsWith('.private.json')) throw new Error('Output must end in .private.json.');
  const [privateText, knowledgeText] = await Promise.all([readFile(privateFile, 'utf8'), readFile(knowledgeFile, 'utf8')]);
  const bundle = buildBundle(privateText, knowledgeText);
  if (output) await writeFile(output, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ records: bundle.records.length, knowledge_candidates: bundle.knowledge_candidates.length, needs_review: bundle.records.length, output_written: Boolean(output) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch(() => {
    // Do not include filesystem paths or source contents in error output.
    console.error('Import validation failed. Check arguments, readable sources, unique sections and a new .private.json output path.');
    process.exitCode = 1;
  });
}
