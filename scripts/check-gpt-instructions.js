#!/usr/bin/env node
/**
 * GPT instruction length gate (engine refinement plan, phase 11).
 *
 * docs/GPT_INSTRUCTIONS.md holds the Custom GPT instructions in one fenced block - the
 * exact text pasted into ChatGPT's Instructions box, which caps at 8,000 UTF-16 units.
 * JS strings are already UTF-16 code units, so `.length` on the extracted block is the
 * same count ChatGPT's editor would show.
 *
 * Usage: node scripts/check-gpt-instructions.js
 * Exit 0 and print the length under the 7,900 budget (100 spare); exit 1 over it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOC_PATH = path.join(__dirname, '..', 'docs', 'GPT_INSTRUCTIONS.md');
const BUDGET = 7900;

function extractFencedBlock(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === '```');
  if (start === -1) throw new Error('no fenced block found in docs/GPT_INSTRUCTIONS.md');
  const end = lines.findIndex((l, i) => i > start && l.trim() === '```');
  if (end === -1) throw new Error('fenced block never closes in docs/GPT_INSTRUCTIONS.md');
  return lines.slice(start + 1, end).join('\n');
}

const markdown = readFileSync(DOC_PATH, 'utf8');
const block = extractFencedBlock(markdown);
const length = block.length;

console.log(`GPT instructions: ${length} UTF-16 units (budget ${BUDGET}, ChatGPT cap 8000)`);

if (length > BUDGET) {
  console.error(`FAIL: ${length} exceeds the ${BUDGET}-unit budget by ${length - BUDGET}`);
  process.exit(1);
}

console.log(`OK: ${BUDGET - length} units of headroom`);
