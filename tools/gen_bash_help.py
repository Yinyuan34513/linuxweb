#!/usr/bin/env python3
"""Generate src/help.js from bash 5.3's own builtin definitions.

bash keeps each builtin's documentation in builtins/*.def, between $SHORT_DOC
and $END ($LONG_DOC for the long text).  The help builtin renders it as

    <name>: <first line of SHORT_DOC>
        <the rest, indented four spaces>

so this script extracts the raw lines and lets the shell do exactly that,
instead of us inventing descriptions.

Source: /home/Yin/Downloads/bash-5.3.tar.gz (override with an argument).
Output: src/help.js  ->  window.LW.HELP / window.LW.HELP_ORDER
"""

import argparse
import json
import os
import re
import subprocess
import sys

DEFAULT_TARBALL = "/home/Yin/Downloads/bash-5.3.tar.gz"
PREFIX = "bash-5.3/builtins/"

# Every $BUILTIN in every builtins/*.def is documented, including the shell
# reserved words (reserved.def) -- that is what bash's bare `help` lists, so the
# listing here is bash's complete one, not just the subset this shell runs.
#
# `!` is the one exception: reserved.def defines it, but bash does not register
# it, so `help '!'` says "no help topics match" on a real shell too.
EXCLUDE = {"!"}

# not bash builtins: these are linuxweb's own, so they keep hand-written text
EXTRA = {
    "clear": ["clear", "Clear the terminal screen.",
              "Erases the screen and homes the cursor.", "",
              "Exit Status:", "Returns 0 unless the terminal cannot be written to."],
    "reset": ["reset", "Reset the terminal.",
              "Clears the screen and resets the terminal state (RIS).", "",
              "Exit Status:", "Returns 0 unless the terminal cannot be written to."],
    "sync": ["sync", "Flush the IndexedDB filesystem.",
             "Writes every queued change to the backing store immediately, the",
             "way sync(1) does for the page cache.", "",
             "Exit Status:", "Returns 0 unless the filesystem is not mounted."],
    "sudo": ["sudo command [arguments]", "Execute a command as another user.",
             "Runs COMMAND as root.  linuxweb has no passwords to ask for, so it",
             "simply runs the command.", "",
             "Exit Status:", "Exit status of the command, or 1 if it cannot be run."],
}


# `set -o` in an interactive shell, captured from real bash (the non-interactive
# values differ for emacs/history/histexpand/monitor).
SET_O = [
    ("allexport", False), ("braceexpand", True), ("emacs", True), ("errexit", False),
    ("errtrace", False), ("functrace", False), ("hashall", True), ("histexpand", True),
    ("history", True), ("ignoreeof", False), ("interactive-comments", True),
    ("keyword", False), ("monitor", True), ("noclobber", False), ("noexec", False),
    ("noglob", False), ("nolog", False), ("notify", False), ("nounset", False),
    ("onecmd", False), ("physical", False), ("pipefail", False), ("posix", False),
    ("privileged", False), ("verbose", False), ("vi", False), ("xtrace", False),
]


def capture_bind():
    """Run a real bash and keep its `bind -P` table verbatim."""
    try:
        out = subprocess.run(["bash", "--norc", "--noprofile", "-c", "bind -P"],
                             capture_output=True, text=True,
                             env=dict(os.environ, LC_ALL="C"), timeout=20)
    except Exception as e:                      # no bash around: skip the table
        print(f"  note: could not capture `bind -P` ({e})", file=sys.stderr)
        return []
    return [l for l in out.stdout.split("\n") if l.strip()]


def root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_defs(tarball: str) -> dict:
    """Return {def-name: text} for every builtins/*.def, cached on disk."""
    cache = os.path.join(root(), "tools", ".cache", "bash-builtins")
    os.makedirs(cache, exist_ok=True)
    listing = subprocess.check_output(["tar", "tzf", tarball]).decode()
    names = [l for l in listing.splitlines()
             if l.startswith(PREFIX) and l.endswith(".def")]
    out = {}
    for member in names:
        base = os.path.basename(member)
        path = os.path.join(cache, base)
        if not os.path.exists(path):
            data = subprocess.check_output(["tar", "xzf", tarball, "-O", member])
            with open(path, "wb") as fh:
                fh.write(data)
        with open(path, "rb") as fh:
            out[base] = fh.read().decode("latin-1")
    return out


