// ps(1) / procps tests.  The headers and the parse errors are compared against
// the exact strings the host procps prints; the rows are not, because the two
// process tables differ.  run() collects stdout plus stderr the way tools/
// difftest.js does, so both are checked in one string.
const { loadShell } = require("./shell_harness.js");

let pass = 0, fail = 0;
function eq(what, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log("FAIL " + what + "\n  got  " + JSON.stringify(got) +
              "\n  want " + JSON.stringify(want));
}

function ps(args) {
  const h = loadShell(undefined, { quiet: true, clock: () => "2026-10-05 09:14:03" });
  h.sh.term.text = "";
  h.sh.runLine("ps " + args, false);
  return { out: (h.sh.lastOut || "") + h.sh.term.text, status: h.sh.status };
}

// The usage that follows every parse error: "" then "Usage:" ... on stderr.
const HELP = [
  "", "Usage:", " ps [options]", "",
  " Try 'ps --help <simple|list|output|threads|misc|all>'",
  "  or 'ps --help <s|l|o|t|m|a>'",
  " for additional help text.", "",
  "For more details see ps(1).", "",
].join("\n");

function err(args, msg) {
  const r = ps(args);
  eq("ps " + JSON.stringify(args), r.out, "error: " + msg + "\n" + HELP);
  eq("ps " + JSON.stringify(args) + " status", r.status, 1);
}

// ---------------------------------------------------------------- headers --
{
  const r = ps("-p 99999");
  eq("ps -p 99999", r.out, "    PID TTY          TIME CMD\n");
  eq("ps -p 99999 status", r.status, 1);
}
eq("ps -o pid -p 99999", ps("-o pid -p 99999").out, "    PID\n");
eq("ps -o user,pid -p 99999", ps("-o user,pid -p 99999").out, "USER         PID\n");
eq("ps -o stime,time -p 99999", ps("-o stime,time -p 99999").out, "STIME     TIME\n");
eq("ps -o pid,stime -p 99999", ps("-o pid,stime -p 99999").out, "    PID STIME\n");
eq("ps -o time,cmd -p 99999", ps("-o time,cmd -p 99999").out, "    TIME CMD\n");
eq("ps -o tname,time -p 99999", ps("-o tname,time -p 99999").out, "TTY          TIME\n");
eq("ps -f -p 99999", ps("-f -p 99999").out,
   "UID          PID    PPID  C STIME TTY          TIME CMD\n");
eq("ps -l -p 99999", ps("-l -p 99999").out,
   "F S   UID     PID    PPID  C PRI  NI ADDR SZ WCHAN  TTY          TIME CMD\n");
eq("ps -j -p 99999", ps("-j -p 99999").out,
   "    PID    PGID   SID TTY          TIME CMD\n");
eq("ps -O user -p 99999", ps("-O user -p 99999").out,
   "    PID USER     S TTY          TIME COMMAND\n");
// pid 1 belongs to the shell's own world, so this checks the row too.
eq("ps -o pid:9,comm= -p 1", ps("-o pid:9,comm= -p 1").out, "      PID \n        1 systemd\n");
eq("ps -o pid,nice=NICE -p 99999", ps("-o pid,nice=NICE -p 99999").out,
   "    PID NICE\n");
eq("ps -o %p%c -p 99999", ps("-o %p%c -p 99999").out, "    PID COMMAND\n");
eq("ps -o %x -p 99999", ps("-o %x -p 99999").out, "    TIME\n");
eq("ps -o %cpu -p 99999", ps("-o %cpu -p 99999").out, "%CPU\n");
eq("ps -o stime -p 99999", ps("-o stime -p 99999").out, "STIME\n");
// a trailing delimiter is allowed, so this is one column, not four
eq("ps -o pid, -p 99999", ps("-o pid, -p 99999").out, "    PID\n");

// ------------------------------------------------------------------ version
eq("ps --version", ps("--version").out, "ps from procps-ng 4.0.5\n");
eq("ps -V", ps("-V").out, "ps from procps-ng 4.0.5\n");
eq("ps --help", ps("--help").out, HELP);
{
  const r = ps("--help all");
  eq("ps --help all length", r.out.split("\n").length > 40, true);
  eq("ps --help all status", r.status, 0);
}
{
  const r = ps("--help simple");
  eq("ps --help simple", r.out.indexOf("-A, -e") >= 0, true);
}
eq("ps -aV", ps("-aV").out,
   "error: the option is exclusive: -V\n" + HELP);

// ------------------------------------------------------------------- errors
err("--bogus", "unknown gnu long option");
err("-i", "unsupported SysV option");
err("-", "garbage option");
err("-o nokey", "unknown user-defined format specifier \"nokey\"");
err("--sort pid --sort ppid", "multiple sort options");
err("-o ,pid", "improper format list");
err("-o", "format specification must follow -o");
err("--sort=nokey", "unknown sort specifier");
err("-p abc", "process ID list syntax error");
err("-q zzz", "process ID list syntax error");
// the = value keeps its colon; only the specifier itself is width-checked
err("-o args=pid:0,x", "unknown user-defined format specifier \"x\"");
err("-o args:pid", "column widths must be unsigned decimal numbers");
err("-T -L -p 1", "thread flags conflict; can't use both -L and -T");
err("--header=1", "option --heading does not take an argument");

// `--heading x` is a separate word, so the immediate-argument check is silent
// and the `x` still selects processes without a controlling tty.
eq("ps --heading x -p 99999", ps("--heading x -p 99999").out,
   "    PID TTY      STAT   TIME COMMAND\n");
eq("ps --no-headers -p 99999", ps("--no-headers -p 99999").out, "");
// -H and -m disagree, so ps retries as BSD, where -m means "show memory"
eq("ps -H -m -p 99999", ps("-H -m -p 99999").out,
   "    PID TTY      MAJFLT MINFLT   TRS   DRS  SIZE  SWAP   RSS  SHRD   LIB   DT COMMAND\n");
// a quick pid that matches nothing still prints the header and exits 1
eq("ps -q 99999", ps("-q 99999").out, "    PID TTY          TIME CMD\n");

// the first error wins over the BSD retry's
err("-o nokey -Z", "unknown user-defined format specifier \"nokey\"");

console.log("test_ps: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
