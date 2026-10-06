// Process-model checks: the table, /proc and ps can never disagree, and
// unit<->process changes from systemctl must land where `ps` reads them.
const { loadShell } = require("./shell_harness.js");

let pass = 0, fail = 0;
function eq(what, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log("FAIL " + what + "\n  got  " + JSON.stringify(got) +
              "\n  want " + JSON.stringify(want));
}
function ok(what, cond) {
  if (cond) { pass++; } else { fail++; console.log("FAIL " + what); }
}

function fresh() {
  return loadShell(undefined, { quiet: true, clock: () => "2026-10-05 09:14:03" });
}
function run(h, line) {
  h.sh.term.text = "";
  h.sh.runLine(line, false);
  return { out: (h.sh.lastOut || "") + h.sh.term.text, status: h.sh.status };
}

// ---- spawn & reap around a command --------------------------------------
{
  const h = fresh();
  const r = run(h, "sleep 0");
  ok("sleep returns 0", r.status === 0);
  const s = h.sh.lastOut + h.sh.term.text;
  ok("no proc row for a dead command reaping",
    !glob_any_proc_row(h, "sleep"));
}
function glob_any_proc_row(h, name) {
  const r = run(h, "ps -o comm | grep -c '^" + name + "$' || true");
  // grep count format is just a digit; -c always prints that.
  return r.out.indexOf("1\n") >= 0;
}

// ---- spawn a job, see it, kill it ---------------------------------------
{
  const h = fresh();
  run(h, "sleep 500 &");
  const r = run(h, "ps -eo comm | grep -c '^sleep$' || true");
  eq("exactly one sleep row", r.out, "1\n");
  // The pid it really has appears in the table too.
  const jobs = run(h, "jobs -p");
  const pid = jobs.out.trim();
  ok("jobs -p prints the sleep's pid", pid.length > 0 && /^\d+$/.test(pid));
  const statOK = run(h, "test -f /proc/" + pid + "/stat").status;
  eq("/proc/pid/stat exists", statOK, 0);
  const commFile = run(h, "cat /proc/" + pid + "/comm").out;
  eq("comm file", commFile, "sleep\n");
  const s0 = run(h, "kill -9 %1");
  ok("kill runs", s0.status === 0);
  const after = run(h, "ps -eo comm | grep -c '^sleep$' || true").out;
  eq("no sleep row after kill", after, "0\n");
}

// ---- jobs fields are consistent with ps --------------------------------
{
  const h = fresh();
  run(h, "sleep 500 &");
  const p = run(h, "jobs -p").out.trim();
  ok("have a pid", /^\d+$/.test(p));
  // ps displays that command as sleep.
  const cmd = run(h, "ps -p " + p + " -o comm | tail -1").out.trim();
  eq("ps shows comm sleep", cmd, "sleep");
  // The row vanishes when the job completes -- after a fast-forward wait.
  run(h, "wait");
  const gone = run(h, "ps -p " + p + " -o comm | wc -l").out.trim();
  eq("reaped fromps", gone, "1");   // wc header line only? check: ps oids no header?
}

// ---- /proc shape: fields present and consistent -------------------------
{
  const h = fresh();
  const r = run(h, "ls /proc/1");
  const ct = r.out;
  ok("/proc/1 has comm", ct.indexOf("comm") >= 0);
  ok("/proc/1 has cgroup", ct.indexOf("cgroup") >= 0);
  ok("/proc/1 has environ", ct.indexOf("environ") >= 0);
  ok("/proc/1 has fd", ct.indexOf("fd") >= 0);
  const ct1 = run(h, "cat /proc/1/comm").out.trim();
  eq("comm file", ct1, "systemd");
  const cmd = run(h, "tr '\\0' ' ' < /proc/1/cmdline").out.replace(/ $/, "");
  ok("cmdline non-empty", cmd.trim().length > 0);
}

// ---- cgroup agreement between ps and /proc ------------------------------
{
  const h = fresh();
  const p = run(h, "ps -o comm= -p 1").out.trim();
  eq("pid 1 is systemd", p, "systemd");
  // systemd's main row 1; -o cgroup should agree with the file.
  const a = run(h, "ps -p 1 -o cgroup=").out.trim();
  const b = run(h, "cat /proc/1/cgroup").out.trim();
  eq("ps and /proc agree on cgroup", a, b);
}

// ---- units<-> processes agree -------------------------------------------
{
  const h = fresh();
  // rsyslog.service: stop it and its ps row vanishes; start, it comes back.
  const rows = line => line.split("\n").map(s => s.trim()).filter(s => /rsyslogd/.test(s)).length;
  const before = run(h, "ps -eo comm=").out;
  ok("rsyslogd is on the box", rows(before) > 0);
  run(h, "systemctl stop rsyslog");
  const stopped = rows(run(h, "ps -eo comm=").out);
  eq("rsyslogd is gone after stop", stopped, 0);
  const st = run(h, "systemctl is-active rsyslog").out.trim();
  eq("unit state saysinactive", st, "inactive");
  run(h, "systemctl start rsyslog");
  const back = rows(run(h, "ps -eo comm=").out);
  eq("rsyslogd is back after start", back, 1);
  const active = run(h, "systemctl is-active rsyslog").out.trim();
  eq("unit state active again", active, "active");
}

// ---- a kill of a service pid is single: systemctl then says failed ------
{
  const h = fresh();
  const before = run(h, "ps -eo pid,comm | grep rsyslogd || true").out.match(/\d+/)[0];
  run(h, "kill -9 " + before);
  const st = run(h, "systemctl is-failed rsyslog || true").out.trim();
  eq("unit reports failed after main pid kill", st, "failed");
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
