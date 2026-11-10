#!/usr/bin/env node
// Checks that a worker report or PR body has a complete "Asked vs delivered" section and a
// passing scope review, so nothing reaches the owner with invented scope or open questions
// hidden inside it. The section's shape is in skills/scope-review/SKILL.md.
//
//   node scope-check.mjs --pr owner/repo#N    the PR's body, read with gh
//   node scope-check.mjs --file report.md     a saved report
//   node scope-check.mjs < report.md          a report on stdin
//
// Exit 0 pass (open questions for the owner are printed), 1 fail, 2 could not read.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEADING = /^(#{1,6})\s*Asked vs delivered\b.*$/i;
const LABELS = { delivered: /^delivered\b/i, notAsked: /^not asked\b/i, questions: /^open questions\b/i };
const VERDICT = /^scope review:\s*(\S+)(.*)$/i;
const STARTS_WITH_PLACEHOLDER = /^"?<[^<>\s]*\s[^<>]*>/;
const ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;

const bare = (line) => line.trim().replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
const isNone = (text) => /^(none|nothing|n\/a)\.?$/i.test(text.trim());
const isEmpty = (text) => isNone(text) || STARTS_WITH_PLACEHOLDER.test(text.trim());

/** The text with fenced code blocks blanked, so a template shown in a fence is never read as the section. */
function unfenced(text) {
  let fence = null;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const open = line.trim().match(/^(`{3,}|~{3,})/);
      if (fence) {
        const close = line.trim().match(/^(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
        return '';
      }
      if (open) {
        fence = open[1];
        return '';
      }
      return line;
    })
    .join('\n');
}

/** The lines of the "Asked vs delivered" section, up to the next heading of the same or a higher level. */
function section(text) {
  const lines = unfenced(text).split('\n');
  const at = lines.findIndex((l) => HEADING.test(l.trim()));
  if (at < 0) return null;
  const level = lines[at].trim().match(HEADING)[1].length;
  const end = lines.findIndex((l, i) => i > at && /^(#{1,6})\s/.test(l.trim()) && l.trim().match(/^(#+)/)[1].length <= level);
  return lines.slice(at + 1, end < 0 ? undefined : end);
}

/** Items under each label: the text after the label on its own line, then the list lines below it. */
function labelled(lines) {
  /** @type {Record<string, string[] | undefined>} */
  const found = {};
  let current = null;
  for (const raw of lines) {
    const line = bare(raw);
    const label = Object.keys(LABELS).find((k) => LABELS[k].test(line));
    if (label) {
      current = label;
      found[label] = [];
      const rest = line.replace(/^[^:]*:?/, '').trim();
      if (rest) found[label].push(rest);
      continue;
    }
    if (VERDICT.test(line) || line.startsWith('>')) current = null;
    const item = raw.trim().match(ITEM);
    if (current && item) found[current].push(item[1].trim());
  }
  return found;
}

/**
 * @param {string} text a report or PR body
 * @returns {{ok: boolean, problems: string[], openQuestions: string[]}}
 */
export function checkLedger(text) {
  const lines = section(text ?? '');
  if (!lines) return { ok: false, problems: ['No "## Asked vs delivered" section.'], openQuestions: [] };
  const problems = [];
  if (!lines.some((l) => /^>\s*\S/.test(l.trim()) && !STARTS_WITH_PLACEHOLDER.test(l.trim().replace(/^>\s*/, '')))) problems.push("It doesn't quote the owner's request (a line starting with >).");
  const found = labelled(lines);
  const delivered = (found.delivered ?? []).filter((t) => !isEmpty(t));
  if (!found.delivered) problems.push('No "Delivered:" list.');
  else if (!delivered.length) problems.push('"Delivered:" lists nothing.');
  if (!found.notAsked) problems.push('No "Not asked, suggested:" line (write "none" if there is nothing).');
  if (!found.questions) problems.push('No "Open questions for the owner:" line (write "none" if there are none).');
  const verdictLine = lines
    .map((l) => bare(l.trim().replace(/^>\s*/, '')))
    .filter((l) => VERDICT.test(l))
    .pop();
  const [, word = '', rest = ''] = verdictLine?.match(VERDICT) ?? [];
  const verdict = word.replace(/[.,;]$/, '').toLowerCase();
  if (!verdictLine) problems.push('No "Scope review: pass (<reviewer>, <model>)" line from an independent scope review.');
  else if (verdict !== 'pass') problems.push(`The last scope review line says "${verdictLine}", not pass.`);
  else if (!/\w/.test(rest.replace(/<[^<>]*>/g, ''))) problems.push(`"${verdictLine}" doesn't name the reviewer and model that passed it.`);
  const openQuestions = (found.questions ?? []).filter((t) => !isEmpty(t));
  if ([...(found.delivered ?? []), ...(found.notAsked ?? []), ...(found.questions ?? [])].some((t) => STARTS_WITH_PLACEHOLDER.test(t.trim()))) {
    problems.push('It still has template placeholders (<...>); fill them in or write "none".');
  }
  return { ok: problems.length === 0, problems, openQuestions };
}

/** Worker PRs opened before this date only get a "needs scope section" note, not a block. */
export const SCOPE_RULE_SINCE = '2026-11-10T03:00:00Z';
const BOT = /\[bot\]$|^(dependabot|renovate|github-actions)\b/i;
// Worker sessions sign their PR bodies; the owner's own PRs don't carry the line.
const WORKER_SIGNATURE = /Generated with \[Claude Code\]/i;

/**
 * Which PRs the rule covers: worker PRs only. Bot PRs and the owner's own (unsigned) PRs are exempt.
 * @param {{body?: unknown, author?: {login?: string, is_bot?: boolean} | null, createdAt?: string | null}} pr raw `gh pr list` JSON
 * @returns {{scopeProblems: string[] | null, scopeNeeded: boolean}} problems that block the PR, or a note-only flag
 */
export function scopeStatus(pr) {
  const none = { scopeProblems: null, scopeNeeded: false };
  if (typeof pr.body !== 'string') return none;
  if (pr.author?.is_bot || BOT.test(pr.author?.login ?? '')) return none;
  if (!WORKER_SIGNATURE.test(pr.body)) return none;
  const { problems } = checkLedger(pr.body);
  if (!problems.length) return none;
  if (pr.createdAt && Date.parse(pr.createdAt) < Date.parse(SCOPE_RULE_SINCE)) return { scopeProblems: null, scopeNeeded: true };
  return { scopeProblems: problems, scopeNeeded: false };
}

function readInput(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  const pr = flag('--pr');
  if (pr) {
    const m = pr.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
    if (!m) throw new Error(`--pr wants owner/repo#N, got "${pr}"`);
    const r = spawnSync(process.env.GH_BIN || 'gh', ['pr', 'view', m[2], '-R', m[1], '--json', 'body', '--jq', '.body'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`gh pr view failed: ${(r.stderr || r.error?.message || '').split('\n')[0]}`);
    return r.stdout;
  }
  const file = flag('--file');
  return readFileSync(file ?? 0, 'utf8');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let text;
  try {
    text = readInput(process.argv.slice(2));
  } catch (e) {
    console.error(`scope-check: ${e.message}`);
    process.exit(2);
  }
  const { ok, problems, openQuestions } = checkLedger(text);
  if (!ok) {
    console.log('scope-check: FAIL. Not ready for the owner:');
    for (const p of problems) console.log(`- ${p}`);
    console.log('The section\'s shape is in skills/scope-review/SKILL.md.');
    process.exit(1);
  }
  console.log('scope-check: pass.');
  if (openQuestions.length) {
    console.log('Ask the owner before calling it done:');
    for (const q of openQuestions) console.log(`- ${q}`);
  }
}
