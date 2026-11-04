"""Digest of recent Claude Code sessions, for the daily harness review.

Reads ~/.claude/projects/*/*.jsonl and prints markdown: per project, what the
user asked, which messages look like corrections or repeated asks, permission
denials, interruptions and context resets, plus what harness the project
already has (CLAUDE.md, allowlist, skills, memory).

    python3 -I digest.py              # last 24 hours
    python3 -I digest.py --hours 72
"""

import argparse
import collections
import datetime as dt
import glob
import json
import os
import re

HOME = os.path.expanduser("~")
PROJECTS = os.path.join(HOME, ".claude", "projects")
SKIP_CWD = ("claude-harness", "scheduled-tasks")  # the review's own sessions

SIGNALS = [
    ("broken", r"\b(broken|doesn'?t work|not working|isn'?t working|still (the same|broken|not|doesn'?t)|no .* loading|fails?)\b"),
    ("redo", r"\b(go back|revert|undo|looks (horrible|bad|the same)|disgusting|hate)\b"),
    ("verify", r"\b(is it (deployed|working|tested|ready|fixed|solid)|fully (tested|working)|are we sure|make sure)\b"),
    ("ritual", r"\b(run (unslop|pstack|all the unslop|the tests?)|push to vercel|deploy it)\b"),
    ("confused", r"(\?\?|\bwhy (is|does|are|isn'?t)\b|what does .* mean|i don'?t (know|understand))"),
    ("again", r"\b(again|still|try again|keeps?)\b"),
]
SECRET = re.compile(
    r"(AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|re_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9._-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)"
)


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


def clean(text):
    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.S)
    text = re.sub(r"<pasted_content[^>]*>.*?</pasted_content>", "[pasted text]", text, flags=re.S)
    text = SECRET.sub("[REDACTED]", text)
    return re.sub(r"\s+", " ", text).strip()


def project_root(cwd):
    """The git repo a folder belongs to, so sessions that ended in a subfolder group with their project."""
    d = cwd
    while d and d != os.path.dirname(d):
        if os.path.exists(os.path.join(d, ".git")):
            return d
        d = os.path.dirname(d)
    return cwd


def harness_of(cwd):
    if not cwd or not os.path.isdir(cwd):
        return "folder not found"
    have = []
    for name in ("CLAUDE.md", "AGENTS.md", "DESIGN.md", "VOICE.md"):
        if os.path.exists(os.path.join(cwd, name)):
            have.append(name)
    settings = os.path.join(cwd, ".claude", "settings.json")
    if os.path.exists(settings):
        try:
            allow = json.load(open(settings)).get("permissions", {}).get("allow", [])
            have.append("allowlist (%d rules)" % len(allow))
        except Exception:
            have.append("settings.json (unreadable)")
    skills = sorted(os.path.basename(os.path.dirname(p)) for p in glob.glob(os.path.join(cwd, ".claude", "skills", "*", "SKILL.md")))
    if skills:
        have.append("skills: " + ", ".join(skills))
    mem = os.path.join(PROJECTS, cwd.replace("/", "-").replace(".", "-"), "memory")
    notes = [f for f in glob.glob(os.path.join(mem, "*.md")) if not f.endswith("MEMORY.md")]
    if notes:
        have.append("%d memory notes" % len(notes))
    return ", ".join(have) or "nothing"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=24)
    args = ap.parse_args()
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=args.hours)

    seen = set()
    projects = collections.OrderedDict()
    for f in sorted(glob.glob(os.path.join(PROJECTS, "*", "*.jsonl")), key=os.path.getmtime):
        if dt.datetime.fromtimestamp(os.path.getmtime(f), dt.timezone.utc) < since:
            continue
        title, cwd = None, None
        prompts, denials, interrupts, resets = [], 0, 0, 0
        for line in open(f, errors="ignore"):
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if d.get("type") == "custom-title":
                title = d.get("customTitle") or title
            cwd = d.get("cwd") or cwd
            ts = d.get("timestamp")
            if not ts or dt.datetime.fromisoformat(ts.replace("Z", "+00:00")) < since:
                continue
            uid = d.get("uuid")
            if uid in seen:  # forked sessions repeat their parent's lines
                continue
            seen.add(uid)
            if d.get("type") != "user" or d.get("isSidechain") or d.get("isMeta"):
                continue
            content = (d.get("message") or {}).get("content")
            if isinstance(content, list):
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "tool_result":
                        r = json.dumps(c.get("content"))[:600]
                        if "Permission for this action was denied" in r or "doesn't want to proceed" in r:
                            denials += 1
            raw = text_of(content)
            if "[Request interrupted" in raw:
                interrupts += 1
                continue
            if raw.startswith("This session is being continued from a previous conversation"):
                resets += 1
                continue
            t = clean(raw)
            if not t or t.startswith("<") or len(t) < 2:
                continue
            tags = [name for name, rx in SIGNALS if re.search(rx, t, re.I)]
            prompts.append((ts[11:16], tags, t[:500]))
        if not prompts and not denials:
            continue
        if cwd and any(s in cwd for s in SKIP_CWD):
            continue
        key = project_root(cwd) if cwd else "unknown folder"
        p = projects.setdefault(key, {"sessions": []})
        p["sessions"].append({"title": title or os.path.basename(f)[:8], "prompts": prompts,
                              "denials": denials, "interrupts": interrupts, "resets": resets})

    print("# Session digest: last %g hours (to %s)\n" % (args.hours, dt.datetime.now().strftime("%Y-%m-%d %H:%M")))
    if not projects:
        print("No sessions in this window.")
        return
    for cwd, p in projects.items():
        name = cwd.replace(HOME, "~")
        if "scratch-workspaces" in cwd:
            name = "(no folder) " + name.rsplit("/", 1)[-1]
        print("## %s\n" % name)
        print("Harness: %s\n" % harness_of(cwd))
        for s in p["sessions"]:
            flagged = sum(1 for _, tags, _ in s["prompts"] if tags)
            print("### %s\n" % s["title"])
            print("%d messages, %d flagged, %d permission denials, %d interruptions, %d context resets\n"
                  % (len(s["prompts"]), flagged, s["denials"], s["interrupts"], s["resets"]))
            for hhmm, tags, t in s["prompts"]:
                mark = " **[%s]**" % ", ".join(tags) if tags else ""
                print("- %s%s %s" % (hhmm, mark, t))
            print()


if __name__ == "__main__":
    main()
