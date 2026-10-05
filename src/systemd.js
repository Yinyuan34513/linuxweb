// systemd's world: the unit table, their states, and the journal.
//
// `systemctl` and `journalctl` are thin front ends over this -- they format
// what lives here, so the two always agree with each other and with the boot
// log the console printed.
//
// The journal starts as the boot: every line the kernel log gained during this
// boot becomes an entry, with the monotonic timestamp the console printed
// turned into both a monotonic and a wall-clock time.  Unit events for the
// services that would already be running when the login prompt appears are
// woven in at the points in the boot where systemd would have started them.
// Messages added later -- a service being restarted, a login, a command -- are
// appended as they happen.
(function (LW) {
  "use strict";

  var V = LW.VFS;

  // ---- the units ----------------------------------------------------------
  //
  // The ones a Debian install with a desktop has actually running by the time
  // you get a login prompt.  `enabled` is what `systemctl is-enabled` reports,
  // and the wants-directory under /etc/systemd/system records the same thing on
  // disk so `ls -l /etc/systemd/system/multi-user.target.wants` agrees.
  var UNITS = [
    { unit: "proc-sys-fs-binfmt_misc.automount", desc: "Arbitrary Executable File Formats File System Automount Point",
      load: "loaded", active: "active", sub: "active", enabled: "static", file: "/lib/systemd/system/proc-sys-fs-binfmt_misc.automount", kind: "mount" },
    { unit: "dev-hugepages.mount", desc: "Huge Pages Shared Memory System", load: "loaded",
      active: "active", sub: "active", enabled: "static", file: "/lib/systemd/system/dev-hugepages.mount", kind: "mount" },
    { unit: "dev-mqueue.mount", desc: "POSIX Message Queue File System", load: "loaded",
      active: "active", sub: "active", enabled: "static", file: "/lib/systemd/system/dev-mqueue.mount", kind: "mount" },
    { unit: "dev-shm.mount", desc: "POSIX Shared Memory", load: "loaded",
      active: "active", sub: "active", enabled: "static", file: "/lib/systemd/system/dev-shm.mount", kind: "mount" },
    { unit: "home.mount", desc: "/home", load: "loaded", active: "active", sub: "active",
      enabled: "static", file: "/lib/systemd/system/home.mount", kind: "mount" },
    { unit: "systemd-journald.service", desc: "Journal Service", load: "loaded",
      active: "active", sub: "running", enabled: "static", pid: 418, since: "boot",
      kind: "service", file: "/lib/systemd/system/systemd-journald.service" },
    { unit: "systemd-logind.service", desc: "Login Service", load: "loaded",
      active: "active", sub: "running", enabled: "static", pid: 512, kind: "service",
      file: "/lib/systemd/system/systemd-logind.service" },
    { unit: "systemd-udevd.service", desc: "System User and Device Daemon", load: "loaded",
      active: "active", sub: "running", enabled: "static", pid: 387, kind: "service",
      file: "/lib/systemd/system/systemd-udevd.service" },
    { unit: "user@1000.service", desc: "User Manager for UID 1000", load: "loaded",
      active: "active", sub: "running", enabled: "enabled", pid: 903, kind: "service",
      file: "/lib/systemd/system/user@.service" },
    { unit: "ssh.service", desc: "OpenBSD Secure Shell server", load: "loaded",
      active: "active", sub: "running", enabled: "enabled", pid: 706, kind: "service",
      file: "/lib/systemd/system/ssh.service" },
    { unit: "sshd.service", desc: "OpenBSD Secure Shell server", load: "alias",
      active: "active", sub: "running", enabled: "alias", kind: "alias",
      file: "/lib/systemd/system/ssh.service" },
    { unit: "cron.service", desc: "Regular background program processing daemon",
      load: "loaded", active: "active", sub: "running", enabled: "enabled", pid: 654,
      kind: "service", file: "/lib/systemd/system/cron.service" },
    { unit: "rsyslog.service", desc: "System Logging Service", load: "loaded",
      active: "active", sub: "running", enabled: "enabled", pid: 671, kind: "service",
      file: "/lib/systemd/system/rsyslog.service" },
    { unit: "getty.target", desc: "Login Prompts", load: "loaded", active: "active",
      sub: "active", enabled: "enabled", kind: "target",
      file: "/lib/systemd/system/getty.target" },
    { unit: "multi-user.target", desc: "Multi-User System", load: "loaded", active: "active",
      sub: "active", enabled: "enabled", kind: "target",
      file: "/lib/systemd/system/multi-user.target" },
    { unit: "graphical.target", desc: "Graphical Interface", load: "loaded",
      active: "inactive", sub: "dead", enabled: "enabled", kind: "target",
      file: "/lib/systemd/system/graphical.target" },
    { unit: "NetworkManager.service", desc: "Network Manager", load: "loaded",
      active: "inactive", sub: "dead", enabled: "enabled", kind: "service",
      file: "/lib/systemd/system/NetworkManager.service" },
    { unit: "NetworkManager-wait-online.service", desc: "Network Manager Wait Online",
      load: "loaded", active: "inactive", sub: "dead", enabled: "enabled", kind: "service",
      file: "/lib/systemd/system/NetworkManager-wait-online.service" },
    { unit: "apt-daily.service", desc: "Daily apt download activities", load: "loaded",
      active: "inactive", sub: "dead", enabled: "enabled", kind: "service",
      file: "/lib/systemd/system/apt-daily.service" },
    { unit: "apt-daily-upgrade.service", desc: "Daily apt upgrade and clean activities",
      load: "loaded", active: "inactive", sub: "dead", enabled: "enabled", kind: "service",
      file: "/lib/systemd/system/apt-daily-upgrade.service" },
    { unit: "e2scrub_all.service", desc: "Periodic disk scrubbing", load: "loaded",
      active: "inactive", sub: "dead", enabled: "enabled", kind: "service",
      file: "/lib/systemd/system/e2scrub_all.service" },
    { unit: "man-db.service", desc: "Rebuild Man Database", load: "loaded",
      active: "inactive", sub: "dead", enabled: "enabled", kind: "service",
      file: "/lib/systemd/system/man-db.service" },
    { unit: "nginx.service", desc: "A high performance web server and a reverse proxy server",
      load: "loaded", active: "inactive", sub: "dead", enabled: "disabled", kind: "service",
      file: "/lib/systemd/system/nginx.service" },
    { unit: "apache2.service", desc: "The Apache HTTP Server", load: "loaded",
      active: "failed", sub: "failed", enabled: "enabled", kind: "service", result: "exit-code",
      status: 1, file: "/lib/systemd/system/apache2.service" },
    { unit: "docker.service", desc: "Docker Application Container Engine", load: "loaded",
      active: "inactive", sub: "dead", enabled: "disabled", kind: "service",
      file: "/lib/systemd/system/docker.service" },
    { unit: "networking.service", desc: "Raise up network interfaces", load: "loaded",
      active: "active", sub: "exited", enabled: "enabled", kind: "service",
      file: "/lib/systemd/system/networking.service" },
    { unit: "getty@tty1.service", desc: "Login Service", load: "loaded",
      active: "active", sub: "running", enabled: "enabled", kind: "service",
      file: "/lib/systemd/system/getty@.service" },
    { unit: "systemd-timesyncd.service", desc: "System Time Daemon", load: "loaded",
      active: "active", sub: "running", enabled: "static", pid: 588, kind: "service",
      file: "/lib/systemd/system/systemd-timesyncd.service" },
  ];

  var byName = {};
  UNITS.forEach(function (u) { byName[u.unit] = u; });

  // ---- the journal --------------------------------------------------------
  //
  // Each entry is { mono, real, unit, ident, pid, priority, message }.  `mono`
  // is seconds since boot, which is what the console stamped the kernel lines
  // with; `real` is the wall-clock time, which is what -T prints.
  var journal = [];
  var seq = 0;

  function now() { return LW.now ? LW.now() : new Date(); }
  function uptime() { return LW.uptime ? LW.uptime() : 0; }

  function add(o) {
    var e = {
      mono: o.mono === undefined ? uptime() : o.mono,
      real: o.real ? o.real : new Date(now().getTime() - (uptime() - (o.mono === undefined ? uptime() : o.mono)) * 1000),
      unit: o.unit || null,
      ident: o.ident || (o.unit ? o.unit.split(".")[0] : "kernel"),
      pid: o.pid === undefined ? 0 : o.pid,
      priority: o.priority === undefined ? 6 : o.priority,
      message: String(o.message),
      boot: 0,
    };
    e.real = o.real || new Date(bootEpoch + e.mono * 1000);
    journal.push(e);
    seq++;
    return e;
  }

  var bootEpoch = (function () {
    var b = LW.bootTime ? LW.bootTime() : new Date();
    return b.getTime();
  })();

  // Seed from the boot log: every line the console printed with a timestamp
  // becomes an entry, so `journalctl -k` and `dmesg` see the same thing.
  function seedFromBoot(stamped) {
    if (!stamped) return;
    String(stamped).split("\n").forEach(function (line) {
      if (!line) return;
      var m = /^\[\s*(\d+)\.(\d+)\]\s?(.*)$/.exec(line.replace(/\x1b\[[0-9;]*m/g, ""));
      if (m) add({ mono: parseFloat(m[1] + "." + m[2]), message: m[3], unit: null, ident: "kernel" });
      else add({ message: line.replace(/\x1b\[[0-9;]*m/g, ""), unit: null, ident: "kernel" });
    });
  }

  // The unit events systemd would have written around the boot, spliced in at
  // the monotonic times the boot log reaches, so -b reads chronologically.
  var BOOT_EVENTS = [
    { at: 0.02, unit: "systemd-journald.service", message: "Started Journal Service." },
    { at: 0.03, unit: "systemd-journald.service", message: "Journal Socket Listening on /run/systemd/journal/socket." },
    { at: 0.31, unit: "systemd-udevd.service", message: "Started System User and Device Daemon." },
    { at: 0.44, unit: "dev-shm.mount", message: "Mounted tmpfs (tmpfs) on /dev/shm." },
    { at: 0.62, unit: "home.mount", message: "Mounted /home (ext4) on /home." },
    { at: 0.95, unit: "systemd-logind.service", message: "Started Login Service." },
    { at: 1.21, unit: "networking.service", message: "Raised interface lo." },
    { at: 1.22, unit: "networking.service", message: "Raised interface eth0." },
    { at: 1.4, unit: "systemd-timesyncd.service", message: "Started System Time Daemon." },
    { at: 1.61, unit: "cron.service", message: "Started Regular background program processing daemon." },
    { at: 1.64, unit: "cron.service", message: "pam_unix(cron:session): session opened for user root by (uid=0)" },
    { at: 1.82, unit: "rsyslog.service", message: "Started System Logging Service." },
    { at: 2.05, unit: "rsyslog.service", message: "rsyslogd's groupid changed to 110" },
    { at: 2.4, unit: "ssh.service", message: "Started OpenBSD Secure Shell server." },
    { at: 2.41, unit: "ssh.service", message: "sshd[706]: Server listening on 0.0.0.0 port 22." },
    { at: 2.42, unit: "ssh.service", message: "sshd[706]: Server listening on :: port 22." },
    { at: 2.9, unit: "getty@tty1.service", message: "Started Login Service." },
    { at: 2.95, unit: "multi-user.target", message: "Reached target Multi-User System." },
    { at: 2.96, unit: "multi-user.target", message: "Startup finished in 1.4s (kernel) + 900ms (userspace) = 2.4s." },
  ];

  // Merge the boot events into the kernel log by monotonic time.  The moment a
  // unit started is remembered too, because `systemctl status` reports it as
  // "Active: ... since <that time>".
  function seedUnitEvents() {
    BOOT_EVENTS.forEach(function (ev) {
      var u = byName[ev.unit];
      add({
        mono: ev.at, unit: ev.unit, ident: u ? u.unit.split(".")[0] : ev.unit,
        pid: u && u.pid ? u.pid : 0, message: ev.message,
      });
      if (u && !u.startedAt && /^(Started|Reached|Started Login)/.test(ev.message)) {
        u.startedAt = new Date(bootEpoch + ev.at * 1000);
      }
    });
    journal.sort(function (a, b) { return a.mono - b.mono; });
  }

  // The unit files themselves, so `systemctl cat ssh` and
  // `cat /lib/systemd/system/ssh.service` show the same text and the paths in
  // `systemctl status` point at something that exists.
  var EXEC_FOR = { ssh: "/usr/sbin/sshd", cron: "/usr/sbin/cron", rsyslog: "/usr/sbin/rsyslogd",
                   nginx: "/usr/sbin/nginx", apache2: "/usr/sbin/apache2", docker: "/usr/bin/dockerd",
                   "systemd-journald": "/lib/systemd/systemd-journald",
                   "systemd-logind": "/lib/systemd/systemd-logind",
                   "systemd-udevd": "/lib/systemd/systemd-udevd",
                   "systemd-timesyncd": "/lib/systemd/systemd-timesyncd",
                   "user@": "/lib/systemd/systemd --user" };

  function execPath(u) {
    var base = u.unit.split(".")[0];
    var key = Object.keys(EXEC_FOR).find(function (k) { return base.indexOf(k) === 0; });
    return key ? EXEC_FOR[key] : "/lib/systemd/" + base;
  }

  function unitFileText(u) {
    var kind = u.kind === "mount" ? "Mount" : u.kind === "target" ? "Target" : "Service";
    var lines = [
      "[Unit]",
      "Description=" + u.desc,
    ];
    if (kind === "Service") {
      lines.push("Documentation=man:systemd.service(5)");
      if (u.unit.indexOf("network") >= 0 || u.unit.indexOf("NetworkManager") >= 0) {
        lines.push("Wants=network-online.target");
        lines.push("After=network-online.target");
      } else {
        lines.push("After=network.target");
      }
      lines.push("");
      lines.push("[Service]");
      lines.push("Type=simple");
      lines.push("ExecStart=" + execPath(u));
      lines.push("Restart=on-failure");
      lines.push("RestartSec=100ms");
      lines.push("StandardOutput=journal");
      lines.push("StandardError=journal");
      lines.push("");
      lines.push("[Install]");
      lines.push("WantedBy=multi-user.target");
    } else if (kind === "Target") {
      lines.push("");
      lines.push("[Install]");
      lines.push("WantedBy=multi-user.target");
    } else {
      lines.push("Before=local-fs.target");
      lines.push("");
      lines.push("[Mount]");
      lines.push("What=" + (u.unit === "dev-shm.mount" ? "tmpfs" : "/" + u.unit));
      lines.push("Where=" + (u.unit === "dev-shm.mount" ? "/dev/shm" : "/" + u.unit));
      lines.push("Type=" + (u.unit === "dev-shm.mount" ? "tmpfs" : "ext4"));
      lines.push("");
      lines.push("[Install]");
      lines.push("WantedBy=local-fs.target");
    }
    return lines.join("\n") + "\n";
  }

  function writeUnitFiles() {
    UNITS.forEach(function (u) {
      if (!u.file) return;
      try {
        V.mkdirp(V.parentOf(u.file));
        V.writeFile(u.file, unitFileText(u), false);
      } catch (e) { /* a read-only filesystem just means no `systemctl cat` */ }
    });
  }

  var initialised = false;
  function init() {
    if (initialised) return;
    initialised = true;
    writeUnitFiles();
    var stamped = LW.stampedLog;
    if (!stamped) {
      var raw = V.readFile("/var/log/dmesg");
      if (raw) stamped = raw;
    }
    seedFromBoot(stamped);
    seedUnitEvents();
  }

  // ---- unit state ---------------------------------------------------------
  //
  // A start or stop is a real state change: the unit's active state moves, a
  // journal entry is written, and the wants-directory on disk is updated so
  // `ls /etc/systemd/system/multi-user.target.wants` follows along.
  var WANTS = "/etc/systemd/system/multi-user.target.wants";

  function wantsPath(unit) {
    var name = unit.indexOf("@") >= 0 ? unit.replace(/@[^.]*/, "@.service") : unit;
    return WANTS + "/" + name;
  }

  // Where the unit's wants-link would live.  This filesystem has no symlinks,
  // so nothing is written there: the unit table below is the single source of
  // truth for enablement, and `systemctl list-unit-files` reads it from there.
  function syncWants() { return WANTS; }

  function setEnabled(u, on) {
    if (u.enabled === "static" || u.enabled === "alias") {
      return { ok: false, msg: "The unit files have no installation config " +
        "(" + (u.enabled === "static" ? "static" : "alias") + ")." };
    }
    u.enabled = on ? "enabled" : "disabled";
    // systemd prints the symlink it made; the file is not written because the
    // filesystem cannot hold one, but the message is what a user reads
    add({ unit: u.unit, ident: u.unit.split(".")[0], message: on ?
      "Created symlink /etc/systemd/system/multi-user.target.wants/" + u.unit +
        " → /lib/systemd/system/" + u.unit + "." :
      "Removed /etc/systemd/system/multi-user.target.wants/" + u.unit + "." });
    return { ok: true };
  }

  function setActive(u, on, via) {
    if (u.kind === "mount" && u.unit === "dev-shm.mount" && on) {
      // /dev/shm is brought up by the kernel before systemd starts
      return { ok: true };
    }
    if (via) add({ unit: u.unit, ident: u.unit.split(".")[0], message: "Stopping " + u.desc + "..." });
    u.active = on ? "active" : "inactive";
    u.sub = u.kind === "target" ? (on ? "active" : "dead")
      : u.kind === "mount" ? (on ? "active" : "dead") : (on ? "running" : "dead");
    if (on) {
      u.pid = 700 + (u.unit.length * 7 % 900);
      u.result = "success";
      u.startedAt = now();
    } else {
      delete u.pid;
    }
    add({ unit: u.unit, ident: u.unit.split(".")[0], pid: u.pid || 0,
      message: on ? "Started " + u.desc + "." : "Stopped " + u.desc + "." });
    return { ok: true };
  }

  // ---- the interface ------------------------------------------------------

  LW.systemd = {
    units: UNITS,
    unitFileText: unitFileText,
    execPath: execPath,
    byName: function (name) { return byName[name]; },
    init: init,
    journal: journal,
    add: add,
    now: now,
    uptime: uptime,
    setActive: setActive,
    setEnabled: setEnabled,
    wantsPath: wantsPath,
    syncWants: syncWants,

    // The unit names systemctl's arguments match, in the order it lists them.
    listUnits: function (state) {
      return UNITS.filter(function (u) {
        if (state && u.load === "alias") return false;
        return true;
      }).map(function (u) {
        return {
          unit: u.unit, load: u.load, active: u.active, sub: u.sub,
          enabled: u.enabled, desc: u.desc, file: u.file || "", kind: u.kind || "service",
        };
      });
    },

    // The "●" marker systemd colours by state: green running, red failed,
    // white everything else.
    dot: function (u) {
      if (u.active === "active" && (u.sub === "running" || u.sub === "exited")) {
        return u.enabled === "disabled" ? "○" : "●";
      }
      if (u.active === "failed") return "×";
      if (u.active === "inactive") return "○";
      return "○";
    },
  };
})(window.LW);