def parse(text: str):
    """Yield (name, short_lines, long_lines) for every $BUILTIN in a .def."""
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        # NB: some names contain spaces -- `for ((`, `(( ... ))`, `[[ ... ]]`,
        # `{ ... }` -- so the rest of the line is the name, not one token.
        m = re.match(r"^\$BUILTIN (.+)$", lines[i])
        if not m:
            i += 1
            continue
        name = m.group(1)
        short, long = [], []
        i += 1
        while i < len(lines) and not lines[i].startswith("$BUILTIN "):
            line = lines[i]
            if line.startswith("$SHORT_DOC"):
                rest = line[len("$SHORT_DOC"):]
                if rest.strip():
                    short.append(rest[1:] if rest.startswith(" ") else rest)
                i += 1
                while i < len(lines) and lines[i] != "$END":
                    short.append(lines[i])
                    i += 1
            elif line.startswith("$LONG_DOC"):
                i += 1
                while i < len(lines) and lines[i] != "$END":
                    long.append(lines[i])
                    i += 1
            i += 1
        yield name, short, long


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("tarball", nargs="?", default=DEFAULT_TARBALL)
    args = ap.parse_args()

    if not os.path.exists(args.tarball):
        raise SystemExit(f"tarball not found: {args.tarball}")

    found = {}
    for text in load_defs(args.tarball).values():
        for name, short, long in parse(text):
            # echo.def (and a few others) define the same builtin twice, once
            # per build flavour; the first block is the default one.
            if short and name not in found and name not in EXCLUDE:
                found[name] = (short, long)
    if not found:
        raise SystemExit("no $BUILTIN blocks found -- wrong tarball?")

    # The readline key table (`bind -P`) and the interactive shell options
    # (`set -o`) are captured from a real bash rather than invented.
    bind_lines = capture_bind()
    set_o = SET_O

    entries = {}
    order = []
    for name in found:
        short, long = found[name]
        usage = short[0].strip()
        body = short[1:]
        # drop a leading blank line from the doc body if the file has one
        while body and body[0].strip() == "":
            body.pop(0)
        while body and body[-1].strip() == "":
            body.pop()
        desc = next((l.strip() for l in body if l.strip()), usage)
        entries[name] = {"usage": usage, "desc": desc, "body": body + long}
        order.append(name)

    # linuxweb's own builtins are documented but deliberately NOT put in the
    # listing: bare `help` prints bash's complete list, byte for byte.
    for name, short in EXTRA.items():
        usage = short[0]
        body = short[1:]
        desc = next((l.strip() for l in body if l.strip()), usage)
        entries[name] = {"usage": usage, "desc": desc, "body": body}

    # plain ASCII order on the entry name is exactly bash's listing order:
    # % ( ) . : [ come before letters, and `{ ... }` after `z`.
    order.sort()

    out = os.path.join(root(), "src", "help.js")
    with open(out, "w") as fh:
        fh.write("// GENERATED by tools/gen_bash_help.py -- do not edit.\n")
        fh.write("// $SHORT_DOC/$LONG_DOC text taken verbatim from bash-5.3's\n")
        fh.write("// builtins/*.def; linuxweb's own builtins are appended by hand.\n")
        fh.write("window.LW = window.LW || {};\n")
        fh.write("window.LW.HELP = " + json.dumps(entries, indent=1, ensure_ascii=False) + ";\n")
        fh.write("window.LW.HELP_ORDER = " + json.dumps(order) + ";\n")
        fh.write("// `bind -P` output, captured from real bash:\n")
        fh.write("window.LW.BIND_P = " + json.dumps(bind_lines, indent=1, ensure_ascii=False) + ";\n")
        fh.write("// `set -o` for an interactive shell, captured from real bash:\n")
        fh.write("window.LW.SET_O = " + json.dumps(set_o, indent=1, ensure_ascii=False) + ";\n")
    print(f"  wrote src/help.js ({len(entries)} topics, {len(found)} from bash 5.3, "
          f"{len(bind_lines)} bind lines)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
