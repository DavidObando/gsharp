#!/usr/bin/env python3
"""Error-recovery soak for the G# language server (opt-in; never a CI gate).

Why this exists
---------------
The compiler is being migrated from C# to G# with cs2gs. The migrated tree turns
every C# null-forgiving `!` into G#'s `!!`, which is a real runtime null check.
Error-recovery paths (truncated or half-edited documents) are where null
tolerance hides and where the unit tests are thinnest, so a crash that never
happens in the C#-built language server can appear in the G#-built one. This
harness drives a language server over stdio JSON-RPC exactly as an editor would,
on large real files and on deterministic broken variants of them, and records
every crash and every latency. Because it only speaks LSP, the same plan runs
unchanged against the native (C#-built) server and a migrated (G#-built) one,
and `compare` lines the two up step by step.

What counts as a crash
----------------------
  process-exit    the server process died before the soak finished.
  rpc-error       a request came back with a JSON-RPC error other than
                  "request cancelled" (-32800) or "content modified" (-32801).
                  "method not found" (-32601) is a harness bug and aborts.
  logged-exception an Error-level entry in the server's `--log` file. The
                  server's handlers catch exceptions and degrade to "no
                  result" (issue #816), so this is the only place a swallowed
                  handler or background-bind exception is visible.
  ice             a GS9998 (internal compiler error) diagnostic in a pull
                  diagnostic report or a publishDiagnostics notification.
A request that does not answer within --request-timeout is recorded as a
`timeout` (a hang, reported separately, not counted as a crash); the server is
then restarted so the remaining steps still run.

Plan and steps
--------------
`plan` is a pure function of (file contents, seed), written to plan.json before
anything runs, so two servers fed the same plan see byte-identical documents.
Per file:
  open-full        didOpen with the whole file.
  truncate-*       the document cut at targeted offsets (mid-identifier,
                   mid-string, mid-generic-argument-list `Name[Ar|`, between
                   the two `!` of `!!`, after `{`, after `(`), at 10/50/90%,
                   and at seeded random offsets.
  delete-lines-*   seeded random line ranges removed.
  delete-brace-*   single closing braces removed, plus every `}` in the last
                   5% of the file.
  garbage-*        unterminated strings/comments/raw strings, bracket soup,
                   `!!!!`, stray `@`, and similar inserted at seeded offsets.
  edit-*           restore the file, then type a new parameter into a function
                   signature one keystroke at a time, backspace it out again,
                   and rename the function and undo; each keystroke is a
                   didChange followed by the requests an editor sends while
                   typing (diagnostics, completion and hover at the caret).
Every non-keystroke step requests: textDocument/diagnostic, documentSymbol,
semanticTokens/full, foldingRange, formatting, inlayHint around the focus, and
hover/completion/definition/documentHighlight at the focus and at seeded
identifier positions. didChange always carries the whole document (the server
advertises full sync and takes the last change's text as the new document).

Usage
-----
  # 1. build the server(s); 2. make a plan from the N largest files of a tree
  python3 build/lsp-soak.py plan --tree ~/.cache/gsharp-assess/migrated/polished \\
      --largest 6 --seed 4242 --out ~/.cache/soak/plan.json \\
      --meta tree-run=36906270739 --meta tree-head=c431739
  # 3. run it against a server (one process per file; logs under --out)
  python3 build/lsp-soak.py run --plan ~/.cache/soak/plan.json --label native \\
      --server "dotnet out/bin/Release/LanguageServer/GSharp.LanguageServer.dll" \\
      --out ~/.cache/soak/native
  # 4. compare two runs of the same plan
  python3 build/lsp-soak.py compare ~/.cache/soak/native/summary.json \\
      ~/.cache/soak/migrated/summary.json --out ~/.cache/soak/compare.md

`plan --sample N --min-lines A --max-lines B` picks a seeded sample of
mid-sized files instead of the largest ones. `run --skip-method M` (repeatable)
leaves a request out of every step. The language server's semantic model
build does not finish on the largest migrated files (issue #4659), so on those
files every model-backed request (semanticTokens/full, inlayHint, hover,
completion, definition, documentHighlight) times out. Until that is fixed, soak
the largest files with those methods skipped and a mid-sized sample with the
full set.

`run --no-log` skips the server's `--log` file. Use it for latency numbers:
`--log` makes the server echo every message (whole documents included) into
the log, which inflates timings. Without it, logged-exception detection is off
and only process-exit, rpc-error and ice are seen.

Keep --out off /tmp: the per-file server logs hold every document sent.

The harness's own crash classification is covered by build/test-lsp-soak.py
(a stub server misbehaving on each channel). Neither file runs in CI.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import queue
import random
import re
import shlex
import statistics
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PLAN_VERSION = 1
BENIGN_RPC_ERRORS = {-32800, -32801}
METHOD_NOT_FOUND = -32601
ICE_CODE = "GS9998"
# FileLogger writes one JSON object per line. System.Text.Json escapes every quote inside the
# message text, so this raw substring only occurs as a real key/value; it is a cheap prefilter,
# and the Level field of the parsed entry decides.
LOG_ERROR_MARKER = re.compile(rb'"Level"\s*:\s*"Error"')

GARBAGE = [
    '"unterminated',
    "/* unterminated comment",
    "`raw string never closed",
    "[[[[",
    "]]]]",
    "((((",
    "))))",
    "{{{{",
    "!!!!",
    "!!.!!",
    "@",
    "@@Attr(",
    "func (",
    "func F[T](x T) T where T :",
    "let = := ;",
    "$\"{",
    "?.?.??",
    "=> => =>",
    "\t  é中",
    "0x 1e+ 1_",
    "type X struct {",
    "import",
    "package",
]
TYPED_PARAMETER = "probe int, "
RENAME_SUFFIX = "Xyz"
IDENT = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]{3,}\b")


class HarnessError(Exception):
    """A defect in the harness or its inputs, not in the server under test."""


# ---------------------------------------------------------------------------
# Text and position helpers
# ---------------------------------------------------------------------------


def apply_edits(text: str, edits: list[list[Any]]) -> str:
    """Applies [offset, deleteLength, insertText] edits in order."""
    for offset, delete, insert in edits:
        if not 0 <= offset <= len(text) or offset + delete > len(text):
            raise HarnessError(f"edit [{offset}, {delete}] is outside a {len(text)}-char document")
        text = text[:offset] + insert + text[offset + delete:]
    return text


class LineIndex:
    """Maps character offsets to LSP (line, UTF-16 character) positions."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.starts = [0]
        for i, ch in enumerate(text):
            if ch == "\n":
                self.starts.append(i + 1)

    def position(self, offset: int) -> dict[str, int]:
        offset = max(0, min(offset, len(self.text)))
        lo, hi = 0, len(self.starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.starts[mid] <= offset:
                lo = mid
            else:
                hi = mid - 1
        segment = self.text[self.starts[lo]:offset]
        return {"line": lo, "character": len(segment.encode("utf-16-le")) // 2}

    @property
    def line_count(self) -> int:
        return len(self.starts)


# ---------------------------------------------------------------------------
# Plan generation (pure: file text + seed -> steps)
# ---------------------------------------------------------------------------


def _pick(rng: random.Random, matches: list[re.Match[str]]) -> re.Match[str] | None:
    return rng.choice(matches) if matches else None


def _probe_offsets(rng: random.Random, text: str, focus: int, count: int) -> list[int]:
    """The focus plus seeded identifier positions near it and anywhere in the text."""
    offsets = [max(0, min(focus, len(text)))]
    near = [m for m in IDENT.finditer(text, max(0, focus - 4000), min(len(text), focus + 4000))]
    anywhere = list(IDENT.finditer(text)) if len(text) < 2_000_000 else []
    for pool in (near, anywhere):
        for _ in range(count):
            m = _pick(rng, pool)
            if m is not None:
                offsets.append(m.start() + (m.end() - m.start()) // 2)
    return offsets


def _truncation_points(rng: random.Random, text: str, random_count: int) -> list[tuple[str, int]]:
    points: list[tuple[str, int]] = []
    targeted = [
        ("mid-identifier", r"\b[A-Za-z_][A-Za-z0-9_]{7,}\b", lambda m: m.start() + (m.end() - m.start()) // 2),
        ("mid-string", r'"[^"\n\\]{6,}"', lambda m: m.start() + 3),
        ("mid-generic-args", r"\b[A-Z][A-Za-z0-9_]*\[[A-Z][A-Za-z0-9_]{2,}", lambda m: m.end() - 1),
        ("mid-bangbang", r"[A-Za-z0-9_)\]]!!", lambda m: m.end() - 1),
        ("after-open-brace", r"\{\n", lambda m: m.start() + 1),
        ("after-open-paren", r"\w\((?=\w)", lambda m: m.end()),
    ]
    for name, pattern, cut in targeted:
        m = _pick(rng, list(re.finditer(pattern, text)))
        if m is not None:
            points.append((name, cut(m)))
    for fraction in (10, 50, 90):
        points.append((f"at-{fraction}pct", len(text) * fraction // 100))
    for i in range(random_count):
        points.append((f"random-{i}", rng.randrange(1, len(text)) if len(text) > 1 else 0))
    return points


def _signature_edit_steps(rng: random.Random, text: str) -> tuple[list[dict[str, Any]], int]:
    """Type a parameter into a function signature, delete it, rename the function and undo."""
    signatures = list(re.finditer(r"(?m)^[ \t]*(?:[a-z]+ )*func ([A-Za-z_][A-Za-z0-9_]*)\(", text))
    m = _pick(rng, signatures)
    if m is None:
        return [], 0
    caret = m.end()
    name_end = m.end(1)
    steps: list[dict[str, Any]] = []
    edits: list[list[Any]] = []
    for i, ch in enumerate(TYPED_PARAMETER):
        edits.append([caret + i, 0, ch])
        steps.append({"kind": "edit-type-param", "edits": list(edits), "focus": caret + i + 1, "keystroke": True})
    for i in range(len(TYPED_PARAMETER)):
        at = caret + len(TYPED_PARAMETER) - i - 1
        edits.append([at, 1, ""])
        steps.append({"kind": "edit-backspace-param", "edits": list(edits), "focus": at, "keystroke": True})
    for i, ch in enumerate(RENAME_SUFFIX):
        edits.append([name_end + i, 0, ch])
        steps.append({"kind": "edit-rename", "edits": list(edits), "focus": name_end + i + 1, "keystroke": True})
    edits.append([name_end, len(RENAME_SUFFIX), ""])
    steps.append({"kind": "edit-undo-rename", "edits": list(edits), "focus": name_end, "keystroke": False})
    return steps, m.start()


def plan_file(path: Path, seed: int, truncations: int, line_deletions: int, brace_deletions: int,
              garbage: int, probes: int) -> dict[str, Any]:
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HarnessError(f"{path} is not UTF-8: {exc}") from exc
    rng = random.Random(f"{seed}:{hashlib.sha256(raw).hexdigest()}")
    steps: list[dict[str, Any]] = [{"kind": "open-full", "edits": [], "focus": 0, "keystroke": False}]

    for name, offset in _truncation_points(rng, text, truncations):
        steps.append({"kind": f"truncate-{name}", "edits": [[offset, len(text) - offset, ""]],
                      "focus": max(0, offset - 1), "keystroke": False})

    line_starts = LineIndex(text).starts
    for i in range(line_deletions if len(line_starts) > 1 else 0):
        first = rng.randrange(0, len(line_starts) - 1)
        span = rng.randint(1, 40)
        last = min(len(line_starts) - 1, first + span)
        start, end = line_starts[first], line_starts[last]
        steps.append({"kind": f"delete-lines-{i}", "edits": [[start, end - start, ""]],
                      "focus": start, "keystroke": False})

    braces = [i for i, ch in enumerate(text) if ch == "}"]
    for i in range(min(brace_deletions, len(braces))):
        at = rng.choice(braces)
        steps.append({"kind": f"delete-brace-{i}", "edits": [[at, 1, ""]], "focus": at, "keystroke": False})
    tail_start = len(text) * 95 // 100
    tail_edits = [[at, 1, ""] for at in reversed(braces) if at >= tail_start]
    if tail_edits:
        steps.append({"kind": "delete-brace-tail", "edits": tail_edits, "focus": tail_start, "keystroke": False})

    for i in range(garbage):
        at = rng.randrange(0, len(text) + 1)
        junk = GARBAGE[rng.randrange(len(GARBAGE))]
        steps.append({"kind": f"garbage-{i}", "edits": [[at, 0, junk]], "focus": at + len(junk), "keystroke": False})

    steps.append({"kind": "restore-full", "edits": [], "focus": 0, "keystroke": False})
    edit_steps, _ = _signature_edit_steps(rng, text)
    steps.extend(edit_steps)

    for index, step in enumerate(steps):
        step["id"] = f"{index:03d}-{step['kind']}"
        doc = apply_edits(text, step["edits"])
        step["focus"] = max(0, min(step["focus"], len(doc)))
        count = 0 if step["keystroke"] else probes
        step["probes"] = _probe_offsets(rng, doc, step["focus"], count)[: 1 + 2 * count]
        step["sha256"] = hashlib.sha256(doc.encode("utf-8")).hexdigest()
    return {
        "path": str(path.resolve()),
        "name": path.name,
        "bytes": len(raw),
        "lines": len(text.splitlines()),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "steps": steps,
    }


def parse_pairs(option: str, items: list[str]) -> dict[str, str]:
    pairs = {}
    for item in items:
        key, sep, value = item.partition("=")
        if not sep or not key:
            raise HarnessError(f"{option} must be KEY=VALUE (got: {item!r})")
        if key in pairs:
            raise HarnessError(f"{option} sets {key!r} twice")
        pairs[key] = value
    return pairs


def file_id(entry: dict[str, Any]) -> str:
    return entry.get("id") or Path(entry["name"]).stem


def find_largest(tree: Path, largest: int) -> list[Path]:
    candidates = [p for p in tree.rglob("*.gs") if p.is_file()]
    candidates.sort(key=lambda p: (-p.stat().st_size, str(p)))
    return candidates[:largest]


def count_lines(path: Path, stop_after: int) -> int:
    """Lines in the file (a final line without a newline counts), or stop_after + 1 once exceeded."""
    lines, last = 0, b"\n"
    with path.open("rb") as stream:
        while chunk := stream.read(1 << 20):
            lines += chunk.count(b"\n")
            last = chunk[-1:]
            if lines > stop_after:
                return stop_after + 1
    return lines + (0 if last == b"\n" else 1)


def sample_band(tree: Path, count: int, min_lines: int, max_lines: int, seed: int) -> list[Path]:
    """A seeded sample of .gs files whose line count lies in [min_lines, max_lines]."""
    band = []
    for p in sorted(tree.rglob("*.gs")):
        if not p.is_file():
            continue
        lines = count_lines(p, stop_after=max_lines)
        if min_lines <= lines <= max_lines:
            band.append(p)
    rng = random.Random(f"sample:{seed}")
    chosen = rng.sample(band, min(count, len(band)))
    return sorted(chosen, key=lambda p: (-p.stat().st_size, str(p)))


def cmd_plan(args: argparse.Namespace) -> int:
    files = [Path(f) for f in args.files]
    if args.tree:
        tree = Path(args.tree).expanduser()
        if args.sample:
            files += sample_band(tree, args.sample, args.min_lines, args.max_lines, args.seed)
        else:
            files += find_largest(tree, args.largest)
    if not files:
        raise HarnessError("no input files: pass --tree and/or file paths")
    meta = parse_pairs("--meta", args.meta)
    plan = {
        "version": PLAN_VERSION,
        "seed": args.seed,
        "created": datetime.now(timezone.utc).isoformat(),
        "tree": str(Path(args.tree).expanduser().resolve()) if args.tree else None,
        "meta": meta,
        "files": [
            plan_file(f.expanduser(), args.seed, args.truncations, args.line_deletions,
                      args.brace_deletions, args.garbage, args.probes)
            for f in files
        ],
    }
    for i, entry in enumerate(plan["files"]):
        # Unique per plan even when two files share a basename; names the output files.
        entry["id"] = f"{i:02d}-{Path(entry['name']).stem}"
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, indent=1) + "\n", encoding="utf-8")
    total = sum(len(f["steps"]) for f in plan["files"])
    print(f"plan: {len(plan['files'])} file(s), {total} step(s) -> {out}")
    for f in plan["files"]:
        print(f"  {f['lines']:>6} lines  {len(f['steps']):>3} steps  {f['path']}")
    return 0


# ---------------------------------------------------------------------------
# LSP client over stdio
# ---------------------------------------------------------------------------


class ServerExited(Exception):
    def __init__(self, code: int | None, stderr: str) -> None:
        super().__init__(f"server exited (code {code})")
        self.code = code
        self.stderr = stderr


class RequestTimeout(Exception):
    pass


class LspClient:
    def __init__(self, command: list[str], log_path: Path | None, cwd: Path,
                 env: dict[str, str] | None = None) -> None:
        argv = list(command)
        if log_path is not None:
            argv.append(f"--log={log_path}")
        self.process = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd,
            env={**os.environ, **env} if env else None)
        self.next_id = 0
        self.pending: dict[int, queue.Queue[dict[str, Any]]] = {}
        self.lock = threading.Lock()
        # Requests go out from the main thread, acknowledgements of server-to-client requests
        # from the reader thread; one writer at a time keeps the framing intact.
        self.send_lock = threading.Lock()
        self.notifications: list[dict[str, Any]] = []
        self.stderr_tail: collections.deque[str] = collections.deque(maxlen=200)
        self.closed = threading.Event()
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    # -- transport -----------------------------------------------------------

    def _send(self, message: dict[str, Any]) -> None:
        body = json.dumps(message, ensure_ascii=False).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        stdin = self.process.stdin
        if stdin is None:
            raise HarnessError("server stdin is not a pipe")
        try:
            with self.send_lock:
                stdin.write(header + body)
                stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise self._exited() from exc

    def _read_stdout(self) -> None:
        stream = self.process.stdout
        if stream is None:
            raise HarnessError("server output is not a pipe")
        try:
            while True:
                length = None
                while True:
                    line = stream.readline()
                    if not line:
                        return
                    line = line.strip()
                    if not line:
                        break
                    name, _, value = line.decode("ascii", "replace").partition(":")
                    if name.lower() == "content-length":
                        length = int(value.strip())
                if length is None:
                    continue
                body = stream.read(length)
                if len(body) < length:
                    return
                self._dispatch(json.loads(body.decode("utf-8")))
        finally:
            self.closed.set()
            with self.lock:
                for q in self.pending.values():
                    q.put({"__closed__": True})

    def _read_stderr(self) -> None:
        stream = self.process.stderr
        if stream is None:
            raise HarnessError("server output is not a pipe")
        for raw in stream:
            self.stderr_tail.append(raw.decode("utf-8", "replace").rstrip())

    def _dispatch(self, message: dict[str, Any]) -> None:
        if "id" in message and "method" in message:
            # A server-to-client request (diagnostic refresh, registerCapability, progress
            # creation, ...): acknowledge it so the server never waits on the soak.
            self._send({"jsonrpc": "2.0", "id": message["id"], "result": None})
            return
        if "id" in message:
            with self.lock:
                q = self.pending.get(message["id"])
            if q is not None:
                q.put(message)
            return
        if message.get("method") == "textDocument/publishDiagnostics":
            with self.lock:
                self.notifications.append(message)

    def _exited(self) -> ServerExited:
        try:
            code = self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            code = None
        time.sleep(0.2)
        return ServerExited(code, "\n".join(list(self.stderr_tail)[-40:]))

    # -- API -----------------------------------------------------------------

    def notify(self, method: str, params: Any) -> None:
        if self.process.poll() is not None:
            raise self._exited()
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method: str, params: Any, timeout: float) -> dict[str, Any]:
        if self.process.poll() is not None:
            raise self._exited()
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            q: queue.Queue[dict[str, Any]] = queue.Queue()
            self.pending[rid] = q
        try:
            self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
            try:
                reply = q.get(timeout=timeout)
            except queue.Empty as exc:
                raise RequestTimeout(f"{method} did not answer within {timeout:.0f}s") from exc
            if reply.get("__closed__"):
                raise self._exited()
            return reply
        finally:
            with self.lock:
                self.pending.pop(rid, None)

    def drain_notifications(self) -> list[dict[str, Any]]:
        with self.lock:
            taken, self.notifications = self.notifications, []
        return taken

    def shutdown(self, timeout: float = 30) -> None:
        try:
            if self.process.poll() is None:
                self.request("shutdown", None, timeout)
                self.notify("exit", None)
                self.process.wait(timeout=timeout)
        except (ServerExited, RequestTimeout, subprocess.TimeoutExpired):
            pass
        finally:
            self.kill()

    def kill(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass


class LogScanner:
    """Reads Error-level entries appended to the server's FileLogger output.

    Entries are one JSON object per line (Timestamp, Level, Message, ...). A line is a candidate only if it carries a raw `"Level": "Error"` pair
    (quotes inside message text are escaped, so debug echoes of documents never do), and the
    parsed entry's Level field decides.
    """

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.offset = 0
        self.partial = b""

    def new_errors(self) -> list[dict[str, Any]]:
        if self.path is None or not self.path.exists():
            return []
        errors: list[dict[str, Any]] = []
        with self.path.open("rb") as stream:
            stream.seek(self.offset)
            chunk = stream.read()
            self.offset = stream.tell()
        data = self.partial + chunk
        lines = data.split(b"\n")
        self.partial = lines.pop()
        for line in lines:
            if not LOG_ERROR_MARKER.search(line):
                continue
            try:
                entry = json.loads(line.decode("utf-8", "replace"))
            except json.JSONDecodeError:
                # A torn or unparseable line that carries the marker: report it rather than lose it.
                errors.append({"Message": line[:400].decode("utf-8", "replace")})
                continue
            if isinstance(entry, dict) and entry.get("Level") == "Error":
                errors.append(entry)
        return errors


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


def _exception_frames(text: str | None, limit: int = 6) -> list[str]:
    if not text:
        return []
    frames = [ln.strip() for ln in text.splitlines() if ln.strip().startswith("at ")]
    return frames[:limit]


def _signature(crash: dict[str, Any]) -> str:
    """A step-independent identity used to group crashes and to compare servers."""
    kind = crash["kind"]
    if kind == "logged-exception":
        handler = (crash.get("message") or "").split(" failed:", 1)[0]
        return f"{kind}:{handler}:{crash.get('exceptionType')}"
    if kind == "rpc-error":
        return f"{kind}:{crash.get('method')}:{crash.get('code')}"
    if kind == "ice":
        return f"{kind}:{(crash.get('message') or '')[:80]}"
    return kind


def _ice_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    found = []
    for item in items or []:
        code = item.get("code")
        if isinstance(code, dict):
            code = code.get("value")
        if code == ICE_CODE:
            found.append(item)
    return found


class FileRun:
    """Runs one planned file against a fresh server process."""

    def __init__(self, args: argparse.Namespace, entry: dict[str, Any], out_dir: Path) -> None:
        self.args = args
        self.entry = entry
        self.out_dir = out_dir
        raw = Path(entry["path"]).read_bytes()
        self.base = raw.decode("utf-8-sig")
        if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
            raise HarnessError(f"{entry['path']} changed since the plan was made")
        self.uri = Path(entry["path"]).resolve().as_uri()
        self.log_path = None if args.no_log else out_dir / (file_id(entry) + ".server.log")
        if self.log_path is not None and self.log_path.exists():
            self.log_path.unlink()  # FileLogger appends; start every file from an empty log
        self.client: LspClient | None = None
        self.scanner = LogScanner(self.log_path)
        self.version = 0
        self.restarts = 0
        self.steps: list[dict[str, Any]] = []

    # -- server lifecycle --------------------------------------------------

    def start(self, text: str) -> None:
        self.client = LspClient(shlex.split(self.args.server, posix=os.name != "nt"), self.log_path,
                                Path.cwd(), parse_pairs("--server-env", self.args.server_env))
        root = self.args.workspace_root
        init = {
            "processId": os.getpid(),
            "rootUri": Path(root).resolve().as_uri() if root else None,
            "rootPath": str(Path(root).resolve()) if root else None,
            "capabilities": {
                "textDocument": {
                    "diagnostic": {"dynamicRegistration": False},
                    "hover": {"contentFormat": ["markdown", "plaintext"]},
                    "completion": {"completionItem": {"snippetSupport": True}},
                    "publishDiagnostics": {},
                },
                "workspace": {"diagnostics": {"refreshSupport": True}},
            },
        }
        self.client.request("initialize", init, self.args.request_timeout)
        self.client.notify("initialized", {})
        self.version += 1
        self.client.notify("textDocument/didOpen", {"textDocument": {
            "uri": self.uri, "languageId": "gsharp", "version": self.version, "text": text}})

    def restart(self, text: str) -> None:
        if self.client is not None:
            self.client.kill()
        self.restarts += 1
        self.client = None
        self.start(text)

    # -- one step ------------------------------------------------------------

    def run_step(self, step: dict[str, Any], text: str, first: bool) -> dict[str, Any]:
        record: dict[str, Any] = {"id": step["id"], "kind": step["kind"], "chars": len(text),
                                  "crashes": [], "timings": {}, "timeouts": []}
        index = LineIndex(text)
        doc = {"uri": self.uri}
        started = time.perf_counter()
        # The first step's document went out with didOpen (in start); later steps send a didChange.
        timing_key = "openToDiagnosticsMs" if first else "changeToDiagnosticsMs"
        try:
            if self.client is None:
                raise HarnessError("run_step called before the server was started")
            if not first:
                self.version += 1
                # Full sync: no range. The server adopts the last change's text as the document.
                change = {"text": text}
                self.client.notify("textDocument/didChange", {
                    "textDocument": {"uri": self.uri, "version": self.version}, "contentChanges": [change]})
            for method, params in self._requests(step, index, doc):
                if method in self.args.skip_method:
                    continue
                self._request(record, method, params,
                              (started, timing_key) if method == "textDocument/diagnostic" else None)
        except ServerExited as exc:
            record["crashes"].append({"kind": "process-exit", "code": exc.code, "stderr": exc.stderr})
            self._restart_within(record, text)
        except RequestTimeout as exc:
            record["timeouts"].append(str(exc))
            self._restart_within(record, text)
        record["elapsedMs"] = round((time.perf_counter() - started) * 1000, 1)
        self._collect_background(record, after_restart=record.get("restarted", False))
        return record

    def _restart_within(self, record: dict[str, Any], text: str) -> None:
        # What the failed process logged belongs to this step; anything logged from here on
        # comes from the replacement server's startup and is tagged so it isn't read as a
        # failure of this step's requests.
        self._collect_background(record)
        self.restart(text)
        record["restarted"] = True
        # One round trip so the new server has handled initialize/initialized/didOpen before
        # its log is read; its startup errors then land on this step, tagged.
        try:
            if self.client is not None:
                self.client.request("textDocument/documentSymbol", {"textDocument": {"uri": self.uri}},
                                    self.args.request_timeout)
        except ServerExited as exc:
            record["crashes"].append({"kind": "process-exit", "code": exc.code, "stderr": exc.stderr,
                                      "afterRestart": True})
        except RequestTimeout as exc:
            record["timeouts"].append(f"after restart: {exc}")
        self._collect_background(record, after_restart=True)

    def _requests(self, step: dict[str, Any], index: LineIndex, doc: dict[str, str]):
        caret = index.position(step["focus"])
        yield "textDocument/diagnostic", {"textDocument": doc}
        if step["keystroke"]:
            yield "textDocument/completion", {"textDocument": doc, "position": caret,
                                              "context": {"triggerKind": 1}}
            yield "textDocument/hover", {"textDocument": doc, "position": caret}
            return
        yield "textDocument/documentSymbol", {"textDocument": doc}
        yield "textDocument/semanticTokens/full", {"textDocument": doc}
        yield "textDocument/foldingRange", {"textDocument": doc}
        yield "textDocument/formatting", {"textDocument": doc, "options": {"tabSize": 4, "insertSpaces": True}}
        lo = max(0, caret["line"] - 50)
        hi = caret["line"] + 51  # exclusive end: the start of the line after the band, or EOF
        end = {"line": hi, "character": 0} if hi < index.line_count else index.position(len(index.text))
        yield "textDocument/inlayHint", {"textDocument": doc, "range": {
            "start": {"line": lo, "character": 0}, "end": end}}
        for offset in step["probes"]:
            position = index.position(offset)
            yield "textDocument/hover", {"textDocument": doc, "position": position}
            yield "textDocument/completion", {"textDocument": doc, "position": position,
                                              "context": {"triggerKind": 1}}
            yield "textDocument/definition", {"textDocument": doc, "position": position}
            yield "textDocument/documentHighlight", {"textDocument": doc, "position": position}

    def _request(self, record: dict[str, Any], method: str, params: Any,
                 since: tuple[float, str] | None) -> None:
        if self.client is None:
            raise HarnessError("request sent before the server was started")
        t0 = time.perf_counter()
        reply = self.client.request(method, params, self.args.request_timeout)
        ms = round((time.perf_counter() - t0) * 1000, 1)
        record["timings"].setdefault(method, []).append(ms)
        if since is not None:
            record[since[1]] = round((time.perf_counter() - since[0]) * 1000, 1)
        error = reply.get("error")
        if error is not None:
            code = error.get("code")
            if code == METHOD_NOT_FOUND:
                raise HarnessError(f"server does not implement {method}: {error}")
            if code not in BENIGN_RPC_ERRORS:
                record["crashes"].append({"kind": "rpc-error", "method": method, "code": code,
                                          "message": error.get("message"), "data": error.get("data")})
            return
        if method == "textDocument/diagnostic":
            result = reply.get("result") or {}
            items = result.get("items") or []
            record["diagnostics"] = len(items)
            for item in _ice_items(items):
                record["crashes"].append({"kind": "ice", "method": method, "message": item.get("message"),
                                          "range": item.get("range")})

    def _collect_background(self, record: dict[str, Any], after_restart: bool = False) -> None:
        if self.client is not None:
            for note in self.client.drain_notifications():
                for item in _ice_items(note.get("params", {}).get("diagnostics")):
                    record["crashes"].append({"kind": "ice", "method": "textDocument/publishDiagnostics",
                                              "message": item.get("message"), "range": item.get("range")})
        for entry in self.scanner.new_errors():
            message = entry.get("Message") or ""
            record["crashes"].append({
                "kind": "logged-exception",
                "message": message[:500],
                "exceptionType": entry.get("ExceptionType"),
                "frames": _exception_frames(entry.get("Exception")),
                "background": "SchedulePushDiagnosticsBind" in message or "Background" in message,
                "afterRestart": after_restart,
            })
        for crash in record["crashes"]:
            crash["signature"] = _signature(crash)

    # -- whole file ----------------------------------------------------------

    def run(self) -> dict[str, Any]:
        print(f"[{self.args.label}] {self.entry['name']}: {len(self.entry['steps'])} steps", flush=True)
        file_started = time.perf_counter()
        for i, step in enumerate(self.entry["steps"]):
            text = apply_edits(self.base, step["edits"])
            if hashlib.sha256(text.encode("utf-8")).hexdigest() != step["sha256"]:
                raise HarnessError(f"step {step['id']} does not reproduce the planned document")
            first = self.client is None
            if first:
                try:
                    self.start(text)
                except ServerExited as exc:
                    raise HarnessError(f"server failed to start: {exc} {exc.stderr}") from exc
            record = self.run_step(step, text, first)
            self.steps.append(record)
            if record["crashes"] or record["timeouts"] or self.args.verbose:
                kinds = sorted({c["signature"] for c in record["crashes"]})
                print(f"  {record['id']}: {record['elapsedMs']} ms crashes={kinds} timeouts={record['timeouts']}",
                      flush=True)
        if self.client is not None:
            self.client.shutdown()
            time.sleep(0.2)
        # Exceptions logged after the last step (late background binds) belong to it.
        if self.steps:
            tail = {"crashes": []}
            self._collect_background(tail)
            self.steps[-1]["crashes"].extend(tail["crashes"])
        crashes = [c for s in self.steps for c in s["crashes"]]
        if self.log_path is not None and self.log_path.exists() and not self.args.keep_logs:
            self.log_path.unlink()
        return {
            "id": file_id(self.entry),
            "path": self.entry["path"],
            "name": self.entry["name"],
            "lines": self.entry["lines"],
            "sha256": self.entry["sha256"],
            "steps": self.steps,
            "restarts": self.restarts,
            "crashCount": len(crashes),
            "elapsedS": round(time.perf_counter() - file_started, 1),
        }


def _percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * pct / 100
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo), 1)


def summarize_file(result: dict[str, Any]) -> dict[str, Any]:
    by_method: dict[str, list[float]] = {}
    for step in result["steps"]:
        for method, values in step["timings"].items():
            by_method.setdefault(method, []).extend(values)
    change = [s["changeToDiagnosticsMs"] for s in result["steps"] if "changeToDiagnosticsMs" in s]
    keystroke = [s["changeToDiagnosticsMs"] for s in result["steps"]
                 if s["kind"].startswith("edit-") and "changeToDiagnosticsMs" in s]
    step_ms = [s["elapsedMs"] for s in result["steps"]]
    signatures: dict[str, list[str]] = {}
    for step in result["steps"]:
        for crash in step["crashes"]:
            signatures.setdefault(crash["signature"], []).append(step["id"])
    return {
        "steps": len(result["steps"]),
        "stepsWithCrash": sum(1 for s in result["steps"] if s["crashes"]),
        "timeouts": sum(len(s["timeouts"]) for s in result["steps"]),
        "restarts": result["restarts"],
        "crashSignatures": signatures,
        "openToDiagnosticsMs": next((s["openToDiagnosticsMs"] for s in result["steps"]
                                     if "openToDiagnosticsMs" in s), None),
        "changeToDiagnosticsMs": {"p50": _percentile(change, 50), "p95": _percentile(change, 95),
                                  "max": max(change) if change else None},
        "keystrokeToDiagnosticsMs": {"p50": _percentile(keystroke, 50), "p95": _percentile(keystroke, 95)},
        "stepMs": {"p50": _percentile(step_ms, 50), "p95": _percentile(step_ms, 95)},
        "methodMs": {m: {"n": len(v), "p50": _percentile(v, 50), "p95": _percentile(v, 95), "max": max(v)}
                     for m, v in sorted(by_method.items())},
    }


def write_markdown(summary: dict[str, Any], path: Path) -> None:
    lines = [f"# LSP soak: {summary['label']}", ""]
    lines.append(f"- server: `{summary['server']}`")
    lines.append(f"- plan: `{summary['plan']}` (seed {summary['seed']})")
    for key, value in summary.get("meta", {}).items():
        lines.append(f"- {key}: {value}")
    lines.append(f"- logged-exception detection: {'off (--no-log)' if summary['noLog'] else 'on'}")
    if summary.get("skippedMethods"):
        lines.append(f"- skipped methods: {', '.join(summary['skippedMethods'])}")
    lines.append(f"- finished: {summary['finished']}")
    lines.append("")
    lines.append("| file | lines | steps | steps with crash | timeouts | restarts | didChange->diagnostics p50 / p95 ms | keystroke p50 / p95 ms |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|---:|")
    for f in summary["files"]:
        s = f["summary"]
        c, k = s["changeToDiagnosticsMs"], s["keystrokeToDiagnosticsMs"]
        lines.append(f"| {f['name']} | {f['lines']} | {s['steps']} | {s['stepsWithCrash']} | {s['timeouts']} | "
                     f"{s['restarts']} | {c['p50']} / {c['p95']} | {k['p50']} / {k['p95']} |")
    lines.append("")
    lines.append("## Crash signatures")
    lines.append("")
    any_crash = False
    for f in summary["files"]:
        for signature, steps in f["summary"]["crashSignatures"].items():
            any_crash = True
            lines.append(f"- {f['name']}: `{signature}` x{len(steps)} (first: {steps[0]})")
    if not any_crash:
        lines.append("None.")
    lines.append("")
    lines.append("## Per-method latency (ms)")
    for f in summary["files"]:
        lines.append("")
        lines.append(f"### {f['name']}")
        lines.append("")
        lines.append("| method | n | p50 | p95 | max |")
        lines.append("|---|---:|---:|---:|---:|")
        for method, m in f["summary"]["methodMs"].items():
            lines.append(f"| {method} | {m['n']} | {m['p50']} | {m['p95']} | {m['max']} |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def cmd_run(args: argparse.Namespace) -> int:
    parse_pairs("--server-env", args.server_env)  # fail fast, before any server starts
    parse_pairs("--meta", args.meta)
    plan = json.loads(Path(args.plan).expanduser().read_text(encoding="utf-8"))
    if plan.get("version") != PLAN_VERSION:
        raise HarnessError(f"plan version {plan.get('version')} is not {PLAN_VERSION}")
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    selected = [f for f in plan["files"] if not args.only or any(o in f["name"] for o in args.only)]
    results = []
    for entry in selected:
        result = FileRun(args, entry, out).run()
        result["summary"] = summarize_file(result)
        results.append(result)
        (out / (file_id(entry) + ".steps.json")).write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    summary = {
        "label": args.label,
        "server": args.server,
        "plan": str(Path(args.plan).expanduser().resolve()),
        "seed": plan["seed"],
        "planSha256": hashlib.sha256(Path(args.plan).expanduser().read_bytes()).hexdigest(),
        "meta": {**plan.get("meta", {}), **parse_pairs("--meta", args.meta)},
        "workspaceRoot": args.workspace_root,
        "noLog": args.no_log,
        "skippedMethods": args.skip_method,
        "finished": datetime.now(timezone.utc).isoformat(),
        "files": [{**{k: v for k, v in r.items() if k != "steps"}, "stepCrashes": {
            s["id"]: sorted({c["signature"] for c in s["crashes"]}) for s in r["steps"] if s["crashes"]}}
            for r in results],
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n", encoding="utf-8")
    write_markdown(summary, out / "summary.md")
    crashes = sum(r["crashCount"] for r in results)
    timeouts = sum(r["summary"]["timeouts"] for r in results)
    print(f"[{args.label}] {len(results)} file(s), {sum(len(r['steps']) for r in results)} step(s), "
          f"{crashes} crash record(s), {timeouts} timeout(s) -> {out / 'summary.md'}")
    return 1 if crashes or timeouts else 0


def plan_identity(summary: dict[str, Any]) -> Any:
    """The plan hash, or for summaries written before it was recorded, every file's content and step count."""
    if summary.get("planSha256"):
        return summary["planSha256"]
    return (summary["seed"], sorted((file_id(f), f["sha256"], f["summary"]["steps"]) for f in summary["files"]))


def cmd_compare(args: argparse.Namespace) -> int:
    left = json.loads(Path(args.left).expanduser().read_text(encoding="utf-8"))
    right = json.loads(Path(args.right).expanduser().read_text(encoding="utf-8"))
    if plan_identity(left) != plan_identity(right):
        raise HarnessError("the two runs used different plans")
    rows = [f"# LSP soak comparison: {left['label']} vs {right['label']}", "",
            f"| file | steps | {left['label']} crash steps | {right['label']} crash steps | "
            f"only {right['label']} | only {left['label']} | {left['label']} p50/p95 ms | {right['label']} p50/p95 ms |",
            "|---|---:|---:|---:|---|---|---:|---:|"]
    details = []
    divergent = 0
    by_id = {file_id(f): f for f in right["files"]}
    left_ids = {file_id(f) for f in left["files"]}
    for missing in sorted(left_ids ^ set(by_id)):
        side = right["label"] if missing in left_ids else left["label"]
        details.append(f"- {missing}: not run by {side}; not compared")
        divergent += 1
    for lf in left["files"]:
        rf = by_id.get(file_id(lf))
        if rf is None:
            continue
        if lf["sha256"] != rf["sha256"]:
            raise HarnessError(f"{lf['name']} differs between the two runs")
        lc, rc = lf["stepCrashes"], rf["stepCrashes"]
        only_r = sorted(s for s in rc if set(rc[s]) - set(lc.get(s, [])))
        only_l = sorted(s for s in lc if set(lc[s]) - set(rc.get(s, [])))
        divergent += len(set(only_r) | set(only_l))
        ls, rs = lf["summary"]["changeToDiagnosticsMs"], rf["summary"]["changeToDiagnosticsMs"]
        rows.append(f"| {lf['name']} | {lf['summary']['steps']} | {len(lc)} | {len(rc)} | {len(only_r)} | "
                    f"{len(only_l)} | {ls['p50']} / {ls['p95']} | {rs['p50']} / {rs['p95']} |")
        for step in only_r:
            details.append(f"- {lf['name']} {step}: {right['label']} only: "
                           f"{sorted(set(rc[step]) - set(lc.get(step, [])))}")
        for step in only_l:
            details.append(f"- {lf['name']} {step}: {left['label']} only: "
                           f"{sorted(set(lc[step]) - set(rc.get(step, [])))}")
    rows += ["", "## Divergent steps", ""] + (details or ["None."])
    text = "\n".join(rows) + "\n"
    if args.out:
        Path(args.out).expanduser().write_text(text, encoding="utf-8")
    print(text)
    return 1 if divergent else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "LSP error-recovery soak").split("\n", 1)[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("plan", help="generate the deterministic step plan")
    p.add_argument("files", nargs="*", help="explicit .gs files")
    p.add_argument("--tree", help="pick the --largest .gs files under this directory")
    p.add_argument("--largest", type=int, default=6)
    p.add_argument("--sample", type=int, default=0,
                   help="instead of the largest files, a seeded sample of this many files in the line band")
    p.add_argument("--min-lines", type=int, default=300)
    p.add_argument("--max-lines", type=int, default=1500)
    p.add_argument("--seed", type=int, default=4242)
    p.add_argument("--truncations", type=int, default=4, help="random truncation offsets (targeted ones are extra)")
    p.add_argument("--line-deletions", type=int, default=6)
    p.add_argument("--brace-deletions", type=int, default=5)
    p.add_argument("--garbage", type=int, default=6)
    p.add_argument("--probes", type=int, default=2, help="seeded identifier positions per pool per step")
    p.add_argument("--meta", action="append", default=[], help="key=value recorded in the plan (e.g. tree-run=...)")
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_plan)

    r = sub.add_parser("run", help="run a plan against a server")
    r.add_argument("--plan", required=True)
    r.add_argument("--server", required=True, help='server command line, e.g. "dotnet GSharp.LanguageServer.dll"')
    r.add_argument("--label", required=True)
    r.add_argument("--out", required=True)
    r.add_argument("--server-env", action="append", default=[], help="KEY=VALUE set in the server's environment")
    r.add_argument("--workspace-root", help="send this as rootUri (project mode); default is loose files")
    r.add_argument("--request-timeout", type=float, default=300)
    r.add_argument("--only", action="append", default=[], help="run only files whose name contains this")
    r.add_argument("--no-log", action="store_true", help="no server --log (timing pass; no logged-exception channel)")
    r.add_argument("--skip-method", action="append", default=[],
                   help="do not send this request method (e.g. textDocument/semanticTokens/full)")
    r.add_argument("--keep-logs", action="store_true", help="keep the per-file server logs")
    r.add_argument("--meta", action="append", default=[])
    r.add_argument("--verbose", action="store_true")
    r.set_defaults(func=cmd_run)

    c = sub.add_parser("compare", help="compare two runs of one plan")
    c.add_argument("left")
    c.add_argument("right")
    c.add_argument("--out")
    c.set_defaults(func=cmd_compare)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except HarnessError as exc:
        print(f"lsp-soak: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
