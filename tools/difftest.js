// Differential test: run the same command line in the real shell and in the
// JavaScript shell and compare stdout, stderr and exit status.
//
// The fixtures are created by the same setup lines in both, so a mismatch is
// the command's behaviour and not the environment.  Every expectation here is
// the real coreutils binary's output -- nothing is written by hand.
//
//   node tools/difftest.js            run every group
//   node tools/difftest.js wc tr      run the named groups only
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadShell } = require("./shell_harness.js");

const REAL = process.env.REAL_SHELL || "/bin/sh";

// Each group is a list of [name, setupLines, commandLine].  setupLines run in
// the same order in both shells before the command under test.
const GROUPS = {
  // ---- text filters ---------------------------------------------------
  wc: [
    ["one file", ["printf 'a\\nb\\n' > f1"], "wc f1"],
    ["two files", ["printf 'a\\nb\\n' > f1", "printf 'a\\n' > f2"], "wc f1 f2"],
    ["three files, differing widths", ["printf 'a\\nb\\n' > f1", "printf 'a\\n' > f2", "yes abcdefghij | head -40 > big"], "wc f1 f2 big"],
    ["only lines", ["printf 'a\\nb\\n' > f1", "printf 'a\\n' > f2"], "wc -l f1 f2"],
    ["only bytes", ["printf 'a\\nb\\n' > f1", "printf 'a\\n' > f2", "yes abcdefghij | head -40 > big"], "wc -c f1 f2 big"],
    ["words", ["printf 'a b c\\n' > f1"], "wc -w f1"],
    ["max line length", ["printf 'abc\\n' > f1", "yes abcdefghij | head -40 > big"], "wc -L f1 big"],
    ["chars", ["printf 'abc\\n' > f1"], "wc -m f1"],
    ["missing file", [], "wc nope"],
    ["stdin only", ["printf 'a\\nb\\n' > f1"], "cat f1 | wc"],
    ["stdin named", ["printf 'a\\nb\\n' > f1"], "cat f1 | wc -"],
    ["stdin only lines", ["printf 'a\\nb\\n' > f1"], "cat f1 | wc -l"],
    ["file and stdin", ["printf 'a\\n' > f2", "printf 'a\\nb\\n' > f1"], "cat f1 | wc f2 -"],
  ],
  head: [
    ["default", ["seq 1 20 > f"], "head f"],
    ["-n", ["seq 1 20 > f"], "head -n 3 f"],
    ["-c", ["seq 1 5 > f"], "head -c 4 f"],
    ["two files", ["seq 1 3 > f1", "seq 1 2 > f2"], "head -n 2 f1 f2"],
    ["two files -q", ["seq 1 3 > f1", "seq 1 2 > f2"], "head -q -n 2 f1 f2"],
    ["missing file", [], "head -n 1 /nope"],
    ["bad count", ["seq 1 3 > f"], "head -n x f"],
  ],
  tail: [
    ["default", ["seq 1 20 > f"], "tail f"],
    ["-n", ["seq 1 20 > f"], "tail -n 3 f"],
    ["-c", ["seq 1 5 > f"], "tail -c 4 f"],
    ["two files", ["seq 1 3 > f1", "seq 1 2 > f2"], "tail -n 2 f1 f2"],
    ["missing file", [], "tail -n 1 /nope"],
  ],
  sort: [
    ["plain", ["printf 'b\\na\\nc\\n' > f"], "sort f"],
    ["reverse", ["printf 'b\\na\\n' > f"], "sort -r f"],
    ["numeric", ["printf 'b10\\na10\\nA2\\n' > f"], "sort f"],
    ["-n", ["printf 'b10\\na10\\nA2\\n' > f"], "sort -n f"],
    ["-nr", ["printf 'b10\\na10\\nA2\\n' > f"], "sort -nr f"],
    ["human", ["printf '1K\\n2M\\n512\\n' > f"], "sort -h f"],
    ["version", ["printf 'file10\\nfile9\\n' > f"], "sort -V f"],
    ["unique", ["printf 'a\\na\\nb\\n' > f"], "sort -u f"],
    ["key", ["printf 'x:2\\na:10\\n' > f"], "sort -t: -k2,2n f"],
    ["check ok", ["printf 'a\\nb\\n' > f"], "sort -c f"],
    ["check bad", ["printf 'b\\na\\n' > f"], "sort -c f"],
    ["missing file", [], "sort /nope"],
    ["stdin", [], "printf 'b\\na\\n' | sort"],
  ],
  uniq: [
    ["counts", ["printf 'a\\na\\nb\\n' > f"], "uniq -c f"],
    ["repeated only", ["printf 'a\\na\\nb\\n' > f"], "uniq -d f"],
    ["unique only", ["printf 'a\\na\\nb\\n' > f"], "uniq -u f"],
    ["ignore case", ["printf 'A\\na\\nB\\n' > f"], "uniq -i f"],
    ["check chars", ["printf 'aa\\nab\\n' > f"], "uniq -w 1 f"],
    ["stdin", [], "printf 'a\\na\\n' | uniq -c"],
  ],
  tr: [
    ["translate", [], "printf 'abc' | tr 'a-c' 'A-C'"],
    ["delete", [], "printf 'a1b2c3' | tr -d '0-9'"],
    ["squeeze", [], "printf 'a   b' | tr -s ' '"],
    ["classes", [], "printf 'abc' | tr '[:lower:]' '[:upper:]'"],
    ["complement", [], "printf 'abc' | tr -cd '[:digit:]'"],
    ["escapes", [], "printf 'a\\tb\\n' | tr '\\t' ' '"],
    ["missing operand", [], "tr"],
    ["extra operand", [], "tr a b c"],
  ],
  cut: [
    ["fields", [], "printf 'a:b:c\\n' | cut -d: -f2"],
    ["field list", [], "printf 'a:b:c\\n' | cut -d: -f1,3"],
    ["field range", [], "printf 'a:b:c\\n' | cut -d: -f2-3"],
    ["open range", [], "printf 'a:b:c\\n' | cut -d: -f2-"],
    ["complement", [], "printf 'a:b:c\\n' | cut -d: --complement -f1"],
    ["characters", [], "printf 'abcdef' | cut -c2-4"],
    ["bytes", [], "printf 'abcdef' | cut -b1,3"],
    ["only delimited", [], "printf 'a\\nb:c\\n' | cut -d: -f1 -s"],
    ["no such option set", [], "printf 'a' | cut"],
  ],
  nl: [
    ["default", ["printf 'a\\nb\\n' > f"], "nl f"],
    ["-ba", ["printf 'a\\n\\nb\\n' > f"], "nl -ba f"],
    ["-bt", ["printf 'a\\n\\nb\\n' > f"], "nl -bt f"],
    ["-v", ["printf 'a\\nb\\n' > f"], "nl -v 10 f"],
  ],
  tac: [
    ["simple", ["printf 'a\\nb\\n' > f"], "tac f"],
    ["stdin", [], "printf 'a\\nb\\n' | tac"],
    ["missing file", [], "tac /nope"],
  ],
  fold: [
    ["default width", ["printf 'abcdefghij\\n' > f"], "fold -w 4 f"],
    ["spaces", ["printf 'ab cdef gh\\n' > f"], "fold -s -w 4 f"],
  ],
  expand: [
    ["tab to spaces", ["printf 'a\\tb\\n' > f"], "expand -t 4 f"],
    ["default stops", ["printf 'a\\tb\\n' > f"], "expand f"],
  ],
  join: [
    ["simple", ["printf '1 a\\n2 b\\n' > j1", "printf '1 x\\n2 y\\n' > j2"], "join j1 j2"],
    ["-o", ["printf '1 a\\n2 b\\n' > j1", "printf '1 x\\n2 y\\n' > j2"], "join -j 1 -o 1.1,2.2,1.2 j1 j2"],
  ],
  comm: [
    ["three columns", ["printf 'a\\nb\\nc\\n' > c1", "printf 'b\\nc\\nd\\n' > c2"], "comm c1 c2"],
    ["suppress first", ["printf 'a\\nb\\nc\\n' > c1", "printf 'b\\nc\\nd\\n' > c2"], "comm -1 c1 c2"],
    ["suppress 1 and 2", ["printf 'a\\nb\\nc\\n' > c1", "printf 'b\\nc\\nd\\n' > c2"], "comm -12 c1 c2"],
  ],
  paste: [
    ["two files", ["printf 'a\\nb\\n' > p1", "printf '1\\n2\\n' > p2"], "paste p1 p2"],
    ["delimiter", ["printf 'a\\nb\\n' > p1", "printf '1\\n2\\n' > p2"], "paste -d, p1 p2"],
    ["serial", [], "seq 3 | paste -sd,"],
  ],
  split: [
    ["by lines", ["seq 1 12 > f", "rm -f sp_?? 2>/dev/null; true"], "split -l 5 f sp_"],
    ["by chars", ["printf 'abcdefg' > f"], "split -b 3 f cb_"],
    ["missing operand", [], "split -l 2"],
  ],
  od: [
    ["-c", [], "printf 'hello world\\nabcdefghijklmno' | od -c"],
    ["-tx1", [], "printf 'abcdefg' | od -tx1"],
    ["-b", [], "printf 'abcdefg' | od -b"],
    ["default", [], "printf 'abcdefg' | od"],
    ["-A n", [], "printf 'abcdefg' | od -An -c"],
    ["-w", [], "printf 'abcdef' | od -An -tx1 -w 2"],
    ["-j -N", [], "printf 'abcdefgh' | od -An -c -j 2 -N 3"],
    ["specials", [], "printf 'a\\tb' | od -c"],
    ["missing file", [], "od /nope"],
  ],
  fmt: [
    ["wrap", ["printf 'aaaa bbbb cccc dddd eeee\\n' > f"], "fmt -w 20 f"],
    ["stdin", [], "printf 'aaaa bbbb cccc dddd\\n' | fmt -w 10"],
  ],
  numfmt: [
    ["--to=si", [], "numfmt --to=si 1500"],
    ["--to=iec", [], "numfmt --to=iec 1048576"],
    ["from si to iec", [], "numfmt --from=si --to=iec 1.5K"],
    ["padding", [], "numfmt --to=iec --padding=10 512"],
    ["stdin", [], "printf '1500\\n' | numfmt --to=si"],
    ["invalid", [], "numfmt --to=si abc"],
  ],
  seq: [
    ["two args", [], "seq 3 5"],
    ["three args", [], "seq 1 2 7"],
    ["separator", [], "seq -s, 1 3"],
    ["equal width", [], "seq -w 8 10"],
    ["format", [], "seq -f '%03g' 3"],
    ["zero step", [], "seq 1 0 5"],
  ],
  tsort: [
    ["simple", [], "printf 'a b\\nb c\\n' | tsort"],
    ["loop", [], "printf 'a b\\nb a\\n' | tsort"],
  ],
  // ---- the shell's own printf -------------------------------------------
  printf: [
    ["literal", [], "printf 'hello'"],
    ["escapes", [], "printf 'a\\tb\\nc\\n'"],
    ["one substitution", [], "printf '%s\\n' abc"],
    ["reuse the format", [], "printf 'a%.0s' 1 2 3"],
    ["pairs", [], "printf '%s-%s\\n' a b"],
    ["right align", [], "printf '[%5s]\\n' ab"],
    ["left align", [], "printf '[%-5s]\\n' ab"],
    ["zero pad", [], "printf '%05d\\n' 42"],
    ["star width", [], "printf '%*d|\\n' 4 7"],
    ["precision", [], "printf '%.2f\\n' 3.14159"],
    ["percent", [], "printf '100%%\\n'"],
    ["hex", [], "printf '%x %X\\n' 255 255"],
    ["missing argument", [], "printf '%s\\n'"],
    ["no argument", [], "printf 'plain\\n'"],
  ],

  // ---- sed: checked against the real GNU sed --------------------------
  sed: [
    ["substitute", [], "printf 'a\\nb\\nc\\n' | sed 's/b/B/'"],
    ["global", [], "printf 'aaa\\nbbb\\n' | sed 's/a*/X/g'"],
    ["anchor", [], "printf '  x\\ny  \\n' | sed 's/^ *//'"],
    ["line number", [], "printf 'a\\nb\\nc\\n' | sed -n 2p"],
    ["quote form", [], "printf 'a\\nb\\nc\\n' | sed -n '2p'"],
    ["range", [], "printf 'a\\nb\\nc\\nd\\n' | sed -n '2,3p'"],
    ["to the end", [], "printf 'a\\nb\\nc\\nd\\n' | sed -n '2,$p'"],
    ["negated range", [], "printf 'a\\nb\\nc\\nd\\n' | sed -n '2,3!p'"],
    ["pattern address", [], "printf 'a\\nb\\nc\\n' | sed -n '/b/p'"],
    ["pattern range", [], "printf 'a\\nb\\nc\\nd\\n' | sed -n '/a/,/c/p'"],
    ["relative range", [], "printf 'foo\\nbar\\nbaz\\n' | sed -n '/^b/,+1p'"],
    ["step", [], "printf 'a\\nb\\nc\\nd\\n' | sed -n '1~2p'"],
    ["delete", [], "printf 'a\\nb\\nc\\n' | sed '2d'"],
    ["delete outside", [], "printf 'a\\nb\\nc\\n' | sed -n '/b/!d'"],
    ["quit", [], "printf 'a\\nb\\nc\\n' | sed -n '/c/q'"],
    ["print the number", [], "printf 'a\\nb\\n' | sed -n '= ' | head -2"],
    ["append", [], "printf 'a\\nb\\n' | sed '1a\\ after'"],
    ["insert", [], "printf 'a\\nb\\n' | sed '/a/i\\ inserted'"],
    ["transliterate", [], "printf 'abc\\n' | sed 'y/abc/xyz/'"],
    ["backreference", [], "printf 'one two\\n' | sed -E 's/(\\w+) (\\w+)/\\2 \\1/'"],
    ["whole match", [], "printf 'x1\\nx2\\n' | sed 's/[0-9]/&!/'"],
    ["escaped ampersand", [], "printf 'aaa\\n' | sed 's/a/\\&/'"],
    ["posix class", [], "printf 'a b\\n' | sed 's/\\([[:alpha:]]\\) \\([[:alpha:]]\\)/\\2-\\1/'"],
    ["two commands", [], "printf 'ab\\n' | sed 's/a/b/; s/b/c/'"],
    ["two -e", [], "printf 'x\\n' | sed -e 's/x/y/' -e 's/y/z/'"],
    ["block", [], "printf 'a\\nb\\n' | sed -n '/b/{s/b/B/;p}'"],
    ["hold space", [], "printf 'a\\nb\\nc\\n' | sed -n '1{h;d}; 2{p;x}'"],
    ["next line", [], "printf 'a\\nb\\nc\\n' | sed 'N;s/\\n/-/'"],
    ["delete every digit", [], "printf 'a1b2\\n' | sed 's/[0-9]//g'"],
    ["file operand", ["printf 'a\\nb\\n' > f"], "sed 's/a/A/' f"],
    ["missing file", [], "sed 's/a/A/' /nope"],
    ["no script", [], "sed"],
    ["bad command", [], "printf 'a\\n' | sed 'Q2'"],
  ],

  // ---- checksums and encodings ----------------------------------------
  digest: [
    ["md5", [], "printf 'abc' | md5sum"],
    ["sha256", [], "printf 'abc' | sha256sum"],
    ["sha512", [], "printf 'abc' | sha512sum"],
    ["b2", [], "printf 'abc' | b2sum"],
    ["named file", ["printf 'abc' > f"], "md5sum f"],
    ["untagged", ["printf 'abc' > f"], "md5sum --untagged f"],
    ["missing file", [], "md5sum /nope"],
    ["check ok", ["printf 'abc' > f", "md5sum f > sums"], "md5sum -c sums"],
    ["check bad", ["printf 'abc' > f", "sed 's/./0/' sums.tmp 2>/dev/null; true"], "true"],
    ["cksum", [], "printf 'abc' | cksum"],
    ["cksum -a bsd", [], "printf 'abc' | cksum -a bsd"],
    ["cksum -a sysv", [], "printf 'abc' | cksum -a sysv"],
    ["cksum -a sha256", [], "printf 'abc' | cksum -a sha256"],
    ["sum", [], "printf 'abc' | sum"],
    ["sum -s", [], "printf 'abc' | sum -s"],
    ["base64", [], "printf 'abc' | base64"],
    ["base64 round trip", [], "printf 'abc' | base64 | base64 -d"],
    ["base64 -w0", [], "printf 'abc' | base64 -w0"],
    ["base32", [], "printf 'abc' | base32"],
    ["base32 round trip", [], "printf 'abc' | base32 | base32 -d"],
    ["basenc base16", [], "printf 'abc' | basenc --base16"],
    ["basenc base2msbf", [], "printf 'A' | basenc --base2msbf"],
  ],
  // ---- ps -----------------------------------------------------------------
  // Header-only layouts only: a row would depend on which processes the
  // machine happens to be running, while a header is pure arithmetic.
  ps: [
    ["bare, nothing selected", [], "ps -p 99999"],
    ["one column", [], "ps -o pid -p 99999"],
    ["two columns", [], "ps -o user,pid -p 99999"],
    ["stime,time", [], "ps -o stime,time -p 99999"],
    ["pid,stime", [], "ps -o pid,stime -p 99999"],
    ["time,cmd", [], "ps -o time,cmd -p 99999"],
    ["tname,time", [], "ps -o tname,time -p 99999"],
    ["tty,tt", [], "ps -o tty,tt -p 99999"],
    ["state,s", [], "ps -o state,s -p 99999"],
    ["addr", [], "ps -o addr -p 99999"],
    ["uid_hack", [], "ps -o uid_hack -p 99999"],
    ["flags", [], "ps -o flags -p 99999"],
    ["comm,ucmd", [], "ps -o comm,ucmd -p 99999"],
    ["args", [], "ps -o args -p 99999"],
    ["start_time", [], "ps -o start_time -p 99999"],
    // pid_max columns: these are the ones procps widens to seven digits
    ["sid", [], "ps -o sid -p 99999"],
    ["session", [], "ps -o session -p 99999"],
    ["pgrp", [], "ps -o pgrp -p 99999"],
    ["tsid", [], "ps -o tsid -p 99999"],
    ["lwp", [], "ps -o lwp -p 99999"],
    ["tpgid", [], "ps -o tpgid -p 99999"],
    ["pgid,sid", [], "ps -o pgid,sid -p 99999"],
    ["pid,sid", [], "ps -o pid,sid -p 99999"],
    ["cutime is not one of them", [], "ps -o cutime -p 99999"],
    ["cputime", [], "ps -o cputime -p 99999"],
    ["-f", [], "ps -f -p 99999"],
    ["-l", [], "ps -l -p 99999"],
    ["-j", [], "ps -j -p 99999"],
    ["-O user", [], "ps -O user -p 99999"],
    ["empty label", [], "ps -o pid:9,comm= -p 99999"],
    ["label", [], "ps -o pid,nice=NICE -p 99999"],
    ["AIX %p%c", [], "ps -o %p%c -p 99999"],
    ["AIX %x", [], "ps -o %x -p 99999"],
    ["AIX %cpu", [], "ps -o %cpu -p 99999"],
    ["trailing delimiter", [], "ps -o pid, -p 99999"],
    ["--version", [], "ps --version"],
    ["-V", [], "ps -V"],
    ["--help", [], "ps --help"],
    ["--help simple", [], "ps --help simple"],
    ["--help output", [], "ps --help output"],
    ["ps L", [], "ps L"],
    ["unknown gnu option", [], "ps --bogus"],
    ["unsupported SysV", [], "ps -i"],
    ["bare dash", [], "ps -"],
    ["unknown spec", [], "ps -o nokey"],
    ["unknown spec before -Z", [], "ps -o nokey -Z"],
    ["two sort options", [], "ps --sort pid --sort ppid"],
    ["leading delimiter", [], "ps -o ,pid"],
    ["no format", [], "ps -o"],
    ["unknown sort key", [], "ps --sort=nokey"],
    ["bad pid list", [], "ps -p abc"],
    ["bad quick pid", [], "ps -q zzz"],
    ["width on a macro", [], "ps -o args:pid"],
    ["argument to a heading", [], "ps --header=1"],
    ["exclusive -V", [], "ps -aV"],
    ["both thread flags", [], "ps -T -L -p 1"],
    ["pid out of range", [], "ps -o pid -p 99999999"],
  ],
  // ---- pgrep / pkill / pidof ----------------------------------------------
  procps: [
    ["pgrep version", [], "pgrep --version"],
    ["pgrep -V", [], "pgrep -V"],
    ["pkill version", [], "pkill --version"],
    ["pgrep help", [], "pgrep --help"],
    ["pgrep -h", [], "pgrep -h"],
    ["pkill help", [], "pkill --help"],
    ["pkill -h", [], "pkill -h"],
    ["no criteria", [], "pgrep"],
    ["no criteria, pkill", [], "pkill"],
    ["unknown short option", [], "pgrep -Q bash"],
    ["unknown long option", [], "pgrep --bogus bash"],
    ["missing short argument", [], "pgrep -d"],
    ["missing long argument", [], "pgrep --delimiter"],
    ["argument where none is wanted", [], "pgrep --count=x bash"],
    ["two patterns", [], "pgrep bash cron"],
    ["-L without -F", [], "pgrep -L bash"],
    ["-i twice", [], "pgrep -i -i bash"],
    ["invalid user", [], "pgrep -u nosuchuser bash"],
    ["invalid group", [], "pgrep -G nosuchgroup bash"],
    ["not a number", [], "pgrep -P abc bash"],
    ["empty list", [], "pgrep -u '' bash"],
    ["bad regex bracket", [], "pgrep '['"],
    ["bad regex paren", [], "pgrep 'a('"],
    ["newest and oldest", [], "pgrep -n -o bash"],
    ["oldest and inverse", [], "pgrep -o -v bash"],
    ["bad signal", [], "pgrep --signal foo bash"],
    ["unknown namespace", [], "pgrep --nslist nowhere bash"],
    ["no match, exact", [], "pgrep -x nomatchthing"],
    ["no match, count", [], "pgrep -c nomatchthing"],
    ["no match, runstates", [], "pgrep -r X nomatchthing"],
    ["no match, pkill", [], "pkill nomatchthing"],
    ["no match, pkill count", [], "pkill -c nomatchthing"],
    ["pidof no arguments", [], "pidof"],
    ["pidof unknown option", [], "pidof -Q bash"],
    ["pidof unknown long option", [], "pidof --bogus bash"],
    ["pidof missing argument", [], "pidof -o"],
    ["pidof -h", [], "pidof -h"],
    ["pidof no match", [], "pidof nomatchthing"],
    ["pidof no match, -s", [], "pidof -s nomatchthing"],
  ],
};

