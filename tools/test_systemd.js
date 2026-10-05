// systemctl, journalctl and dmesg, checked against the shape and wording the
// real programs use.  There is no systemd on the machine this runs on, so the
// expectations here are the published formats rather than captured output --
// which is why they are written as patterns and structural checks instead of
// exact strings.
//
//   node tools/test_systemd.js
const { loadShell } = require("./shell_harness.js");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log("  ok   " + name); return; }
  fail++;
  console.log("  FAIL " + name + "\n       got  " + JSON.stringify(got) +
              "\n       want " + JSON.stringify(want));
}
function has(name, text, re) {
  if (re.test(text)) { pass++; console.log("  ok   " + name); return; }
  fail++;
  console.log("  FAIL " + name + "\n       got  " + JSON.stringify(text) +
              "\n       want a match for " + re);
}
function lacks(name, text, re) {
  if (!re.test(text)) { pass++; console.log("  ok   " + name); return; }
  fail++;
  console.log("  FAIL " + name + "\n       got  " + JSON.stringify(text) +
              "\n       want no match for " + re);
}

// The boot log the console would have produced, so dmesg and journalctl have
// kernel entries to work with.
const BOOT = [
  "[    0.000000] Linux version 7.2.8 (build@linuxweb) (gcc 14.2.0)",
  "[    0.000000] Command line: BOOT_IMAGE=/boot/vmlinuz-7.2.8",
  "[    1.402135] usb 1-1: new high-speed USB device number 2",
  "[    2.960000] systemd: Startup finished in 1.4s (kernel) + 900ms (userspace) = 2.4s.",
  "",
].join("\n");

function console_(whenMs) {
  const w = loadShell();
  const clock = whenMs === undefined ? Date.UTC(2026, 9, 5, 9, 14, 3) : whenMs;
  w.LW.now = function () { return new Date(clock); };
  // the boot log's own stamps run from 0 to 2.96 seconds
  w.LW.bootTime = function () { return new Date(clock - 4200); };
  w.LW.uptime = function () { return 4.2; };
  w.LW.stampedLog = BOOT;
  w.LW.systemd.init();
  return w;
}

// run a line and hand back stdout and the exit status separately
function run(w, line) {
  w.sh.term.text = "";
  w.sh.lastOut = "";
  w.sh.runLine(line, false);
  return { out: w.sh.lastOut, err: w.sh.term.text, code: w.sh.status === undefined ? 0 : w.sh.status };
}

console.log("--- dmesg: the ring buffer the console printed ---");
{
  const w = console_();
  const r = run(w, "dmesg");
  check("dmesg repeats the boot log verbatim", r.out, BOOT);
  check("dmesg -t drops the stamp", run(w, "dmesg -t | head -1").out,
    "Linux version 7.2.8 (build@linuxweb) (gcc 14.2.0)\n");
  // the first kernel line is stamped 0.000000, so its wall clock is the boot time
  has("dmesg -T prints the wall clock", run(w, "dmesg -T | head -1").out,
    /^\[Mon Oct  5 09:13:58 2026\] Linux version/);
  has("dmesg -H prints the minute", run(w, "dmesg -H | head -1").out,
    /^\[Oct  5 09:13\] Linux version/);
  has("dmesg -H shows the offset since the line before",
    run(w, "dmesg -H").out.split("\n")[3], /^\[  \+1\.557865\] systemd: Startup finished/);
  // the deltas from -H are the same gaps the plain stamps show
  var deltas = run(w, "dmesg -H").out.split("\n").slice(1)
    .filter(function (l) { return /\+[0-9.]+\]/.test(l); })
    .map(function (l) { return parseFloat(/\+([0-9.]+)\]/.exec(l)[1]); });
  check("the offsets add up to the last stamp", deltas.reduce(function (x, y) { return x + y; }, 0).toFixed(6),
    "2.960000");
  has("a level filter lets unprioritised messages through, as the kernel's do",
    run(w, "dmesg -l err | head -1").out, /^\[    0\.000000\] Linux version/);
  has("--help", run(w, "dmesg --help").out, /Display or control the kernel ring buffer\./);
}

