# COREUTILS agent spec — read fully, then implement your assigned file.

File: `/home/Yin/linuxweb/src/coreutils_*.js` — this page is a dependency-free
"Linux 7.2.8 boot console": an interactive bash-alike over an in-memory VFS.
It already has a shell (`src/bash.js`) with most commands, but they are shallow
emulations.  Your job: make the assigned commands match real GNU coreutils
9.4 behavior as shipped on Debian.

## Philosophy already in the project (match it)

- `cat --help` prints the REAL text (already captured in
  `src/coreutils_help.js` by tools/gen_coreutils_help.py). Do NOT write your
  own help scaffolding: `finish()` answers --help/--version from the capture.
- `LC_ALL=C` wording and exit statuses are sacred. Capture from the host
  (`LC_ALL=C <cmd> ...`), translate, verify. Most "usage errors" die with
  code 1 (sort: 2, nice/timeout: 125). Missing-file messages differ per
  program (verified examples):
  - `cat: name: No such file or directory` / `cat: name: Is a directory`
  - `wc: name: No such file or directory`
  - `head`/`tail`: `head: cannot open 'name' for reading: ...` (note quotes)
  - `sort`: `sort: cannot read: name: ...` (code 2)
  - `date`/`split`: `split: cannot open 'name' for reading: ...`
  - `tac`: `tac: failed to open 'name' for reading: ...`
  - `cp`/`mv`/`install`: `cp: cannot stat 'name': ...`
  - `rm`: `rm: cannot remove 'name': ...`
  - `du`: `du: cannot access 'name': ...`
  Verify every wording you use with `LC_ALL=C` on the host first.
- "Like real" is what counts for the core usage: option flags, word
  grouping (`cut -d: -f2,3`), stdin fallback, multi-file semantics,
  count/sizes, column alignment, blank-line handling. You do NOT need to
  implement SELinux/xattrs, alternate threads, or real CoW/CoW — plain
  in-memory behavior is fine.
- Sequences command | with $(), globs, redirection already work; your
  command only produces and consumes plain text.

## How your commands register

Each command lives in your assigned file inside the shared skeleton. Use the
provided helpers — do not invent a new pattern:

```js
// registration: def(name, fn, "name - one-line help");
def("cat", function (args, stdin, sh) { ... }, "cat - concatenate files and print");

function (args, stdin, sh) {
  // args: the literal argv words after the command name (already glob-expanded)
  // stdin: the text from the previous pipe step ("" when none)
  // sh: the Shell;  sh.path(p) joins cwd, sh.cwd, sh.env, sh.status
  // return { out: "...", err: "", code: 0 }
  // use sh._error("msg") for stderr lines; it already appends "\n".

  // 1) option parsing -- ALWAYS go through getopt/finish so errors get the
  //    coreutils "-X"/"--xZ" wording and --help/--version honors the capture:
  var g = getopt("prog", args, { short: {...}, long: {...} });
  var done = finish(sh, "prog", g); // returns a non-null result for
  if (done) return done;               //   --help/--version/bad-option.
  var o = g.o;                      // parsed flags

  // 2) walk operands: eachInput(... fn(text, name) ...) handles "-" = stdin
  //    (read once), missing files, and directories using your errFmt.
}
```

Return `{ out, code }` where `out` is the exact bytes your command prints on
success (include trailing newlines as the real one does). For streaming
commands that need to drain stdin line-by-line (e.g. `seq`), sockets (none
have them here), etc., keep it text in/out from `stdin`.

## Core helpers (defined in src/bash.js, exposed via window.LW.core)

`getopt(prog, args, spec)`:
- `spec.short` = `{ letter: "bool" | "arg" }`; `spec.long` =
  `{ name: "bool" | "arg" | ["bool"|"arg", keyAlias] }`.
- boolean long opts, flags (A), e.g. “bool” and optional `helpShort` /
  `versionShort` (rare, e.g. some progs have -h? defaults: no).
- Set `spec.exit = 2` for `sort`-style usage errors.
- `finish(sh, prog, g)`: if `g.help`/`g.version`/error, return the ready
  result; otherwise null.

`eachInput(prog, operands, stdin, sh, errFmt, fn)`:
- iterates operands; `-` means 	he	STDIN. A single call runs fn(text, null)
  for stdin. Missing/dir/perm produce errFmt && exit-code via a thrown? No -- check
  return value: it increments code and keeps going.
- args empty => uses stdin (i.e. ["-"]).
- Use `gnuErr(prog, name, kind)` for the common `prog: name: ...` form,
  or write `(prog,name,kind)=>"prog: cannot open ..."` where the real one
  phrases it differently.

Other useful VFS and shell bits (src/vfs.js, src/bash.js):

`var V = LW.VFS;` `V.getNode(p)` => {t:"d"|"f"|"l", ...}|null; 
`V.readFile(p)`=>string|null; `V.writeFile(p,data,append)`; `V.lsDir(p)`=>names|null;
`V.mkdirp`, `V.unlink`, `V.persist`, `V.persistTree`, `V.deleteTree`,
`V.parentOf`, `V.baseName`, `V.norm(path,cwd)`, `V.isDir`, `V.glob`,
`V.getRoot`, `V.mountsText`, `V.stats`, `V._buildFromRecords`, `V.file`, `V.dir`.
String access to a file's bytes is as-is; handle binary-ish input (from
/dev/urandom) the same way the shell does (a string of byte values).

`var sgr = LW.core.sgr;` for `--color`, `var human = LW.core.human` for human-readable sizes
(`--bytes`, `--block-size`) where convenient.

## Testing

Create `tools/test_coreutils_<xxx>.js` (ALL coreutils files: text, file,
sys, digest) in the same shape as `tools/test_shell.js`:
- a tiny Term stub; a vm context loading ../src files in order:
  bash.data.js, help.js, vfs.js, bash.js, coreutils_help.js, YOUR_FILE.
- `sh = new LW.Shell(term)`; `sh.runLine("...", false)`; pick `sh.lastOut`.
- `check(name, cmd, want)` boolean/want. At least 5 checks per command.
- Run it: `node tools/test_coreutils_<xxx>.js`
  It must write "N passed, M failed" and exit 0.

Then re-run, for sanity, all pre-existing suites:
  node tools/test_shell.js   (expect: 80 passed, 5 failed historically — just
  don't regress from that)
  node tools/test_getty.js
  node tools/test_render.js
  node tools/test_vt.js
  node tools/test_dev_apt.js

## Where to draw the line

- IDENTICAL to the host for these surfaces: option flags (set them up from
  `<cmd> --help`), operand interfys (files vs stdin), all documented error
  wordings, and basic output structure for realistic sample input.
- Reasonable stand-ins where real behavior is not textual (xattrs, SELinux,
  io_uring etc.). e.g. for `chcon`/`runcon`: print the "would set context"
  message or use the current context; do not crash.
- Use synchronous string IO only, this shell has no real sockets. `ls`-based
  and `cp`-based flows must work against the same VFS we mutate in tests.
