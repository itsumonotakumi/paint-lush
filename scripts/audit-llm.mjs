#!/usr/bin/env node
// Static checks for problems LLM workers tend to introduce. Exits 1 on any finding.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const everywhere = [
  [/from\s+['"]https?:/, 'remote import'],
  [/<script\s+src/, 'script tag'],
  [/unpkg|jsdelivr|cdnjs/, 'CDN reference'],
  [/\beval\s*\(|new\s+Function\s*\(/, 'dynamic code'],
  [/\.innerHTML|\.outerHTML|insertAdjacentHTML/, 'HTML injection sink'],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/, 'network access'],
  [/postMessage|addEventListener\(\s*['"]message['"]/, 'message channel'],
  [/JSON\.parse\(\s*(localStorage|storage)/, 'unvalidated storage parse'],
  [/@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable/, 'checker suppression'],
  [/\bas\s+unknown\s+as\b|:\s*any\b|<any>|\bas\s+any\b/, 'type escape'],
  [/console\.(log|debug|info)/, 'console output'],
  [/スプラトゥーン|splatoon|nintendo|任天堂/i, 'IP denylist'],
];
const headless = [
  [/Math\.random/, 'unseeded random in simulation'],
  [/from\s+['"]three/, 'three in headless layer'],
  [/\b(window|document|localStorage|navigator)\./, 'browser global in headless layer'],
  [/Date\.now|performance\.now/, 'wall clock in simulation'],
];
const testsOnly = [
  [/\b(it|test|describe)\.(skip|only|todo)\b/, 'disabled or focused test'],
  [/expect\(\s*true\s*\)/, 'vacuous assertion'],
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(ts|mjs|js|json|html)$/.test(name)) yield path;
  }
}

let findings = 0;
for (const file of walk('src')) {
  const isTest = file.endsWith('.test.ts');
  const isHeadless = /^src\/(core|game)\//.test(file);
  const isServiceWorker = file.startsWith('src/sw/');
  const base = isServiceWorker ? everywhere.filter(([, label]) => label !== 'network access') : everywhere;
  const rules = [...base, ...(isHeadless ? headless : []), ...(isTest ? testsOnly : [])];
  readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
    const isComment = /^\s*(\*|\/\/|\/\*)/.test(line);
    for (const [pattern, label] of rules) {
      // Comments may use the English word "any"; negative assertions in service worker tests may name banned APIs.
      if (label === 'type escape' && isComment) continue;
      if (label === 'wall clock in simulation' && isTest) continue;
      if (label === 'message channel' && isServiceWorker && isTest && line.includes('.not.')) continue;
      if (pattern.test(line)) {
        findings += 1;
        process.stdout.write(`${file}:${index + 1}: ${label}: ${line.trim()}\n`);
      }
    }
  });
}
const EXPECTED_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const html = readFileSync('index.html', 'utf8');
if (!html.includes(EXPECTED_CSP)) {
  findings += 1;
  process.stdout.write('index.html: CSP differs from the approved policy\n');
}
if ((html.match(/<script/g) ?? []).length !== 1 || !html.includes('src="/src/main.ts"')) {
  findings += 1;
  process.stdout.write('index.html: unexpected script tag\n');
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
for (const [name, entry] of Object.entries(lock.packages)) {
  if (name !== '' && !String(entry.resolved ?? '').startsWith('https://registry.npmjs.org/')) {
    findings += 1;
    process.stdout.write(`package-lock.json: non-registry source for ${name}\n`);
  }
}
process.stdout.write(`audit-llm: ${findings} finding(s)\n`);
process.exit(findings === 0 ? 0 : 1);
