// Stop hook: while a session has the gate on (/until-ready), Claude can't end
// its turn until the project's checks pass. On failure it sends Claude back to
// work with the failing output. After the last try it lets Claude stop and
// report what still fails.
//
// Runs as a global Stop hook from ~/Projects/claude-harness/gate. Each project
// keeps its checks in .claude/gate.json:
//   { "env": {...}, "steps": [{ "name", "run" }], "serve": "cmd -p {port}",
//     "qa": "cmd {url}", "local": [untracked files], "rules": [lines],
//     "tries": 5 }
// A step can be the security audit: { "name": "security audit", "run": "node
// ~/Projects/claude-harness/gate/security-audit.mjs" } (see security-audit.mjs).
// Put it last: it can take 10 minutes of the hook's 30.
// "serve" and "qa" are optional: QA runs against the served local build.
// "rules" are project rules for the task (files not to touch, what not to run).
//
// The gate is per session: state lives in <main checkout>/.claude/loop/
// <session id>.json, written by until-ready.mjs, and names the folder the work
// is in (the main checkout or a worktree). Sessions without it stop normally.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const here = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

function mainCheckout(dir) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf8" }).trim();
    return dirname(resolve(dir, common));
  } catch {
    return dir;
  }
}

const stateFile = join(mainCheckout(here), ".claude", "loop", `${input.session_id}.json`);
if (!input.session_id || !existsSync(stateFile)) process.exit(0);

const deadFile = `${stateFile.replace(/\.json$/, "")}.deadends.md`;
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const block = (reason) => {
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
};

// The turn after a pass or a give-up is Claude's report. Let it end.
if (state.done) {
  rmSync(deadFile, { force: true });
  rmSync(stateFile, { force: true });
  process.exit(0);
}