console.log("--- journalctl: one boot, in the short format ---");
{
  const w = console_();
  const r = run(w, "journalctl -n 3");
  const lines = r.out.split("\n");
  has("the short format is <when> <host> <ident>[<pid>]: <message>",
    lines[0], /^[A-Z][a-z]{2} [ 0-9]\d \d\d:\d\d:\d\d linuxweb \S+(\[\d+\])?: .+/);
  has("the boot finished last", r.out, /Startup finished in 1\.4s/);
  // four kernel lines, plus the "-- Logs begin" line and the four hint lines
  check("the kernel lines are reachable with -k", run(w, "journalctl -k | wc -l | tr -d ' \n'").out,
    "9");
  check("and -k leaves out the unit events",
    run(w, "journalctl -k | grep -c Started | tr -d ' \n'").out, "0");
  has("a unit filter selects that unit", run(w, "journalctl -u ssh").out,
    /ssh\[\d+\]: Started OpenBSD Secure Shell server\./);
  has("-b reads this boot", run(w, "journalctl -b -n 1").out, /Linux version|Startup finished/);
  has("-r reverses", (function () {
    const fwd = run(w, "journalctl -n 2").out.split("\n");
    const rev = run(w, "journalctl -n 2 -r").out.split("\n");
    return rev[0] === fwd[1] && rev[1] === fwd[0];
  })() ? "yes" : "no", /^yes$/);
  has("-o cat drops the prefix", run(w, "journalctl -o cat -n 1").out,
    /^(Started|Reached|Startup)/);
  has("-o json is json", run(w, "journalctl -o json -n 1").out.trim().slice(0, 1), /^\{/);
  has("-o export is the field format", run(w, "journalctl -o export -n 1").out,
    /^__REALTIME_TIMESTAMP=\d+/);
  has("--disk-usage", run(w, "journalctl --disk-usage").out,
    /^Archived and active journals take up .* on disk\.\n$/);
  has("--list-boots", run(w, "journalctl --list-boots").out, /ID BOOT TITLE/);
  has("an empty selection says so", run(w, "journalctl -u nosuchunit").err + run(w, "journalctl -u nosuchunit").out,
    /-- No entries --/);
}

console.log("--- systemctl status ---");
{
  const w = console_();
  const r = run(w, "systemctl status ssh --plain");
  const text = r.out.replace(/^ +/, "");
  has("the state marker and the description", text, /^[●×○] ssh\.service - OpenBSD Secure Shell server/);
  has("the Loaded line names the unit file and its enablement", text,
    /^ {5}Loaded: loaded \(\/lib\/systemd\/system\/ssh\.service; enabled; vendor preset: enabled\)$/m);
  has("the Active line carries the state, since-time and elapsed",
    text, /^ {5}Active: active \(running\) since \w{3} \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC; .+ ago$/m);
  has("Main PID", text, /^ {3}Main PID: \d+ \(\w+\)$/m);
  has("Tasks", text, /^ {6}Tasks: \d+ \(limit: 3832\)$/m);
  has("Memory", text, /^ {5}Memory: [\d.]+[KM]$/m);
  has("CGroup", text, /^ {7}CGroup: \/system\.slice\/ssh\.service$/m);
  has("the process tree", text, /└─\d+ \/usr\/sbin\/sshd/);
  has("the journal lines are shown", text, /^Journal:\n {5}• \w{3} \d\d \d\d:\d\d:\d\d linuxweb ssh\[/m);
  check("an active unit exits 0", run(w, "systemctl status ssh --plain").code, 0);
  has("a failed unit is marked", run(w, "systemctl status apache2 --plain").out,
    /^× apache2\.service - The Apache HTTP Server/);
  has("a failed unit reports its result", run(w, "systemctl status apache2 --plain").out,
    /Active: failed \(Result: exit-code\) since/);
  check("a failed unit exits 1", run(w, "systemctl status apache2 --plain").code, 1);
  has("an inactive unit is an empty circle", run(w, "systemctl status nginx --plain").out,
    /^○ nginx\.service/);
  check("an unknown unit is an error", run(w, "systemctl status nosuch").err,
    "Unit nosuch.service could not be found.\n");
  check("and exits 4", run(w, "systemctl status nosuch").code, 4);
}

console.log("--- systemctl: asking about units ---");
{
  const w = console_();
  check("is-active on a running service", run(w, "systemctl is-active ssh").out, "active\n");
  check("is-active exits 0 for it", run(w, "systemctl is-active ssh").code, 0);
  check("is-active on a stopped service", run(w, "systemctl is-active nginx").out, "inactive\n");
  check("is-active exits 3 for it", run(w, "systemctl is-active nginx").code, 3);
  check("is-active on a failed service", run(w, "systemctl is-active apache2").out, "failed\n");
  check("is-active on a unit it has never heard of", run(w, "systemctl is-active nosuch").out,
    "inactive\n");
  check("and exits 4", run(w, "systemctl is-active nosuch").code, 4);
  check("is-enabled", run(w, "systemctl is-enabled nginx").out, "disabled\n");
  check("a static unit reports static", run(w, "systemctl is-enabled systemd-journald").out,
    "static\n");
  check("an alias reports alias", run(w, "systemctl is-enabled sshd").out, "alias\n");
  check("is-failed", run(w, "systemctl is-failed apache2").out, "failed\n");
  check("several units at once", run(w, "systemctl is-active ssh nginx").out, "active\ninactive\n");
}

console.log("--- systemctl: changing things ---");
{
  const w = console_();
  check("start is quiet and works", run(w, "systemctl start nginx; systemctl is-active nginx").out,
    "active\n");
  check("stop is quiet and works", run(w, "systemctl stop nginx; systemctl is-active nginx").out,
    "inactive\n");
  check("restart leaves it running", run(w, "systemctl restart cron; systemctl is-active cron").out,
    "active\n");
  has("a start is written to the journal", run(w, "journalctl -u nginx").out,
    /Started A high performance web server/);
  has("a stop is written to the journal", run(w, "journalctl -u nginx").out, /Stopped A high performance/);
  has("enable says what it created", run(w, "systemctl enable nginx").out,
    /Created symlink \/etc\/systemd\/system\/multi-user\.target\.wants\/nginx\.service/);
  check("and the unit now reports enabled", run(w, "systemctl is-enabled nginx").out, "enabled\n");
  has("disable says what it removed", run(w, "systemctl disable nginx").out,
    /Removed \/etc\/systemd\/system\/multi-user\.target\.wants\/nginx\.service/);
  has("a static unit cannot be enabled", run(w, "systemctl enable systemd-journald").err,
    /no installation config \(static\)/);
  has("starting something unknown fails", run(w, "systemctl start nosuch").err,
    /Failed to start nosuch\.service\. Unit nosuch\.service not found\./);
  has("an unknown verb is a usage error", run(w, "systemctl frobnicate").err,
    /Unknown operation frobnicate\./);
  has("with the hint line", run(w, "systemctl frobnicate").err,
    /Try 'systemctl --help' for more information\./);
}

console.log("--- systemctl: listing ---");
{
  const w = console_();
  const all = run(w, "systemctl list-units").out.split("\n");
  // the listing ends with a blank line, the count and the final newline, so the
  // data rows are picked out rather than sliced off by index
  const units = [all[0]].concat(all.slice(1).filter(function (l) {
    return l && !/loaded units listed\.$/.test(l);
  }));
  has("a header row", units[0], /^ {2}UNIT +LOAD +ACTIVE +SUB +DESCRIPTION$/);
  has("a row per unit, in order", units[1],
    /^ {2}proc-sys-fs-binfmt_misc\.automount +loaded +active +active +Arbitrary Executable/);
  // a table means every column starts in the same place on every row
  var at = ["LOAD", "ACTIVE", "SUB", "DESCRIPTION"].map(function (name) {
    return units[0].indexOf(name);
  });
  has("the header's columns are in order UNIT LOAD ACTIVE SUB DESCRIPTION",
    at.every(function (x, i) { return i === 0 || x > at[i - 1]; }) ? "yes" : "no", /^yes$/);
  const rows = units.slice(1);
  has("every row's LOAD column starts under the header's LOAD column",
    rows.every(function (row) {
      return row.slice(at[0], at[0] + 6).trim() === "loaded" ||
             row.slice(at[0], at[0] + 5).trim() === "alias";
    }) ? "yes" : "no", /^yes$/);
  has("every row's ACTIVE column starts under the header's ACTIVE column",
    rows.every(function (row) {
      return /^(active|inactive|failed|activating|deactivating)/.test(row.slice(at[1]));
    }) ? "yes" : "no", /^yes$/);
  has("every row's SUB column starts under the header's SUB column",
    rows.every(function (row) {
      return /^(running|dead|exited|active|failed|start)/.test(row.slice(at[2]));
    }) ? "yes" : "no", /^yes$/);
  has("a count at the end", run(w, "systemctl list-units").out, /\n\n\d+ loaded units listed\.\n$/);
  check("--no-legend drops the header",
    run(w, "systemctl --no-legend list-units | head -1").out, units[1] + "\n");
  // the header, the failed unit, a blank line and the count
  check("--failed keeps only the failed unit",
    run(w, "systemctl list-units --failed | wc -l | tr -d ' \n'").out, "4");
  has("--type filters", run(w, "systemctl list-units --type=target | head -2").out,
    /^ {2}UNIT .*\n {2}getty\.target/);
  has("list-unit-files has its own header",
    run(w, "systemctl list-unit-files | head -1").out.replace(/\n$/, ""), /^ {2}UNIT FILE +STATE +PRESET$/);
}

console.log("--- systemctl cat ---");
{
  const w = console_();
  const r = run(w, "systemctl cat ssh");
  has("the unit file is shown with its path", r.out,
    /^# \/lib\/systemd\/system\/ssh\.service\n\[Unit\]\nDescription=OpenBSD Secure Shell server/);
  check("it agrees with cat on the same file",
    r.out.replace(/^# .*\n/, ""), run(w, "cat /lib/systemd/system/ssh.service").out);
  // every unit that names a unit file must have written one; aliases and
  // template instances share a file, so the paths are counted once
  var files = {};
  w.LW.systemd.units.forEach(function (u) { if (u.file) files[u.file] = true; });
  check("every unit that names a file has one on disk",
    run(w, "ls -1 /lib/systemd/system | wc -l | tr -d ' \n'").out, String(Object.keys(files).length));
}

console.log("--- the two help texts ---");
{
  const w = console_();
  has("systemctl --help", run(w, "systemctl --help").out, /^systemctl \[OPTIONS\.\.\.\] COMMAND \[UNIT\.\.\.\]/);
  has("journalctl --help", run(w, "journalctl --help").out, /^journalctl \[OPTIONS\.\.\.\] \[MATCHES\.\.\.\]/);
  has("the systemd version", run(w, "systemctl --version").out, /^systemd 257 \(257\.5/);
  has("with the build options", run(w, "journalctl --version").out, /\+PAM \+AUDIT/);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);