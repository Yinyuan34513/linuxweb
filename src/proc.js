// The process table: what is running on this machine.
//
// Everything that reports on running processes reads this one table, so `ps`,
// `jobs`, `kill`, `/proc` and `systemctl status` cannot disagree with each
// other.  It is seeded the way the machine it pretends to be would come up:
// the kernel threads, the units src/systemd.js says are running (with the
// main pid that unit really has), the gettys on the six virtual terminals,
// and -- once somebody logs in -- the login shell on that terminal.
//
// Two things keep the illusion honest:
//
//   * times are stored as seconds since boot, never as wall-clock stamps, so
//     the table is right whichever clock LW.now() is showing when it is read;
//   * every process the shell runs is spawned and reaped around the command,
//     which is why `ps` finds `ps` in its own output.
//
// /proc is rebuilt from the same entries (src/proc.js mounts the directories),
// so `cat /proc/$(pidof bash)/stat` says what `ps -o stat` says.
//
// Requires: vfs.js, systemd.js.  Loaded before the command files that use it.
(function (LW) {
  "use strict";

  var V = LW.VFS;

  // ---- signals ------------------------------------------------------------
  //
  // The names kill(1) accepts, with the numbers the kernel uses.  `kill -l`
  // prints them in this order, two-digit aligned, exactly as bash does.
  var SIGNALS = [
    "EXIT", "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE",
    "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM", "STKFLT", "CHLD",
    "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU", "XFSZ", "VTALRM",
    "PROF", "WINCH", "IO", "PWR", "SYS",
  ];
  var SIG = {};
  SIGNALS.forEach(function (n, i) { SIG[n] = i; });

  // Signals that stop a process rather than end it, and the one that resumes.
  var STOPPERS = { STOP: 1, TSTP: 1, TTIN: 1, TTOU: 1 };
  // The rest of the "default action is terminate" set.  CHLD, CONT, WINCH,
  // URG, USR1/USR2 and the real-time ones leave the process alone here -- a
  // process in a simulation has no handler to run and nothing to interrupt.
  var FATAL = { HUP: 1, INT: 1, QUIT: 1, ILL: 1, TRAP: 1, ABRT: 1, BUS: 1,
                FPE: 1, KILL: 1, SEGV: 1, PIPE: 1, ALRM: 1, TERM: 1,
                STKFLT: 1, XCPU: 1, XFSZ: 1, VTALRM: 1, PROF: 1, IO: 1,
                PWR: 1, SYS: 1 };

  // "9", "kill", "KILL", "SIGTERM" -> 9 / 15, or null when it is not a signal.
  function signalNumber(word) {
    if (word === undefined || word === null) return null;
    var s = String(word).replace(/^SIG/i, "");
    if (/^\d+$/.test(s)) { var n = parseInt(s, 10); return n >= 0 && n <= 64 ? n : null; }
    if (/^RTMIN/i.test(s)) return 34;
    if (/^RTMAX/i.test(s)) return 64;
    return Object.prototype.hasOwnProperty.call(SIG, s.toUpperCase()) ? SIG[s.toUpperCase()] : null;
  }

  function signalName(num) { return SIGNALS[num] || String(num); }

  // ---- the table ----------------------------------------------------------

  var table = [];        // entries, always in pid order
  var seeded = false;
  var nextPid = 1100;
  var shellPid = 0;      // the login shell of the terminal we are running on
  var inCommand = false; // the shell is running a command: it is not fg

  function bootTime() { return LW.bootTime ? LW.bootTime() : new Date(0); }
  function uptime() { return LW.uptime ? Math.max(LW.uptime(), 0) : 1; }

  function sort() { table.sort(function (a, b) { return a.pid - b.pid; }); }

  function get(pid) {
    pid = Number(pid);
    for (var i = 0; i < table.length; i++) if (table[i].pid === pid) return table[i];
    return null;
  }

  function list() { return table.slice(); }

  function childrenOf(pid) {
    return table.filter(function (e) { return e.ppid === pid; });
  }

  // Spawn: the caller supplies everything the table needs to describe the
  // process; only the pid is ours to invent.  pids only ever go up, the way
  // they do on a machine that has been up for a while.
  function spawn(o) {
    // The name a process is known by passes through a 16-byte buffer in the
    // kernel (TASK_COMM_LEN), so /proc/pid/stat holds at most 15 characters
    // of it: on a real machine `ps -o comm` says "systemd-journal", and
    // `pgrep -x systemd-journald` finds nothing.  argv and the exe path keep
    // the whole name, which is why `pstree -a` still prints it in full.
    var comm = o.comm || "?";
    if (comm.length > 15) comm = comm.slice(0, 15);
    var e = {
      pid: o.pid || nextPid++,
      ppid: o.ppid === undefined ? 1 : o.ppid,
      user: o.user || "root",
      uid: o.uid === undefined ? (o.user === "linuxweb" ? 1000 : 0) : o.uid,
      tty: o.tty || "?",
      comm: comm,
      args: o.args === undefined ? (o.comm || "?") : o.args,
      stat: o.stat || "S",
      fg: !!o.fg,
      since: o.since === undefined ? 0 : o.since,
      cpu: o.cpu || 0,
      vsz: o.vsz || 0,
      rss: o.rss || 0,
      unit: o.unit || "",
      wchan: o.wchan || "0",
      cwd: o.cwd || "/",
      exe: o.exe || "/usr/bin/" + (o.comm || ""),
      env: o.env || null,
      kernel: !!o.kernel,
      job: o.job || 0,     // shell job number, for the jobs table
      zombie: false,
    };
    // A session or process-group leader is marked in STAT (the little `s`).
    // The seed sets it; the shell sets it when it binds to a terminal; a
    // command the shell starts does not get it, because the shell is the
    // leader.  sid/pgid may be forced by the caller -- job control needs to
    // put every job in a process group of its own.
    e.leader = e.stat.charAt(1) === "s";
    if (o.sid !== undefined) e.sid = o.sid;
    if (o.pgid !== undefined) e.pgid = o.pgid;
    if (o.since === undefined) e.since = uptime();
    table.push(e);
    sort();
    return e;
  }

  // A process that has been signalled or has exited leaves the table once the
  // shell reaps it, so `ps` can still show a `Z` in between -- which is what
  // a real ps shows for a background job that finished a moment ago.
  function exitProcess(pid, state) {
    var e = get(pid);
    if (!e || e.zombie) return null;
    e.zombie = true;
    e.stat = "Z";
    e.fg = false;
    e.exitState = state === undefined ? 0 : state;
    return e;
  }

  function reap() {
    var kept = table.filter(function (e) { return !e.zombie; });
    if (kept.length !== table.length) { table = kept; sort(); }
  }

  // Send a signal.  Returns false when there is nothing of that pid, which is
  // what `kill` reports as "No such process".
  function kill(pid, sigNum) {
    var e = get(pid);
    if (!e || e.zombie) return false;
    var name = signalName(sigNum);
    if (STOPPERS[name]) { e.stat = "T"; e.fg = false; return true; }
    if (name === "CONT") { if (e.stat === "T") e.stat = "S"; return true; }
    if (name === "CHLD") return true;
    if (FATAL[name]) {
      // A unit's main process dying is a unit failure, not just a vanished
      // pid: systemd notices, and `systemctl status` has to say so.
      if (e.unit && LW.systemd && LW.systemd.unitDied) LW.systemd.unitDied(e.unit, sigNum);
      removeUnitProcess(e);
      exitProcess(pid, 128 + (sigNum || 15));
      return true;
    }
    return true;
  }

  // When a service's main process dies, drop it from the table.  Child
  // processes of that unit go with it (a daemon's workers are not left
  // running behind a dead master).
  function removeUnitProcess(e) {
    if (!e.unit) return;
    var unit = e.unit;
    table.slice().forEach(function (o) {
      if (o.pid !== e.pid && o.unit === unit) exitProcess(o.pid, 128 + 9);
    });
  }

  function killByName(name, sigNum, exact) {
    var hits = table.filter(function (e) {
      if (e.zombie) return false;
      if (exact) return e.comm === name;
      return e.comm === name || e.args === name ||
        e.args.split(" ")[0].split("/").pop() === name;
    });
    hits.forEach(function (e) { kill(e.pid, sigNum); });
    return hits;
  }

  // ---- what the columns say ----------------------------------------------

  // The state letter plus procps' extra flags: `s` session leader, `+` the
  // foreground process group of its terminal, `l` more than one thread.
  // `Ss`, `R+`, `T`, `Z`: the state letter, the flags ps adds (session
  // leader, foreground process group), and nothing else.
  function stat(e) {
    var s = e.stat || "S";
    if (e.zombie || s.charAt(0) === "Z") return "Z";
    if (s.charAt(0) === "T") return "T" + (e.fg ? "+" : "");
    return s + (e.fg ? "+" : "");
  }

  // ---- sessions, process groups, terminals --------------------------------
  //
  // /proc/pid/stat, /proc/pid/status and ps all ask the same three questions,
  // so they ask them here and can never disagree: a session or process-group
  // leader starts its own, every other process follows its parent, and a
  // process with no parent left (pid 1 and kthreadd at boot, or a process
  // whose parent has been reaped) ends up with pid 1 or with nothing at all.

  function isLeader(e) { return !!e && !!e.leader; }

  function walkLead(e, isPgid) {
    var cur = e, n = 0;
    while (cur && n++ < 128) {
      if (cur.leader) return cur.pid;
      if (!cur.ppid) return 0;            // pid 1's parent, kthreadd's: none
      var par = get(cur.ppid);
      if (!par) return 1;                 // orphan: pid 1 adopts it
      cur = par;
    }
    return 0;
  }

  function pgid(e) {
    if (!e) return 0;
    if (e.pgid !== undefined) return e.pgid;
    e.pgid = walkLead(e, true);
    return e.pgid;
  }

  function sid(e) {
    if (!e) return 0;
    if (e.sid !== undefined) return e.sid;
    e.sid = walkLead(e, false);
    return e.sid;
  }

  // The process group in the foreground of a terminal: the job the shell has
  // running on it, or -- when the shell is back at its prompt -- the shell's
  // own group.  A process with no terminal has none (-1).
  function tpgid(e) {
    if (!e || !e.tty || e.tty === "?") return -1;
    var i, o;
    for (i = 0; i < table.length; i++) {
      o = table[i];
      if (o.tty === e.tty && o.fg && !o.zombie) return pgid(o);
    }
    for (i = 0; i < table.length; i++) {
      o = table[i];
      if (o.tty === e.tty && o.leader && !o.zombie) return pgid(o);
    }
    return -1;
  }

  // tty numbers as linux/serial.h packs them: 4,1 for /dev/tty1, 136,0 for
  // /dev/pts/0.  --proc/pid/stat field 7.
  function ttyNr(e) {
    var m;
    if (!e.tty || e.tty === "?") return 0;
    if ((m = /^tty(\d+)$/.exec(e.tty))) return (4 << 8) | (+m[1] & 0xff);
    if ((m = /^pts\/(\d+)$/.exec(e.tty))) return (136 << 8) | (+m[1] & 0xff);
    if (e.tty === "console") return (5 << 8) | 1;
    return 0;
  }

  // One gid, one group name and the supplementary list, the way /etc/group
  // and /proc/pid/status spell them: root's group, or linuxweb + sudo.
  function gid(e) { return e && e.uid ? 1000 : 0; }
  function groupName(e) { return e && e.uid ? "linuxweb" : "root"; }
  function groupList(e) { return e && e.uid ? "1000 27" : ""; }

  // Page faults.  Kernel threads have none; the rest tick up with the pid, so
  // a number in ps is the same number in /proc/pid/stat.
  function faults(e) {
    if (e.kernel) return [0, 0];
    return [128 + (e.pid * 37) % 4096, (e.pid * 13) % 97];
  }

  // Capability masks: root keeps everything, a user process keeps nothing,
  // the bounding set is never dropped.  Written the way the kernel writes
  // them, 16 hex digits, so /proc/pid/status and ps agree.
  function caps(e) {
    var full = "000001ffffffffff", none = "0000000000000000";
    var mine = e && e.uid ? none : full;
    return { prm: mine, eff: mine, bnd: full };
  }

  // Signal masks, shared by /proc/pid/status and the ps signal columns.
  var SIGMASKS = {
    pnd: "0000000000000000", blk: "0000000000000000",
    ign: "0000000100004600", cgt: "0000000180004400",
  };

  function started(e) { return new Date(bootTime().getTime() + e.since * 1000); }

  // [[DD-]HH:]MM:SS -- what ps prints for ELAPSED/ETIME.
  function elapsed(e, wide) {
    var s = Math.max(0, Math.floor(uptime() - e.since));
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    function two(n) { return (n < 10 ? "0" : "") + n; }
    if (d) return d + "-" + two(h) + ":" + two(m) + ":" + two(s);
    if (wide || h) return two(h) + ":" + two(m) + ":" + two(s);
    return two(m) + ":" + two(s);
  }

  // CPU time as HH:MM:SS (GNU style) or the shorter form ps aux uses.
  function cpuTime(e, style) {
    var t = Math.floor(e.cpu);
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    function two(n) { return (n < 10 ? "0" : "") + n; }
    if (style === "clock") return two(h) + ":" + two(m) + ":" + two(s);
    if (style === "hms-short") {                  // aux: 1:23, or 1-02:03:04
      if (h >= 24) return Math.floor(h / 24) + "-" + two(h % 24) + ":" + two(m) + ":" + two(s);
      if (h) return h + ":" + two(m) + ":" + two(s);
      return m + ":" + two(s);
    }
    return (h ? h + ":" : "") + two(m) + ":" + two(s);
  }

  // %CPU: the average since the process started, the way ps computes it, so
  // it settles down as the machine's uptime grows.
  function pcpu(e) {
    var span = Math.max(uptime() - e.since, 0.5);
    var v = e.cpu / span * 100;
    return v > 999 ? 999.9 : v;
  }

  function pmem(e) {
    var total = 2032604;                       // kB, as /proc/meminfo says
    return e.rss / total * 100;
  }

  // Start time in the two shapes ps prints: HH:MM (aux) and HH:MM:SS (-o).
  function startTime(e, style) {
    var d = started(e);
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) +
      (style === "long" ? ":" + two(d.getUTCSeconds()) : "");
  }

  // ---- the boot -----------------------------------------------------------

  // Kernel threads: pid, comm, stat, seconds after boot.  They are the reason
  // `ps aux` looks like a real machine's: half of it is brackets.
  var KTHREADS = [
    [2, "kthreadd", "S", 0.00],
    [3, "pool_workqueue_release", "S", 0.00],
    [4, "kworker/R-rcu_g", "I<", 0.00],
    [5, "kworker/R-rcu_p", "I<", 0.00],
    [6, "kworker/R-slub_", "I<", 0.00],
    [7, "kworker/R-netns", "I<", 0.00],
    [8, "kworker/0:0-mm_percpu_wq", "I", 0.01],
    [9, "kworker/0:1", "I", 0.01],
    [10, "kworker/0:0H", "I<", 0.01],
    [11, "kworker/1:0", "I", 0.01],
    [12, "kworker/1:1", "I", 0.01],
    [13, "kworker/u4:0", "I", 0.02],
    [14, "kworker/u4:1", "I", 0.02],
    [15, "cpuhp/0", "S", 0.02],
    [16, "cpuhp/1", "S", 0.02],
    [17, "migration/0", "S", 0.02],
    [18, "migration/1", "S", 0.02],
    [19, "idle_inject/0", "S", 0.03],
    [20, "idle_inject/1", "S", 0.03],
    [21, "ksoftirqd/0", "S", 0.03],
    [22, "ksoftirqd/1", "S", 0.03],
    [23, "rcu_preempt", "S", 0.04],
    [24, "rcuog/0", "S", 0.04],
    [25, "rcuop/0", "S", 0.04],
    [26, "rcuoc/0", "S", 0.04],
    [27, "kswapd0", "S", 0.05],
    [28, "kcompactd0", "S", 0.05],
    [29, "kdevtmpfs", "S", 0.06],
    [30, "kauditd", "S", 0.06],
    [31, "khungtaskd", "S", 0.07],
    [32, "oom_reaper", "S", 0.07],
    [33, "writeback", "S", 0.08],
    [34, "kblockd", "S", 0.08],
    [35, "kstrp", "S", 0.09],
    [36, "edac-poller", "S", 0.09],
    [37, "devfreq_wq", "S", 0.10],
    [38, "watchdog/0", "S", 0.10],
    [39, "watchdog/1", "S", 0.10],
    [40, "ipv6_addrconf", "S", 0.11],
    [41, "kthrotld", "S", 0.11],
    [42, "mm_percpu_wq", "S", 0.12],
    [43, "netns", "S", 0.12],
    [44, "scsi_eh_0", "S", 0.13],
    [45, "jbd2/sda1-8", "S", 0.30],
    [46, "ext4-rsv-conver", "S", 0.30],
  ];

  // The user-space processes the units own.  pids and memory are what a
  // Debian VM of this size really shows for each daemon; `since` is when
  // systemd started it, which is also what the journal says.
  var SERVICES = [
    { pid: 1, unit: "", comm: "systemd", args: "/sbin/init splash", stat: "Ss",
      exe: "/usr/lib/systemd/systemd", vsz: 23416, rss: 13220, cpu: 1.02, since: 0.00,
      cwd: "/", wchan: "do_wait", env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C.UTF-8", "INVOCATION_ID=6f1a0b5c2d4e4f60", "JOURNAL_STREAM=8:12345"] },
    { pid: 387, unit: "systemd-udevd.service", comm: "systemd-udevd",
      args: "/usr/lib/systemd/systemd-udevd --daemon", stat: "Ss",
      exe: "/usr/lib/systemd/systemd-udevd", vsz: 29760, rss: 7168, cpu: 0.44, since: 1.20,
      cwd: "/", wchan: "do_wait", env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C.UTF-8", "DAEMON_STDOUT=/dev/null", "DAEMON_STDERR=/dev/null"] },
    { pid: 418, unit: "systemd-journald.service", comm: "systemd-journald",
      args: "/usr/lib/systemd/systemd-journald", stat: "Ss",
      exe: "/usr/lib/systemd/systemd-journald", vsz: 195680, rss: 15744, cpu: 0.86, since: 0.90,
      cwd: "/", wchan: "pipe_read", env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C.UTF-8", "JOURNAL_STREAM=8:10001", "SYSTEMD_JOURNAL=TRUSTED"] },
    { pid: 512, unit: "systemd-logind.service", comm: "systemd-logind",
      args: "/usr/lib/systemd/systemd-logind", stat: "Ss",
      exe: "/usr/lib/systemd/systemd-logind", vsz: 18524, rss: 8492, cpu: 0.11, since: 2.40,
      cwd: "/", wchan: "do_select", env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C.UTF-8", "INVOCATION_ID=9a3b7c11d5e64a80"] },
    { pid: 588, unit: "systemd-timesyncd.service", comm: "systemd-timesyncd",
      args: "/usr/lib/systemd/systemd-timesyncd", stat: "Ssl",
      exe: "/usr/lib/systemd/systemd-timesyncd", vsz: 92184, rss: 8192, cpu: 0.03, since: 3.10,
      cwd: "/", wchan: "do_select", env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C.UTF-8"] },
    { pid: 654, unit: "cron.service", comm: "cron", args: "/usr/sbin/cron -f -P", stat: "Ss",
      exe: "/usr/sbin/cron", vsz: 14480, rss: 2304, cpu: 0.02, since: 3.40,
      cwd: "/", wchan: "do_wait", env: ["PATH=/usr/bin:/bin", "LANG=C.UTF-8", "SHELL=/bin/sh"] },
    { pid: 671, unit: "rsyslog.service", comm: "rsyslogd", args: "/usr/sbin/rsyslogd -n", stat: "Ssl",
      exe: "/usr/sbin/rsyslogd", vsz: 151200, rss: 5568, cpu: 0.09, since: 3.60,
      cwd: "/", wchan: "do_sys_poll", env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C.UTF-8"] },
    { pid: 706, unit: "ssh.service", comm: "sshd",
      args: "/usr/sbin/sshd -D [listener] 0 of 10-100 startups", stat: "Ss",
      exe: "/usr/sbin/sshd", vsz: 91696, rss: 5608, cpu: 0.05, since: 4.10,
      cwd: "/", wchan: "do_pselect", env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LANG=C.UTF-8", "SSHD_PID=706"] },
    { pid: 903, unit: "user@1000.service", comm: "systemd",
      args: "/usr/lib/systemd/systemd --user", stat: "Ss", user: "linuxweb",
      exe: "/usr/lib/systemd/systemd", vsz: 21744, rss: 11904, cpu: 0.21, since: 3.90,
      cwd: "/home/linuxweb", wchan: "do_wait",
      env: ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "XDG_RUNTIME_DIR=/run/user/1000",
        "JOURNAL_STREAM=8:20011"] },
    { pid: 904, unit: "user@1000.service", comm: "(sd-pam)", args: "(sd-pam)", stat: "S",
      ppid: 903, user: "linuxweb", exe: "/usr/lib/systemd/systemd", vsz: 20260, rss: 2048,
      cpu: 0.01, since: 3.91, cwd: "/home/linuxweb", wchan: "do_wait",
      env: ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "XDG_RUNTIME_DIR=/run/user/1000"] },
  ];

  // The gettys.  Six of them: main.js brings one up on each of the six
  // virtual terminals, and this is what ps shows for them.
  var GETTY_PIDS = { tty1: 1044, tty2: 1045, tty3: 1046, tty4: 1047, tty5: 1048, tty6: 1049 };
  var GETTY_ARGS = "/sbin/agetty -o -p -- \\u --noclear - linux";

  function gettyPid(tty) {
    if (GETTY_PIDS[tty]) return GETTY_PIDS[tty];
    // a terminal main.js has not claimed: keep the numbers moving up
    var base = 1044 + Object.keys(GETTY_PIDS).length;
    GETTY_PIDS[tty] = base;
    return base;
  }

  function seed() {
    KTHREADS.forEach(function (k) {
      spawn({ pid: k[0], ppid: k[0] === 2 ? 0 : 2, user: "root", uid: 0, tty: "?",
              comm: k[1], args: "[" + k[1] + "]", stat: k[2], since: k[3],
              cpu: 0, vsz: 0, rss: 0, kernel: true, wchan: "0",
              exe: "[" + k[1] + "]" });
    });
    SERVICES.forEach(function (s) {
      var e = spawn({ pid: s.pid, ppid: s.ppid === undefined ? (s.pid === 1 ? 0 : 1) : s.ppid, user: s.user || "root",
                      uid: s.user === "linuxweb" ? 1000 : 0, tty: "?", comm: s.comm, args: s.args,
                      stat: s.stat, since: s.since, cpu: s.cpu, vsz: s.vsz, rss: s.rss,
                      unit: s.unit, wchan: s.wchan, cwd: s.cwd, exe: s.exe, env: s.env });
      e.origPid = e.pid;
    });
    Object.keys(GETTY_PIDS).forEach(function (tty) {
      spawn({ pid: GETTY_PIDS[tty], ppid: 1, user: "root", uid: 0, tty: tty,
              comm: "agetty", args: GETTY_ARGS, stat: "Ss", since: 4.60, cpu: 0.01,
              vsz: 17312, rss: 2816, wchan: "do_select", cwd: "/", exe: "/sbin/agetty",
              env: ["TERM=linux", "LANG=C.UTF-8", "PATH=/usr/local/bin:/usr/bin:/bin"] });
    });
  }

  // ---- units and processes ------------------------------------------------
  //
  // systemd is the source of truth for whether a service runs; when it starts
  // or stops one, the process appears or goes with it.  src/systemd.js calls
  // these through LW.proc, so `systemctl stop ssh` empties the row `ps` was
  // showing a second earlier.
  function attachUnit(u) {
    if (!u || !u.pid || u.kind === "target" || u.kind === "mount") return null;
    var existing = table.filter(function (e) { return e.unit === u.unit && !e.zombie; });
    if (existing.length && existing[0].pid === u.pid) return existing[0];
    existing.forEach(function (e) { exitProcess(e.pid, 0); reap(); });
    var path = (LW.systemd && LW.systemd.execPath) ? LW.systemd.execPath(u) : "";
    var name = (path.split("/").pop()) || u.unit.split(".")[0];
    var args = path;
    if (name === "sshd") args = "/usr/sbin/sshd -D [listener] 0 of 10-100 startups";
    else if (name === "cron") args = "/usr/sbin/cron -f -P";
    else if (name === "rsyslogd") args = "/usr/sbin/rsyslogd -n";
    else if (name === "systemd-udevd") args = "/usr/lib/systemd/systemd-udevd --daemon";
    else if (name === "apache2") args = "/usr/sbin/apache2 -k start";
    else if (name === "nginx") args = "nginx: master process /usr/sbin/nginx";
    return spawn({ pid: u.pid, ppid: 1, user: "root", uid: 0, tty: "?",
                   comm: name.slice(0, 15) || u.unit.slice(0, 15), args: args || u.unit,
                   stat: "Ss", since: uptime(), cpu: 0, vsz: 20480, rss: 4096,
                   unit: u.unit, wchan: "do_wait", cwd: "/", exe: path || "/usr/sbin/" + name,
                   env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                         "LANG=C.UTF-8"] });
  }

  function detachUnit(u) {
    if (!u) return;
    table.slice().forEach(function (e) {
      if (e.unit === u.unit) { removeUnitProcess(e); exitProcess(e.pid, 0); }
    });
    reap();
  }

  // ---- the login session --------------------------------------------------
  //
  // The shell registers itself here when it is constructed: on a real machine
  // that is the moment login(1) execs bash on the terminal, and `ps` on that
  // terminal starts showing it.
  function bindShell(sh) {
    ensure();
    var tty = sh.tty || (LW.VTs ? "tty" + LW.VTs.activeVt() : "tty1");
    sh.tty = tty;
    var me = table.filter(function (e) { return e.tty === tty && e.comm === "bash" && !e.zombie; })[0];
    if (!me) {
      me = spawn({ ppid: gettyPid(tty), user: sh.env && sh.env.USER || "linuxweb",
                   uid: 1000, tty: tty, comm: "bash", args: "-bash", stat: "Ss",
                   fg: !inCommand, cpu: 0.0, vsz: 20372, rss: 8832, since: uptime(),
                   wchan: "wait_woken", cwd: sh.cwd || "/home/linuxweb", exe: "/bin/bash",
                   env: shellEnv(sh) });
      // the getty on this terminal is no longer the foreground job
      var g = get(gettyPid(tty));
      if (g) g.fg = false;
    }
    me.shell = sh;
    sh.pid = me.pid;
    shellPid = me.pid;
    return me;
  }

  function shellEnv(sh) {
    if (!sh || !sh.env) return ["PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8"];
    return Object.keys(sh.env).sort().map(function (k) { return k + "=" + sh.env[k]; });
  }

  // Keep the shell's entry in step with the shell itself: its cwd, its
  // environment and whether it is the foreground job right now.
  function syncShell(sh) {
    if (!sh || !sh.pid) return;
    var e = get(sh.pid);
    if (!e) return;
    e.cwd = sh.cwd;
    e.env = shellEnv(sh);
    e.fg = !inCommand && !e.zombie;
  }

  // The shell is about to run a command: it gives up the terminal, and the
  // command takes it, which is the difference between `Ss` and `Ss+`.
  function beginCommand(sh) {
    ensure();
    syncShell(sh);
    inCommand = true;
    var e = sh && sh.pid ? get(sh.pid) : null;
    if (e) e.fg = false;
  }

  function endCommand(sh) {
    inCommand = false;
    var e = sh && sh.pid ? get(sh.pid) : null;
    if (e && !e.zombie) e.fg = true;
  }

  // ---- /proc --------------------------------------------------------------
  //
  // The directory is the default one from vfs.js with the numeric entries
  // added and dead ones dropped on every read, so `ls /proc` is a snapshot of
  // the table and never keeps a pid that has gone.
  function mountProc() {
    var p = V.getNode && V.getNode("/proc");
    if (!p || p.t !== "d") return;
    if (p.__procSync === syncProc) return;
    var kids = p.c;
    Object.defineProperty(p, "c", {
      configurable: true,
      get: function () { syncProc(kids); return kids; },
    });
    p.__procSync = syncProc;
  }

  function syncProc(kids) {
    var want = {};
    table.forEach(function (e) { want[String(e.pid)] = e; });
    Object.keys(kids).forEach(function (k) {
      if (!/^\d+$/.test(k)) return;
      var e = want[k];
      if (!e || kids[k].__entry !== e) delete kids[k];
    });
    Object.keys(want).forEach(function (k) {
      if (!kids[k]) kids[k] = pidDir(want[k]);
    });
    kids.self = { t: "l", dyn: true, ro: true, to: String(shellPid || 1), __self: true };
    kids["thread-self"] = kids.self;
  }

  // One file node per readable file: each closes over the entry but reads its
  // fields when read, so stat/status follow a signal without a rebuild.
  function f(get) { return { t: "f", dyn: true, ro: true, get: get }; }

  function pidDir(e) {
    var c = {
      stat: f(function () { return statLine(e); }),
      status: f(function () { return statusText(e); }),
      cmdline: f(function () {
        if (e.kernel) return "";
        return e.args.replace(/ /g, "\0") + (e.args ? "\0" : "");
      }),
      comm: f(function () { return e.comm + "\n"; }),
      wchan: f(function () { return (e.zombie ? "0" : e.wchan) + "\n"; }),
      statm: f(function () {
        var pages = Math.floor(e.rss / 4);
        return [Math.floor(e.vsz / 4), pages, 0, 0, 0, pages, 0, 0].join(" ") + "\n";
      }),
      environ: f(function () {
        var env = e.env || [];
        return env.length ? env.join("\0") + "\0" : "";
      }),
      cgroup: f(function () { return cgroupText(e) + "\n"; }),
      cwd: { t: "l", dyn: true, ro: true, to: e.cwd || "/" },
      exe: { t: "l", dyn: true, ro: true, to: e.exe || "/usr/bin/" + e.comm },
      root: { t: "l", dyn: true, ro: true, to: "/" },
      attr: { t: "d", dyn: true, ro: true,
              c: { current: f(function () { return scontext(e) + "\n"; }) } },
      fd: { t: "d", dyn: true, ro: true, c: fdChildren(e) },
    };
    return { t: "d", dyn: true, ro: true, c: c, __entry: e };
  }

  function fdChildren(e) {
    var target = e.tty === "?" ? (e.kernel ? "" : "/dev/null") : "/dev/" + e.tty;
    var out = {
      "0": { t: "l", to: target || "/dev/null" },
      "1": { t: "l", to: target || "/dev/null" },
      "2": { t: "l", to: target || "/dev/null" },
    };
    if (e.unit === "systemd-journald.service") {
      out["3"] = { t: "l", to: "/run/systemd/journal/stdout" };
      out["4"] = { t: "l", to: "/run/systemd/journal/socket" };
    }
    if (e.unit === "ssh.service") out["3"] = { t: "l", to: "/run/sshd.pid" };
    return out;
  }

  // How many files are open -- the count of the directory above, so `ps -o
  // fds` and `ls /proc/pid/fd | wc -l` say the same thing.
  function fdCount(e) { return Object.keys(fdChildren(e)).length; }

  // /proc/pid/cgroup, without the newline: which control groups the process
  // is in.  `ps -o cgroup` prints exactly this string, so the two cannot
  // drift apart.
  function cgroupText(e) {
    if (e.unit) return "0::/system.slice/" + e.unit;
    if (e.kernel) return "0::/";
    return e.user === "linuxweb"
      ? "0::/user.slice/user-1000.slice/session-1.scope"
      : "0::/system.slice";
  }

  // /proc/pid/attr/current: the process's security context.  Nothing on
  // this machine is confined, which is what libapparmor reports for every
  // task and the one string both `ps -Z` and `pstree -Z` print -- the two
  // read the same string here, so they cannot say different things.
  function scontext(e) { return "unconfined"; }

  // /proc/pid/stat: the space-separated one, 52 fields, comm in brackets
  // because comm is the only field that can contain a space or a paren.
  function statLine(e) {
    var ticks = 100;                     // USER_HZ
    var utime = Math.floor(e.cpu * ticks * 0.7);
    var stime = Math.floor(e.cpu * ticks) - utime;
    var flt = faults(e);
    var fields = [
      e.pid,
      "(" + e.comm + ")",
      e.zombie ? "Z" : e.stat.charAt(0),
      e.ppid,
      pgid(e),                           // process group
      sid(e),                            // session
      ttyNr(e),                          // terminal
      tpgid(e),                          // foreground process group
      e.kernel ? 0x400000 : 0x400100,    // flags
      flt[0], 0, flt[1], 0,              // faults
      utime, stime, 0, 0,                // cpu ticks
      20, 0,                             // priority, nice
      1, 0,                              // threads, itrealvalue
      Math.floor(e.since * ticks),       // starttime
      e.vsz * 1024,                      // vsize (bytes)
      Math.floor(e.rss / 4),             // rss (pages)
      0x7ffffffff000,                    // rsslim
      0x400000, 0x500000, 0x7ffd00000000, 0, 0,
      0, 0, 0, 0,                        // signal/blocked/ignored/caught
      0, 0, 0,                           // wchan, nswap, cnswap
      17, 0, 0, 0, 0, 0,                 // exit_signal, processor, rt, policy, ...
      0, 0, 0, 0,
      0x400000, 0x500000, 0x600000, 0x7ffd00000000, 0x7ffd00000000,
      0x7ffefd000000, 0,
    ];
    return fields.join(" ") + "\n";
  }

  // /proc/pid/status: the human-readable one, with the fields ps -o and
  // tools like top read when they want more than stat gives.
  function statusText(e) {
    var stateName = { S: "sleeping", R: "running", T: "stopped", Z: "zombie",
                      I: "idle", D: "disk sleep", t: "tracing stop" }[e.stat.charAt(0)] || "sleeping";
    var ppid = e.ppid;
    return [
      "Name:\t" + e.comm,
      "Umask:\t0002",
      "State:\t" + (e.zombie ? "Z (zombie)" : e.stat.charAt(0) + " (" + stateName + ")"),
      "Tgid:\t" + e.pid,
      "Ngid:\t0",
      "Pid:\t" + e.pid,
      "PPid:\t" + ppid,
      "TracerPid:\t0",
      "Uid:\t" + e.uid + "\t" + e.uid + "\t" + e.uid + "\t" + e.uid,
      "Gid:\t" + (e.uid ? 1000 : 0) + "\t" + (e.uid ? 1000 : 0) + "\t" + (e.uid ? 1000 : 0) + "\t" + (e.uid ? 1000 : 0),
      "FDSize:\t256",
      "Groups:\t" + groupList(e),
      "NStgid:\t" + e.pid,
      "NSpid:\t" + e.pid,
      "NSpgid:\t" + pgid(e),
      "NSsid:\t" + sid(e),
      "Kthread:\t" + (e.kernel ? 1 : 0),
      "VmSize:\t" + String(e.vsz).padStart(7) + " kB",
      "VmRSS:\t" + String(e.rss).padStart(7) + " kB",
      "VmSwap:\t      0 kB",
      "Threads:\t1",
      "SigQ:\t0/128174",
      "SigPnd:\t" + SIGMASKS.pnd,
      "SigBlk:\t" + SIGMASKS.blk,
      "SigIgn:\t" + SIGMASKS.ign,
      "SigCgt:\t" + SIGMASKS.cgt,
      "CapInh:\t0000000000000000",
      "CapPrm:\t" + caps(e).prm,
      "CapEff:\t" + caps(e).eff,
      "CapBnd:\t" + caps(e).bnd,
      "NoNewPrivs:\t0",
      "Seccomp:\t0",
      "Cpus_allowed:\t3",
      "Cpus_allowed_list:\t0-1",
      "Mems_allowed:\t00000000,00000001",
      "voluntary_ctxt_switches:\t" + (128 + e.pid % 97),
      "nonvoluntary_ctxt_switches:\t" + (e.pid % 31),
      "",
    ].join("\n");
  }

  // ---- wiring -------------------------------------------------------------

  // Seed once, whenever somebody first needs it: a command, the shell binding
  // itself to its terminal, or the VFS finishing its load.
  //
  // NB: this deliberately does not call systemd.init() -- seeding the journal
  // needs the boot log, which may not have been handed over yet (main.js does
  // that at the end of the boot).  The unit table is read as it stands: the
  // units that say they are running with a pid we have not already planted
  // get a process of their own.
  function ensure() {
    if (seeded) { mountProc(); return; }
    seeded = true;
    seed();
    if (LW.systemd && LW.systemd.units) {
      LW.systemd.units.forEach(function (u) {
        if (u.active === "active" && u.pid && !get(u.pid)) attachUnit(u);
      });
    }
    mountProc();
  }

  if (V && V.onLoad) V.onLoad.push(ensure);

  LW.proc = {
    // table
    ensure: ensure, list: list, get: get, spawn: spawn, childrenOf: childrenOf,
    uptime: uptime,
    reap: reap, exit: exitProcess, kill: kill, killByName: killByName,
    shellPid: function () { return shellPid; },
    setShellPid: function (p) { shellPid = p; },
    inCommand: function () { return inCommand; },
    beginCommand: beginCommand, endCommand: endCommand,
    // session
    bindShell: bindShell, syncShell: syncShell,
    gettyPid: gettyPid,
    // units
    attachUnit: attachUnit, detachUnit: detachUnit,
    // columns
    stat: stat, elapsed: elapsed, cpuTime: cpuTime, pcpu: pcpu, pmem: pmem,
    startTime: startTime, started: started,
    // identity (shared with ps so /proc and ps cannot disagree)
    isLeader: isLeader, pgid: pgid, sid: sid, tpgid: tpgid, ttyNr: ttyNr,
    gid: gid, groupName: groupName, groupList: groupList,
    faults: faults, caps: caps, fdCount: fdCount, cgroupText: cgroupText,
    scontext: scontext,
    SIGMASKS: SIGMASKS,
    // signals
    SIGNALS: SIGNALS, signalNumber: signalNumber, signalName: signalName,
    // /proc
    mountProc: mountProc,
  };
})(window.LW);
