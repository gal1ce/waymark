"""Deterministic clean-up of model-written C, so test quality doesn't depend on the model:
clang-format fixes the layout, gcc runs 'what does this print' questions to check the expected output."""
from __future__ import annotations

import os
import re
import resource
import shutil
import subprocess
import tempfile

STYLE = ("{BasedOnStyle: LLVM, IndentWidth: 4, ColumnLimit: 80, AllowShortFunctionsOnASingleLine: None, "
         "AllowShortIfStatementsOnASingleLine: Never, AllowShortLoopsOnASingleLine: false, "
         "AllowShortBlocksOnASingleLine: Never, SortIncludes: Never}")
_CF = shutil.which("clang-format")
_CC = shutil.which("gcc") or shutil.which("cc")
_CXX = shutil.which("g++") or shutil.which("clang++")
_CPP = re.compile(r"#include\s*<(iostream|vector|string|map|unordered_map|set|memory|algorithm|array|utility|optional|span)>"
                  r"|\bstd::|\bcout\b|\bclass\s+\w|\btemplate\s*<|\bnamespace\b|\bnullptr\b|\bauto\s+\w+\s*=")


def is_cpp(code: str) -> bool:
    return bool(_CPP.search(code))

# never executed: touches files, processes, the network or the shell
_DANGER = re.compile(r"\b(system|popen|exec[lvpe]*|fork|vfork|fopen|freopen|remove|unlink|unlinkat|rmdir|rename|"
                     r"renameat|truncate|ftruncate|chmod|fchmod|chown|mkdir|symlink|linkat|socket|connect|"
                     r"kill|raise|asm|__asm__|syscall|dlopen|mmap|ptrace|setuid|chdir|opendir|ofstream|fstream|"
                     r"filesystem)\b|\b(open|openat|write|creat)\s*\(")

# Model-written code runs inside bubblewrap when it's available: no network, no other processes, a read-only
# view of /usr and nothing of $HOME. The denylist above stays as a second line.
_BWRAP = shutil.which("bwrap")


def _bwrap_args(d: str) -> list[str]:
    return [_BWRAP, "--ro-bind", "/usr", "/usr", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
            "--symlink", "usr/bin", "/bin", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
            "--ro-bind", d, d, "--chdir", d, "--unshare-all", "--die-with-parent", "--new-session",
            "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "UBSAN_OPTIONS", "print_stacktrace=0"]


def _probe_bwrap() -> bool:
    if not _BWRAP:
        return False
    try:
        with tempfile.TemporaryDirectory(prefix="ctu-bw-") as d:
            r = subprocess.run([*_bwrap_args(d), "/usr/bin/true"], capture_output=True, timeout=5)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


SANDBOX = _probe_bwrap()
# runs, but the output isn't a fixed answer
_NONDET = re.compile(r"\b(rand|srand|time|clock|scanf|getchar|fgets|gets|getenv|getline)\b")
_HEADERS = "#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <stdbool.h>\n#include <limits.h>\n"
_HEADERS_CPP = ("#include <iostream>\n#include <string>\n#include <vector>\n#include <map>\n#include <memory>\n"
                "#include <algorithm>\n#include <cstdio>\n#include <climits>\nusing namespace std;\n")


def fmt(code: str) -> str:
    """Indent and lay out C code consistently. Falls back to a brace-based re-indent without clang-format."""
    if not code.strip():
        return code
    if _CF:
        try:
            r = subprocess.run([_CF, f"--style={STYLE}", f"--assume-filename=q.{'cpp' if is_cpp(code) else 'c'}"], input=code,
                               capture_output=True, text=True, timeout=5)
            if r.returncode == 0 and r.stdout.strip():
                return r.stdout.rstrip("\n")
        except (OSError, subprocess.SubprocessError):
            pass
    return _reindent(code)


def _reindent(code: str) -> str:
    out, depth = [], 0
    for raw in code.strip("\n").splitlines():
        line = raw.strip()
        if line.startswith("}"):
            depth = max(0, depth - 1)
        out.append(("    " * depth + line) if line else "")
        depth = max(0, depth + line.count("{") - line.count("}") + (1 if line.startswith("}") else 0))
    return "\n".join(out)


def _limits() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
    resource.setrlimit(resource.RLIMIT_AS, (512 << 20, 512 << 20))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 20, 1 << 20))
    resource.setrlimit(resource.RLIMIT_NOFILE, (16, 16))
    os.setsid()


def run(code: str) -> tuple[str, str]:
    """('ok', stdout) | ('skip', why) | ('compile', error) | ('crash', why). Wraps a bare snippet in main()."""
    cpp = is_cpp(code)
    cc = _CXX if cpp else _CC
    if not cc:
        return "skip", f"no {'C++' if cpp else 'C'} compiler"
    if _DANGER.search(code):
        return "skip", "uses files, processes or the shell"
    if _NONDET.search(code):
        return "skip", "reads input or uses randomness/time"
    body = code if re.search(r"\bmain\s*\(", code) else f"int main({'' if cpp else 'void'}) {{\n{code}\nreturn 0;\n}}\n"
    headers = _HEADERS_CPP if cpp else _HEADERS
    with tempfile.TemporaryDirectory(prefix="ctu-q-") as d:
        src, exe = os.path.join(d, "q.cpp" if cpp else "q.c"), os.path.join(d, "q")
        with open(src, "w") as f:
            f.write(headers + body)
        try:
            c = subprocess.run([cc, "-std=c++20" if cpp else "-std=c11", "-O0", "-w", "-fsanitize=undefined", "-fno-sanitize-recover=undefined",
                                "-o", exe, src, "-lm"], capture_output=True, text=True, timeout=20)
        except subprocess.TimeoutExpired:
            return "compile", "compiler timed out"
        if c.returncode != 0:
            err = next((ln for ln in c.stderr.splitlines() if "error" in ln), c.stderr.strip()[:200])
            return "compile", err.split("error:", 1)[-1].strip()[:200]
        try:
            cmd = [*_bwrap_args(d), exe] if SANDBOX else [exe]
            r = subprocess.run(cmd, cwd=d, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=3,
                               env={"PATH": "/usr/bin:/bin", "UBSAN_OPTIONS": "print_stacktrace=0"}, preexec_fn=_limits)
        except subprocess.TimeoutExpired:
            return "crash", "ran too long"
        if r.returncode != 0 or "runtime error" in r.stderr:
            why = ("undefined behaviour" if "runtime error" in r.stderr else
                   "ran too long" if r.returncode in (-9, -24) else f"exit code {r.returncode}")
            return "crash", why
        return "ok", r.stdout[:2000]