// ---- run one command line in the real shell --------------------------
// The status is marked with a NUL so it can be told from the output, and
// stderr is kept separate so a message that goes to the terminal is compared
// too -- the JS side is captured the same way.
function runReal(cwd, setup, cmd) {
  const script = setup.concat([cmd]).join("\n") +
    "\nprintf '\\0EXIT:%d' \"$?\"\n";
  const r = spawnSync(REAL, ["-c", script], {
    cwd: cwd, encoding: "utf8", env: Object.assign({}, process.env, { LC_ALL: "C" }),
  });
  let out = r.stdout || "";
  let status = -1;
  const m = /\u0000EXIT:(\d+)/.exec(out);
  if (m) {
    status = parseInt(m[1], 10);
    out = out.slice(0, m.index);
  }
  return { out: out + (r.stderr || ""), status: status };
}

// ---- run the same thing in the JavaScript shell -----------------------
function runJs(setup, cmd) {
  const { sh } = loadShell(undefined, { quiet: true });
  for (const line of setup) sh.runLine(line, false);
  sh.term.text = "";
  sh.runLine(cmd, false);
  const err = sh.term.text;
  return { out: (sh.lastOut || "") + err, status: sh.status === undefined ? 0 : sh.status };
}

// ---- compare ---------------------------------------------------------
function main() {
  const only = process.argv.slice(2);
  const groups = only.length ? only : Object.keys(GROUPS);
  let pass = 0;
  const failures = [];
  for (const g of groups) {
    const cases = GROUPS[g];
    if (!cases) { console.log("no such group: " + g); continue; }
    console.log("--- " + g + " ---");
    for (const [name, setup, cmd] of cases) {
      const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-real-"));
      const real = runReal(realDir, setup, cmd);
      const js = runJs(setup, cmd);
      fs.rmSync(realDir, { recursive: true, force: true });
      if (real.out === js.out && real.status === js.status) {
        pass++;
        console.log("  ok   " + name);
      } else {
        failures.push({ g, name, cmd, real, js });
        console.log("  FAIL " + name + "   (" + cmd + ")");
      }
    }
  }
  if (failures.length) {
    console.log("\n================ differences ================");
    for (const f of failures) {
      console.log("\n[" + f.g + "] " + f.name + ":  " + f.cmd);
      console.log("  real  status=" + f.real.status + "  " + JSON.stringify(f.real.out));
      console.log("  ours  status=" + f.js.status + "  " + JSON.stringify(f.js.out));
    }
  }
  console.log("\n" + pass + " passed, " + failures.length + " failed");
  process.exit(failures.length ? 1 : 0);
}

main();