// One run per stop, even if a project hook and the global hook both fire.
// A lock left by a run that was killed (hook timeout) names a dead pid: take it.
const lock = `${stateFile}.lock`;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const takeLock = () => { try { writeFileSync(lock, String(process.pid), { flag: "wx" }); return true; } catch { return false; } };
if (!takeLock()) {
  const holder = Number(readFileSync(lock, "utf8"));
  if (holder && alive(holder)) process.exit(0);
  rmSync(lock, { force: true });
  if (!takeLock()) process.exit(0);
}
let server = null;
process.on("exit", () => {
  if (server) try { process.kill(-server.pid); } catch {}
  rmSync(lock, { force: true });
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(1));

const dir = state.dir;
const configFile = join(dir, ".claude", "gate.json");
if (!existsSync(configFile)) {
  rmSync(stateFile, { force: true });
  process.exit(0);
}
const config = JSON.parse(readFileSync(configFile, "utf8"));
// "{random}" in an env value becomes a fresh secret each run (throwaway logins).
const env = { ...process.env };
for (const [k, v] of Object.entries(config.env || {})) env[k] = String(v).replaceAll("{random}", () => randomBytes(12).toString("hex"));
const max = state.max || config.tries || 5;
const tail = (text, n = 40) => text.trim().split("\n").slice(-n).join("\n");

// What a failure is, ignoring what changes between identical runs. The
// signature is the step, the failure count and the first three real error
// lines; two runs are a repeat only when all of it matches, so fixing some of
// the failures counts as progress.
const ERROR_LINE = /\b(not ok|fail(ed|ure|s)?|error|exception|assert\w*|cannot|unexpected|✗|✖)\b|^\s*(✗|✖|×)|^(GET|POST|PUT|PATCH|DELETE|HEAD) \S+.*\b[45]\d\d\b/i;
const PASSING = /^(ok\b|✔|✓|test result: ok)|\b0 (failed|failures?|errors?)\b|^#?\s*(ℹ )?(fail|pass)\s+0\b/i;
const NOISE = /^(npm (warn|notice)|warning\b|\(node:|console\.(error|warn|log|info)\b|deprecat)/i;
const FAILURE_START = /^(not ok\b|✖|✗|×|FAIL\b)/;
// Only roots that change between runs or machines: temp dirs, home, the checkout.
const roots = [[dir, "<checkout>"], [mainCheckout(dir), "<checkout>"], [homedir(), "<home>"], [realpathSync(tmpdir()), "<tmp>"], [tmpdir(), "<tmp>"]]
  .filter(([r]) => r && r.length > 1)
  .sort((x, y) => y[0].length - x[0].length);
function normalizeLine(line) {
  for (const [root, name] of roots) line = line.replaceAll(root, name);
  return line
    .replace(/(\/private)?\/(tmp|var\/tmp|var\/folders\/[^/\s]+\/[^/\s]+\/T)\/[^/\s:)"']+/g, "<tmp>")
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(:\d\d(\.\d+)?)?Z?/g, "<time>")
    .replace(/\b\d{1,2}:\d\d:\d\d(\.\d+)?\b/g, "<time>")
    .replace(/\(?\b\d+(\.\d+)?\s?(ms|seconds?|secs?|min)\b\)?|\(?\b\d+(\.\d+)?(s|m)\b\)?/gi, "<dur>")
    .replace(/\b(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+/g, "$1:<port>")
    .replace(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
function signature(stepName, out) {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const real = lines.filter((l) => !PASSING.test(l) && !NOISE.test(l) && ERROR_LINE.test(l));
  const shown = (real.length ? real : lines.slice(-1)).slice(0, 3).map(normalizeLine);
  const count = lines.filter((l) => FAILURE_START.test(l)).length;
  return `${stepName.replace(/ \(.*/, "")}: ${count} failing | ${shown.join(" | ")}`;
}

function sh(cmd) {
  const r = spawnSync("sh", ["-c", cmd], { cwd: dir, env, encoding: "utf8", maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}` };
}

function freePort(port) {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(freePort(port + 1)));
    s.listen(port, () => s.close(() => ok(port)));
  });
}

async function qa() {
  if (!config.serve) return sh(config.qa);
  const port = await freePort(3131);
  const url = `http://localhost:${port}`;
  server = spawn("sh", ["-c", config.serve.replaceAll("{port}", port)], { cwd: dir, env, stdio: "ignore", detached: true });
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      up = await fetch(url).then((r) => r.status < 500, () => false);
    }
    if (!up) return { ok: false, out: `"${config.serve}" on port ${port} never answered` };
    return sh(config.qa.replaceAll("{url}", url));
  } finally {
    try { process.kill(-server.pid); } catch {}
    server = null;
  }
}

const steps = (config.steps || []).map((s) => [s.name, () => sh(s.run)]);
if (config.qa) steps.push([`QA (${config.qa})`, qa]);

let failed = null;
let summary = "";
for (const [name, run] of steps) {
  const r = await run();
  if (!r.ok) { failed = { name, out: r.out }; break; }
  summary = tail(r.out, 8);
}

state.attempts = (state.attempts || 0) + 1;
const rules = (config.rules || []).map((r) => `- ${r}`).join("\n");
const goal = `Goal: ${state.goal}${rules ? `\nProject rules:\n${rules}` : ""}`;
const names = steps.map(([n]) => n.replace(/ \(.*/, "")).join(", ");
if (!failed) {
  state.done = true;
  rmSync(deadFile, { force: true });
  block(`Gate passed (${names}) in ${dir}.\n${summary}\n\n${goal}\nFinish as the until-ready skill says (on a task branch: commit, push the branch, open a PR), then write the report with these QA lines. Don't change more code.`);
}
const sig = signature(failed.name, failed.out);
const repeated = state.lastSignature === sig;
state.lastSignature = sig;
let deadEnds = "";
try { deadEnds = readFileSync(deadFile, "utf8").trim(); } catch {}
if (deadEnds.length > 4096) deadEnds = `...${deadEnds.slice(-4096)}`;
const deadBlock = deadEnds ? `\n\nDead ends so far (don't repeat these):\n${deadEnds}` : "";
const giveUp = (why) => {
  state.done = true;
  rmSync(deadFile, { force: true });
  block(`Gate: "${failed.name}" ${why} Stop and report to the owner: the goal, what is blocking you, what you tried, and this output. Push the branch and open a draft PR (--draft) so the work isn't lost.${deadBlock}\n\n${tail(failed.out)}`);
};
if (state.attempts >= max) giveUp(`still fails after ${max} tries.`);
if (repeated) giveUp(`failed the same way twice in a row (${sig}), so more tries won't help.`);
block(`Gate, try ${state.attempts} of ${max}: "${failed.name}" failed in ${dir}. ${goal}\nFix the cause, never the check, then end your turn again and the gate reruns.\nBefore you end your turn, append one line to ${deadFile} saying what you tried and what came of it, so later tries don't repeat it.${deadBlock}\n\n${tail(failed.out)}`);
