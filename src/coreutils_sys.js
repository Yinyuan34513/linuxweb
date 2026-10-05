// GNU coreutils -- system and identity commands, plus the three that report on
// the running system: dmesg, systemctl and journalctl.
//
// arch, uname, whoami, id, groups, date, env, printenv, tty, logname, users,
// who, hostid, nproc, nice, nohup, timeout, sleep, yes, sync, stty, stdbuf,
// runcon, chroot, dircolors, pinky, pathchk, expr, factor, uptime,
// hostnamectl, loginctl.
//
// dmesg, systemctl and journalctl are front ends over src/systemd.js, so the
// unit states, the journal and the kernel log always tell the same story.
//
// Requires: vfs.js, bash.js (LW.core), systemd.js.
(function (LW) {
  "use strict";

  var V = LW.VFS;
  var def = LW.core.defCmd;
  var getopt = LW.core.getopt, finish = LW.core.finish;
  var eachInput = LW.core.eachInput, gnuErr = LW.core.gnuErr;
  var usage = LW.core.usage, doc = LW.core.doc;

  // ---- time ---------------------------------------------------------------
  //
  // One clock for the whole console: LW.now() is what the prompt, the boot log
  // and the login line read, so a date printed here cannot disagree with them.
  function now() { return LW.now ? LW.now() : new Date(); }
  function uptime() { return LW.uptime ? LW.uptime() : 0; }
  var MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  function two(n) { return (n < 10 ? "0" : "") + n; }
  function utc(d, key) { return d["getUTC" + key](); }

  // strftime(3), the subset the options of date(1) actually reach.
  function strftime(fmt, d, up) {
    var out = "", i = 0;
    while (i < fmt.length) {
      var ch = fmt.charAt(i);
      if (ch !== "%") { out += ch; i++; continue; }
      var code = fmt.charAt(i + 1);
      i += 2;
      switch (code) {
        case "Y": out += utc(d, "FullYear"); break;
        case "y": out += two(utc(d, "FullYear") % 100); break;
        case "m": out += two(utc(d, "Month") + 1); break;
        case "d": out += two(utc(d, "Date")); break;
        case "e": out += " " + utc(d, "Date"); break;
        case "H": out += two(utc(d, "Hours")); break;
        case "M": out += two(utc(d, "Minutes")); break;
        case "S": out += two(utc(d, "Seconds")); break;
        case "a": out += DAYS[utc(d, "Day")].slice(0, 3); break;
        case "A": out += DAYS[utc(d, "Day")]; break;
        case "b": case "h": out += MONTHS[utc(d, "Month")].slice(0, 3); break;
        case "B": out += MONTHS[utc(d, "Month")]; break;
        case "p": out += utc(d, "Hours") < 12 ? "AM" : "PM"; break;
        case "I": { var h = utc(d, "Hours") % 12; out += two(h === 0 ? 12 : h); break; }
        case "Z": out += LW.TZ || "UTC"; break;
        case "z": out += "+0000"; break;
        case "j": out += pad3(dayOfYear(d)); break;
        case "s": out += String(Math.floor(d.getTime() / 1000)); break;
        case "N": out += String(d.getMilliseconds() * 1000000); break;
        case "u": { var w = utc(d, "Day"); out += w === 0 ? "7" : String(w); break; }
        case "w": out += String(utc(d, "Day")); break;
        case "T": out += two(utc(d, "Hours")) + ":" + two(utc(d, "Minutes")) + ":" + two(utc(d, "Seconds")); break;
        case "R": out += two(utc(d, "Hours")) + ":" + two(utc(d, "Minutes")); break;
        case "D": out += two(utc(d, "Month") + 1) + "/" + two(utc(d, "Date")) + "/" + two(utc(d, "FullYear") % 100); break;
        case "F": out += utc(d, "FullYear") + "-" + two(utc(d, "Month") + 1) + "-" + two(utc(d, "Date")); break;
        case "c": out += DAYS[utc(d, "Day")].slice(0, 3) + " " + MONTHS[utc(d, "Month")].slice(0, 3) +
          " " + two(utc(d, "Date")) + " " + two(utc(d, "Hours")) + ":" + two(utc(d, "Minutes")) +
          ":" + two(utc(d, "Seconds")) + " " + utc(d, "FullYear"); break;
        case "U": out += two(weekOfYear(d, 0)); break;
        case "W": out += two(weekOfYear(d, 1)); break;
        case "%": out += "%"; break;
        case "n": out += "\n"; break;
        case "t": out += "\t"; break;
        case "v": out += up ? uptimeText(up) : ""; break;
        default: out += "%" + code;
      }
    }
    return out;
  }
  function pad3(n) { return (n < 100 ? (n < 10 ? "00" : "0") : "") + n; }
  function dayOfYear(d) {
    var start = Date.UTC(utc(d, "FullYear"), 0, 1);
    return Math.floor((d.getTime() - start) / 86400000) + 1;
  }
  function weekOfYear(d, mode) {
    var jan1 = new Date(Date.UTC(utc(d, "FullYear"), 0, 1));
    var day = (jan1.getUTCDay() - mode + 7) % 7;
    return Math.floor((dayOfYear(d) + day - 1) / 7);
  }
  // "up 3 days,  4:05", the way uptime words it
  function uptimeText(sec) {
    var s = Math.floor(sec);
    var parts = [];
    var d = Math.floor(s / 86400);
    if (d) parts.push(d + " day" + (d === 1 ? "" : "s"));
    var h = Math.floor(s % 86400 / 3600);
    var m = Math.floor(s % 3600 / 60);
    if (h || parts.length || d) {
      var hm = (d ? two(h) : String(h)) + ":" + two(m);
      parts.push(hm);
    } else parts.push(two(m) + " min");
    return "up " + parts.join(", ");
  }

  def("date", function (args, stdin, sh) {
    var g = getopt("date", args, {
      short: { d: "arg", f: "arg", r: "arg", u: "arg", R: "arg", s: "arg", "0": "bool" },
      long: { date: ["arg", "d"], format: ["arg", "f"], "set-date": ["arg", "s"],
              universal: ["bool", "u"], rfc: ["bool", "R"] },
    });
    var done = finish(sh, "date", g);
    if (done) return done;
    if (g.o.s !== undefined) {
      sh._error("date: setting the system clock is not permitted");
      return { out: "", code: 1 };
    }
    var d = now();
    if (g.o.R) return { out: strftime("%a, %d %b %Y %H:%M:%S %z", d) + "\n", code: 0 };
    // +FORMAT is the classic form: `date +%Y`
    var operands = g._;
    if (operands.length === 1 && /^[+-]/.test(operands[0])) {
      return { out: strftime(operands[0].slice(1), d, uptime()) + "\n", code: 0 };
    }
    return { out: strftime(g.o.f === undefined ? "%a %b %e %H:%M:%S %Z %Y" : g.o.f, d, uptime()) + "\n", code: 0 };
  }, "print date and time");

  def("uptime", function (args, stdin, sh) {
    var d = now(), up = uptime();
    var mins = Math.floor(up / 60);
    var load = [0.04, 0.01, 0.00];
    var text = " " + strftime("%H:%M:%S", d) + " up " +
      (mins >= 60 ? Math.floor(mins / 60) + ":" + two(mins % 60) : mins + " min") +
      ",  1 user,  load average: " + load.map(function (x) { return x.toFixed(2); }).join(", ");
    return { out: text + "\n", code: 0 };
  }, "show how long the system has been up");

  // ---- dmesg --------------------------------------------------------------
  //
  // The kernel ring buffer as the console stamped it: `[    2.960000] message`.
  // -H prints the wall-clock time and the offset since the previous line, -T
  // prints the full date, -t drops the stamp, and -l/-f filter by priority --
  // which pass everything here, because the boot log carries no priorities,
  // exactly as they do for messages the kernel logged without one.
  function kernelLog() {
    if (LW.stampedLog) return LW.stampedLog;
    var raw = V.readFile("/var/log/dmesg");
    return raw || "";
  }

  var LEVELS = ["emerg", "alert", "crit", "err", "warn", "notice", "info", "debug"];
  var PRIO_NUM = { emerg: 0, alert: 1, crit: 2, err: 3, warn: 4, notice: 5, info: 6, debug: 7 };
  var PRIO_NAME = ["emerg", "alert", "crit", "err", "warn", "notice", "info", "debug"];

  // dmesg brings its own options (util-linux, not coreutils), so they are read
  // here rather than through getopt().  Short options may be clustered, and
  // the ones that take a value take either the rest of the cluster or the next
  // argument.
  var DMESG_VALUE = { l: "level", f: "facility", F: "file", n: "consoleLevel",
                      s: "bufferSize", K: "kmsgFile", L: "color" };
  var DMESG_FLAGS = { H: "human", T: "time", t: "notime", r: "raw", c: "readClear",
                       C: "clear", w: "follow", W: "followNew", P: "nopager", k: "kernel",
                       u: "skipKernel", x: "decode", D: "consoleOff", E: "consoleOn",
                       p: "forcePrefix", S: "syslog", a: "all", J: "json" };
  var DMESG_LONG = { "human": "human", "ctime": "time", "time": "time", "notime": "notime",
                      "raw": "raw", "clear": "clear", "read-clear": "readClear",
                      "follow": "follow", "follow-new": "followNew", "noescape": "noescape",
                      "kernel": "kernel", "userspace": "skipKernel", "decode": "decode",
                      "console-off": "consoleOff", "console-on": "consoleOn",
                      "force-prefix": "forcePrefix", "syslog": "syslog", "json": "json",
                      "nopager": "nopager", "all": "all", "help": "help", "version": "version" };
  var DMESG_LONG_VALUE = { "level": "level", "facility": "facility", "file": "file",
                           "console-level": "consoleLevel", "buffer-size": "bufferSize",
                           "kmsg-file": "kmsgFile", "color": "color" };

  def("dmesg", function (args, stdin, sh) {
    var o = { human: false, time: false, notime: false, raw: false, clear: false,
              readClear: false, follow: false, followNew: false, noescape: false,
              level: null, facility: null, file: null, consoleLevel: null, json: false,
              help: false, version: false, err: null };
    var operands = [], i = 0;
    while (i < args.length) {
      var a = args[i++];
      if (a === "--") { operands = operands.concat(args.slice(i)); break; }
      if (a === "--help" || a === "--version") { o[a.slice(2)] = true; continue; }
      if (a.slice(0, 2) === "--") {
        var eq = a.indexOf("=");
        var name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        var value = eq >= 0 ? a.slice(eq + 1) : null;
        if (DMESG_LONG_VALUE[name]) {
          o[DMESG_LONG_VALUE[name]] = value !== null ? value : args[i++];
          continue;
        }
        if (DMESG_LONG[name]) { o[DMESG_LONG[name]] = true; continue; }
        o.err = "unrecognized option '--" + name + "'";
        continue;
      }
      if (a.length > 1 && a.charAt(0) === "-") {
        var letters = a.slice(1);
        for (var k = 0; k < letters.length; k++) {
          var c = letters.charAt(k);
          if (DMESG_VALUE[c]) {
            // the value is the rest of the cluster if there is any, else the
            // next argument, which is how `dmesg -T -l warn` reads
            o[DMESG_VALUE[c]] = letters.slice(k + 1) || args[i++];
            break;
          }
          if (DMESG_FLAGS[c]) { o[DMESG_FLAGS[c]] = true; continue; }
          o.err = "invalid option -- '" + c + "'";
          break;
        }
        continue;
      }
      operands.push(a);
    }
    if (o.help) return { out: dmesgHelp(), code: 0 };
    if (o.version) return { out: "dmesg from util-linux 2.41.1\n", code: 0 };
    if (o.err) return usage(sh, "dmesg", o.err);

    if (o.consoleOff || o.consoleOn) {
      var level = o.consoleLevel === null ? "6" : String(o.consoleLevel);
      try { V.writeFile("/proc/sys/kernel/console_loglevel", level + "\n", false); } catch (e) { /* ignore */ }
      return { out: "", code: 0 };
    }
    if (o.clear) {
      try { V.writeFile("/var/log/dmesg", "", false); } catch (e) { /* ignore */ }
      if (LW.stampedLog) LW.stampedLog = "";
      return { out: "", code: 0 };
    }

    var text = o.file ? (V.readFile(o.file) || "") : kernelLog();
    var rows = [];
    String(text).split("\n").forEach(function (line) {
      if (!line) return;
      var clean = line.replace(/\x1b\[[0-9;]*m/g, "");
      var m = /^\[\s*(\d+)\.(\d+)\]\s?(.*)$/.exec(clean);
      rows.push(m
        ? { mono: parseFloat(m[1] + "." + m[2]), text: m[3], kernel: true }
        : { mono: null, text: clean, kernel: false });
    });
    if (o.skipKernel) rows = rows.filter(function (r) { return !r.kernel; });
    // -l LEVEL and -f FACILITY select by priority, which this log does not
    // record: messages the kernel logged without one pass every filter, which
    // is what the real dmesg does with them too
    if (operands.length && /^\d+$/.test(operands[0])) {
      rows = rows.slice(-parseInt(operands[0], 10));
    }

    var boot = LW.bootTime ? LW.bootTime() : now();
    var out = "";
    rows.forEach(function (r, idx) { out += formatRow(r, idx, o, boot) + "\n"; });
    if (o.readClear) {
      try { V.writeFile("/var/log/dmesg", "", false); } catch (e) { /* ignore */ }
      if (LW.stampedLog) LW.stampedLog = "";
    }
    return { out: out, code: 0 };

    function formatRow(r, idx, opt, bootTime) {
      if (opt.raw || opt.notime) return r.text;
      if (opt.time) {
        var when = r.mono === null ? bootTime : new Date(bootTime.getTime() + r.mono * 1000);
        return "[" + strftime("%a %b %e %H:%M:%S %Y", when) + "] " + r.text;
      }
      if (opt.human) {
        var at = r.mono === null ? bootTime : new Date(bootTime.getTime() + r.mono * 1000);
        var stamp = "[" + MONTHS[utc(at, "Month")].slice(0, 3) + " " + String(utc(at, "Date")).padStart(2, " ") +
          " " + two(utc(at, "Hours")) + ":" + two(utc(at, "Minutes")) + "]";
        // every line after the first carries the offset from the one before
        if (idx === 0) return stamp + " " + r.text;
        var prev = rows[idx - 1];
        var delta = (r.mono === null ? 0 : r.mono) - (prev.mono === null ? 0 : prev.mono);
        return "[  +" + delta.toFixed(6).padStart(8) + "] " + r.text;
      }
      if (r.mono === null) return r.text;
      var s = Math.floor(r.mono), u = Math.round((r.mono - s) * 1e6);
      return "[" + String(s).padStart(5, " ") + "." + String(u).padStart(6, "0") + "] " + r.text;
    }
  }, "print or control the kernel ring buffer");


  function dmesgHelp() {
    return [
      "",
      "Usage:",
      " dmesg [options]",
      "",
      "Display or control the kernel ring buffer.",
      "",
      "Options:",
      " -C, --clear                 clear the kernel ring buffer",
      " -c, --read-clear            read and clear all messages",
      " -D, --console-off           disable printing messages to console",
      " -E, --console-on            enable printing messages to console",
      " -F, --file <file>           use the file instead of the kernel log buffer",
      " -H, --human                 human readable output",
      " -J, --json                  use JSON output format",
      " -k, --kernel                display kernel messages",
      " -l, --level <list>          restrict output to defined levels",
      " -n, --console-level <level> set level of messages printed to console",
      " -r, --raw                   print the raw message buffer",
      "     --noescape              don't escape unprintable character",
      " -s, --buffer-size <size>    buffer size to query the kernel ring buffer",
      " -T, --ctime                 show human readable timestamps",
      " -t, --notime                don't show timestamps",
      " -u, --userspace             display userspace messages",
      " -w, --follow                wait for new messages",
      " -x, --decode                try to decode textual portions",
      "     --help                  display this help and exit",
      "     --version               output version information and exit",
      "",
    ].join("\n");
  }

  // How long ago something happened, the way systemd words it: the two largest
  // units and "ago".  `45s ago`, `1min 30s ago`, `2h 3min ago`, `5d 4h ago`.
  function humanAgo(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    var units = [[86400, "d"], [3600, "h"], [60, "min"], [1, "s"]];
    var parts = [], shown = 0;
    for (var i = 0; i < units.length && shown < 2; i++) {
      var n = Math.floor(s / units[i][0]);
      s -= n * units[i][0];
      if (n || shown) { parts.push(n + units[i][1]); shown++; }
    }
    if (!parts.length) parts.push("0s");
    return parts.join(" ") + " ago";
  }

  // ---- systemctl ----------------------------------------------------------
  //
  // The formatting is systemd's: the coloured state marker, the "Loaded:" and
  // "Active:" lines with the elapsed time, then the unit's newest log lines
  // when --no-pager is not given.
  function systemctl() {}

  def("systemctl", function (args, stdin, sh) {
    var g = getopt("systemctl", args, {
      short: { q: "bool", a: "bool", f: "bool", r: "bool", n: "bool", l: "bool",
               s: "bool", p: "bool", t: "bool", H: "bool", "0": "bool" },
      long: { quiet: ["bool", "q"], all: ["bool", "a"], failed: ["bool", "f"],
              "no-pager": "bool", "full": ["bool", "l"], "no-ask-password": ["bool", "n"],
              "reverse": ["bool", "r"], "type": ["arg", "t"], "state": ["arg", "S"],
              "no-block": ["bool", "B"], "now": "bool", plain: "bool",
              "no-legend": "bool", "no-ask-password": ["bool", "n"], pager: "bool" },
    });
    if (g.version) return { out: systemdVersion(), code: 0 };
    if (g.help) return { out: systemctlHelp(), code: 0 };
    var done = finish(sh, "systemctl", g);
    if (done) return done;
    var S = LW.systemd;
    if (!S) return { out: "", code: 1 };
    S.init();
    var verbs = g._;
    var q = g.o.q || g.o.quiet, full = g.o.l || g.o.full, noPager = g.o["no-pager"];
    var out = "", code = 0;

    if (!verbs.length) {
      // no verb: systemctl is usable but says nothing on a pipe-less run
      return { out: "", code: 0 };
    }

    var verb = verbs[0];
    var names = verbs.slice(1);

    switch (verb) {
      case "status": return statusCmd(sh, names, { q: q, full: full, noPager: noPager });
      case "is-active": return eachUnit(sh, names, function (u) {
        return { text: u.active, code: u.active === "active" ? 0 : u.load === "not-found" ? 4 : 3 };
      });
      case "is-enabled": return eachUnit(sh, names, function (u) {
        return { text: u.enabled, code: u.enabled === "enabled" ? 0 : u.enabled === "static" ? 0 : 1 };
      });
      case "is-failed": return eachUnit(sh, names, function (u) {
        return { text: u.active === "failed" ? "failed" : "active", code: u.active === "failed" ? 0 : 1 };
      });
      case "start": return changeCmd(sh, names, function (u) { return S.setActive(u, true); },
        "Job " + unitName(names[0]) + " started.");
      case "stop": return changeCmd(sh, names, function (u) { return S.setActive(u, false); },
        "Job " + unitName(names[0]) + " stopped.");
      case "restart": case "try-restart": case "reload-or-restart":
        return changeCmd(sh, names, function (u) {
          var a = S.setActive(u, false);
          var b = S.setActive(u, true);
          return { ok: a.ok && b.ok, msg: a.msg || b.msg };
        }, "Job " + unitName(names[0]) + " restarted.");
      case "reload": return eachUnit(sh, names, function (u) {
        return u.active === "active"
          ? { text: "", code: 0 }
          : { text: "Job for " + u.unit + " failed.\n", code: 1 };
      });
      case "enable": return enableCmd(sh, names, true);
      case "disable": return enableCmd(sh, names, false);
      case "enable --now": case "disable --now":
        return enableCmd(sh, names, verb === "enable");
      case "cat":
        out = catUnits(sh, names);
        return { out: out, code: out ? 0 : 1 };
      case "show":
        out = showUnits(names);
        return { out: out, code: 0 };
      case "list-units": case "list-unit-files": case "list-dependencies":
        return listUnits(verb, names, { all: g.o.a || g.o.all, failed: g.o.f || g.o.failed,
          type: g.o.t, noLegend: g.o["no-legend"], plain: g.o.plain });
      case "daemon-reload":
        return { out: "", code: 0 };
      case "daemon-reexec":
        return { out: "", code: 0 };
      case "isolate": case "poweroff": case "reboot": case "halt": case "kexec":
        sh._error("Failed to " + verb + " target: Access to /dev/" + verb + " denied.");
        return { out: "", code: 1 };
      case "list-jobs":
        return { out: "No jobs running.\n", code: 0 };
      case "get-default":
        return { out: "graphical.target\n", code: 0 };
      case "set-default":
        return { out: "", code: 0 };
      default:
        return usage(sh, "systemctl", "Unknown operation " + verb + ".");
    }

    // ---- helpers -------------------------------------------------------
    // `systemctl status ssh` means ssh.service; a bare name that names nothing
    // is still reported as a service, which is what systemd does
    function unitName(arg) {
      if (!arg) return "";
      if (arg.indexOf(".") > 0) return arg;
      var base = arg;
      if (S.byName(base + ".service")) return base + ".service";
      if (S.byName(base + ".target")) return base + ".target";
      if (S.byName(base + ".mount")) return base + ".mount";
      return base + ".service";
    }
    function resolve(arg) {
      if (!arg) return null;
      var direct = S.byName(arg);
      if (direct) return direct;
      var guess = unitName(arg);
      return S.byName(guess) || null;
    }
    function eachUnit(sh2, args2, fn) {
      var out2 = "", code2 = 0;
      (args2.length ? args2 : []).forEach(function (arg) {
        var u = resolve(arg);
        if (!u) {
          // systemd answers "inactive" for a unit it has never heard of
          var r = fn({ active: "inactive", enabled: "not-found", unit: unitName(arg), load: "not-found" });
          out2 += r.text + "\n";
          if (r.code) code2 = r.code;
          return;
        }
        var r2 = fn(u);
        out2 += r2.text + "\n";
        if (r2.code) code2 = r2.code;
      });
      return { out: out2, code: code2 };
    }
    function changeCmd(sh2, args2, fn, message) {
      var out2 = "", code2 = 0;
      (args2.length ? args2 : []).forEach(function (arg) {
        var u = resolve(arg);
        if (!u) {
          sh2._error("Failed to start " + unitName(arg) + ". Unit " + unitName(arg) +
            " not found.");
          code2 = 5;
          return;
        }
        var r = fn(u);
        if (!r.ok) {
          sh2._error("Job for " + u.unit + " failed.");
          if (r.msg) sh2._error("Failed to " + verb + " " + u.unit + ": " + r.msg);
          code2 = 1;
          return;
        }
      });
      return { out: out2, code: code2 };
    }
    function enableCmd(sh2, args2, on) {
      var out2 = "", code2 = 0;
      (args2.length ? args2 : []).forEach(function (arg) {
        var u = resolve(arg);
        if (!u) {
          sh2._error("Failed to " + (on ? "enable" : "disable") + " unit: Unit " +
            unitName(arg) + " does not exist.");
          code2 = 1;
          return;
        }
        var r = S.setEnabled(u, on);
        if (!r.ok) { sh2._error(r.msg); code2 = 1; return; }
        if (!q) {
          var last = S.journal[S.journal.length - 1];
          if (last && last.unit === u.unit) out2 += last.message + "\n";
        }
      });
      return { out: out2, code: code2 };
    }
    function catUnits(sh2, args2) {
      var out2 = "", found = false;
      (args2.length ? args2 : []).forEach(function (arg) {
        var u = resolve(arg);
        if (!u) {
          sh2._error("No files found for " + unitName(arg) + ".");
          return;
        }
        found = true;
        out2 += "# " + u.file + "\n" + S.unitFileText(u);
        if (out2.slice(-1) !== "\n") out2 += "\n";
      });
      return found ? out2 : "";
    }
    function showUnits(args2) {
      var out2 = "";
      (args2.length ? args2 : []).forEach(function (arg) {
        var u = resolve(arg);
        if (!u) return;
        out2 += "Id=" + u.unit + "\n";
        out2 += "Description=" + u.desc + "\n";
        out2 += "LoadState=" + (u.load === "alias" ? "loaded" : u.load) + "\n";
        out2 += "ActiveState=" + u.active + "\n";
        out2 += "SubState=" + u.sub + "\n";
        out2 += "UnitFileState=" + u.enabled + "\n";
        out2 += "MainPID=" + (u.pid || 0) + "\n";
      });
      return out2;
    }
    function statusCmd(sh2, args2, flags) {
      if (!args2.length) args2 = [];
      var text = "", status = 0;
      args2.forEach(function (arg) {
        var u = resolve(arg);
        if (!u) {
          sh2._error("Unit " + unitName(arg) + " could not be found.");
          status = 4;
          return;
        }
        text += statusBlock(u, flags);
        if (u.active !== "active") status = 3;
        if (u.active === "failed") status = 1;
      });
      return { out: text, code: status };
    }
    function statusBlock(u, flags) {
      var dot = S.dot(u);
      var lines = [];
      lines.push(color(dot, dot === "●" ? 32 : dot === "×" ? 31 : 90) + " " +
        u.unit + " - " + u.desc);
      var loaded = u.load === "alias"
        ? "loaded (/lib/systemd/system/" + (u.file || "").split("/").pop() + ")"
        : "loaded (" + (u.file || "-") + "; " + u.enabled + "; vendor preset: enabled)";
      if (u.load === "not-found") loaded = "not-found";
      lines.push("     Loaded: " + loaded);
      var since = u.startedAt || (LW.bootTime ? LW.bootTime() : now());
      // a failed unit shows the result instead of the sub state
      var active = u.active === "failed"
        ? "failed (Result: " + (u.result || "exit-code") + ")"
        : u.active + " (" + u.sub + ")";
      active += " since " + strftime("%a %Y-%m-%d %H:%M:%S %Z", since) + "; " +
        humanAgo((now().getTime() - since.getTime()) / 1000);
      lines.push("     Active: " + active);
      lines.push("   Main PID: " + (u.pid ? u.pid + " (" + S.execPath(u).split("/").pop() + ")" : "-"));
      lines.push("      Tasks: " + (u.active === "active" && u.sub === "running" ? 1 : 0) +
        (u.kind === "service" ? " (limit: 3832)" : ""));
      lines.push("     Memory: " + (u.pid ? humanBytes(1_400_000 + u.unit.length * 997) : "0B"));
      lines.push("       CGroup: " + (u.pid ? "/system.slice/" + u.unit : "-"));
      if (u.pid) {
        lines.push("             \u2514\u2500" + u.pid + " " + S.execPath(u));
      }
      // systemd shows the last few log lines unless the output is not a tty
      if (!flags.noPager && !flags.q) {
        var entries = S.journal.filter(function (e) { return e.unit === u.unit; }).slice(-5);
        if (entries.length) {
          lines.push("");
          lines.push("Journal:");
          entries.forEach(function (e) {
            lines.push(color("     " + Sdot(), 90) + " " + strftime("%b %d %H:%M:%S", e.real, S.uptime()) +
              " " + V.HOST + " " + (e.ident || "") + (e.pid ? "[" + e.pid + "]" : "") + ": " +
              color(e.message, levelColor(e.priority)));
          });
        }
      }
      return lines.join("\n") + "\n";
    }
    function Sdot() { return "\u2022"; }
    function levelColor(p) {
      return p <= 3 ? 31 : p === 4 ? 33 : p <= 6 ? 32 : 90;
    }
    function humanBytes(n) {
      if (n >= 1048576) return (n / 1048576).toFixed(1) + "M";
      if (n >= 1024) return Math.round(n / 1024) + "K";
      return n + "B";
    }
    function color(text, code) {
      if (g.o.plain) return text;
      return "\x1b[" + code + "m" + text + "\x1b[0m";
    }
    function listUnits(which, args2, flags) {
      var rows = S.listUnits();
      if (which === "list-units") {
        if (flags.failed) rows = rows.filter(function (r) { return r.active === "failed"; });
        if (flags.type) {
          var want = String(flags.type);
          rows = rows.filter(function (r) { return r.kind.indexOf(want) >= 0 || want === "all"; });
        }
      } else {
        rows = rows.map(function (r) {
          return { unit: r.unit, load: r.file ? "loaded" : r.load, active: r.enabled,
                   sub: "", desc: r.desc, file: r.file, kind: r.kind };
        });
      }
      // systemd lays the table out from the widest cell in each column, with
      // the header in the same columns and two leading spaces
      var isFiles = which === "list-unit-files";
      var head = isFiles ? ["UNIT FILE", "STATE", "PRESET"] : ["UNIT", "LOAD", "ACTIVE", "SUB", "DESCRIPTION"];
      var width = head.map(function (h) { return h.length; });
      rows.forEach(function (r) {
        var cells = isFiles ? [r.unit, r.file || "", r.active]
          : [r.unit, r.load, r.active, r.sub, r.desc];
        cells.forEach(function (c, i) { width[i] = Math.max(width[i], c.length); });
      });
      var line = function (cells) {
        return "  " + cells.map(function (c, i) {
          return i === cells.length - 1 ? c : c.padEnd(width[i]);
        }).join(" ") + "\n";
      };
      var out2 = "";
      if (!flags.noLegend) out2 += line(head);
      rows.forEach(function (r) {
        out2 += isFiles ? line([r.unit, r.file || "", r.active])
          : line([r.unit, r.load, r.active, r.sub, r.desc]);
      });
      out2 += "\n" + rows.length + " " + (which === "list-unit-files" ? "unit files listed." : "loaded units listed.") + "\n";
      return { out: out2, code: 0 };
    }
  }, "Control the systemd system and service manager");

  function systemdVersion() {
    return "systemd 257 (257.5-1~deb13u1)\n+PAM +AUDIT +SECCOMP +APPARMOR +IMA\n";
  }

  function systemctlHelp() {
    return [
      "systemctl [OPTIONS...] COMMAND [UNIT...]",
      "",
      "Control the systemd system and service manager.",
      "",
      "  -q --quiet                  suppress output",
      "  -a --all                    show all units",
      "  -f --failed                 show failed units",
      "  -l --full                   show full unit details",
      "  -n --no-ask-password        do not ask for a password",
      "  -r --reverse                show a list of dependencies of all units",
      "  -t --type=TYPE              filter units of the given type",
      "      --failed                show failed units",
      "      --no-ask-password      do not ask for a password",
      "      --no-legend             do not show the legend",
      "      --no-pager              do not pipe output into a pager",
      "      --plain                 print output without colours",
      "  -q --quiet                  suppress output",
      "",
      "Commands:",
      "  list-units [PATTERN...]      list units",
      "  list-unit-files [PATTERN...] list unit files",
      "  status UNIT...              show unit status",
      "  is-active UNIT...           check whether units are active",
      "  is-enabled UNIT...          check whether units are enabled",
      "  start UNIT...               start units",
      "  stop UNIT...                stop units",
      "  restart UNIT...             restart units",
      "  reload UNIT...              reload units",
      "  enable UNIT...              enable units",
      "  disable UNIT...             disable units",
      "  cat UNIT...                 show unit files",
      "  show [PATTERN...]           show unit properties",
      "  daemon-reload               reload the manager configuration",
      "  list-jobs                   list jobs",
      "  get-default                 get the default target",
      "",
    ].join("\n");
  }

  function journalctlHelp() {
    return [
      "journalctl [OPTIONS...] [MATCHES...]",
      "",
      "Show messages from the system journal.",
      "",
      "  -b --boot                   show this boot's messages",
      "  -e --reboot                 show the last boot's messages",
      "  -f --follow                 follow the journal",
      "  -k --kernel                 show only kernel messages",
      "  -n, --lines=N               show the last N lines",
      "  -u, --unit=UNIT            show this unit's messages",
      "  -p, --priority=PRIORITY     filter by priority",
      "  -o, --output=FORMAT         change the output format",
      "  -r, --reverse               show the newest entry first",
      "  -S, --since=DATE            show entries since the date",
      "  -U, --until=DATE            show entries until the date",
      "  -q, --quiet                 suppress all output",
      "      --disk-usage            show disk usage",
      "      --list-boots            show a list of boots",
      "      --no-pager              do not pipe output into a pager",
      "",
    ].join("\n");
  }

  // ---- journalctl ---------------------------------------------------------
  //
  // The default "short" format is `<timestamp> <host> <ident>[<pid>]: <message>`,
  // with the timestamp in the C locale when the machine has no locale set.
  def("journalctl", function (args, stdin, sh) {
    var g = getopt("journalctl", args, {
      short: { f: "bool", e: "bool", b: "bool", k: "bool", x: "bool", r: "bool",
               q: "bool", a: "bool", n: "arg", u: "arg", p: "arg", o: "arg",
               S: "arg", U: "arg", t: "bool", P: "bool", D: "bool", "0": "bool" },
      long: { follow: ["bool", "f"], "reboot": ["bool", "b"], "boot": ["bool", "b"],
              kernel: ["bool", "k"], unit: ["arg", "u"], "unit-type": ["arg", "t"],
              priority: ["arg", "p"], output: ["arg", "o"], reverse: ["bool", "r"],
              quiet: ["bool", "q"], all: ["bool", "a"], lines: ["arg", "n"],
              "no-pager": ["bool", "P"], "disk-usage": "bool", "list-boots": "bool",
              since: ["arg", "S"], until: ["arg", "U"], "no-hostname": "bool",
              "short-output": "bool", "identifier": "bool" },
    });
    if (g.version) return { out: systemdVersion(), code: 0 };
    if (g.help) return { out: journalctlHelp(), code: 0 };
    var done = finish(sh, "journalctl", g);
    if (done) return done;
    var S = LW.systemd;
    if (!S) return { out: "", code: 1 };
    S.init();
    var o = g.o;

    if (o["disk-usage"]) {
      var bytes = S.journal.length * 168;
      return { out: "Archived and active journals take up " +
        humanSize(bytes) + " on disk.\n", code: 0 };
    }
    if (o["list-boots"]) {
      return { out: " ID BOOT TITLE\n" +
        "  1 " + strftime("%Y%m%d-%H%M%S", LW.bootTime ? LW.bootTime() : now(), S.uptime()) +
        " " + V.HOST + "\n", code: 0 };
    }

    var units = collectValues(o.u);
    var rows = S.journal.slice();
    if (o.k) rows = rows.filter(function (e) { return e.ident === "kernel" || !e.unit; });
    if (units.length) {
      rows = rows.filter(function (e) {
        return units.some(function (u) { return e.unit === u || e.unit === u + ".service" ||
          e.ident === u || e.ident === u + ".service"; });
      });
    }
    if (o.p !== undefined) {
      var wanted = collectValues(o.p).map(function (p) { return PRIO_NUM[p]; });
      rows = rows.filter(function (e) { return wanted.indexOf(e.priority) >= 0; });
    }
    if (o.f) rows = rows.filter(function (e) { return e.mono <= (o.f === "boot" ? 1e9 : 0); });
    if (o.S) rows = rows.filter(function (e) { return e.real >= parseWhen(o.S); });
    if (o.U) rows = rows.filter(function (e) { return e.real <= parseWhen(o.U); });
    if (o.n !== undefined) rows = rows.slice(-parseInt(o.n, 10));
    if (o.r) rows = rows.slice().reverse();

    var format = o.o === undefined ? "short" : String(o.o);
    var out = "";
    rows.forEach(function (e) { out += formatEntry(e, format) + "\n"; });
    if (!rows.length && !o.q) sh._error("-- No entries --");
    out += "-- Logs begin at " + strftime("%b %d %H:%M:%S", firstReal(), uptime()) + " --\n";
    if (!o.q && !o.P) {
      out += "-- No entries --\n";       // replaced below when there were entries
      out = out.replace("-- No entries --\n", "");
    }
    if (!o.q && !o.P) {
      out += "Hint: You are currently not seeing messages from other users and the system.\n" +
        "      Users and processes that belong to other users, which are not\n" +
        "      your own, are not shown, by default.\n" +
        "Hint: Try 'journalctl --help' for more information.\n";
    }
    return { out: out, code: 0 };

    function collectValues(v) {
      if (v === undefined) return [];
      return String(v).split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    }
    function parseWhen(text) {
      var t = Date.parse(text);
      return isNaN(t) ? now() : new Date(t);
    }
    function formatEntry(e, f) {
      switch (f) {
        case "cat": return e.message;
        case "export":
          return "__REALTIME_TIMESTAMP=" + e.real.getTime() + "\n" +
            "_BOOT_ID=" + bootId() + "\n__MONOTONIC_TIMESTAMP=" +
            Math.round(e.mono * 1e6) + "\n_SYSLOG_IDENTIFIER=" + e.ident + "\n" +
            "_PID=" + (e.pid || 0) + "\n" +
            "_SYSTEMD_UNIT=" + (e.unit || "") + "\nPRIORITY=" + e.priority + "\n" +
            "MESSAGE=" + e.message;
        case "verbose":
        case "json":
        case "json-pretty":
          return JSON.stringify({
            __REALTIME_TIMESTAMP: strftime("%Y-%m-%d %H:%M:%S", e.real, S.uptime()),
            _BOOT_ID: bootId(),
            PRIORITY: e.priority,
            _PID: e.pid || 0,
            _SYSTEMD_UNIT: e.unit || "",
            SYSLOG_IDENTIFIER: e.ident,
            MESSAGE: e.message,
          });
        case "short-iso":
          return strftime("%Y-%m-%dT%H:%M:%S", e.real, S.uptime()) + " " + V.HOST + " " + ident(e) + ": " + e.message;
        case "short-precise":
          return strftime("%b %d %H:%M:%S", e.real, S.uptime()) + "." +
            String(e.real.getUTCMilliseconds()).padStart(3, "0") + " " + V.HOST + " " +
            ident(e) + ": " + e.message;
        case "short-precise-iso":
          return strftime("%Y-%m-%dT%H:%M:%S", e.real, S.uptime()) + "." +
            String(e.real.getUTCMilliseconds()).padStart(3, "0") + " " + V.HOST + " " +
            ident(e) + ": " + e.message;
        default:
          return strftime("%b %d %H:%M:%S", e.real, S.uptime()) + " " + V.HOST + " " + ident(e) + ": " + e.message;
      }
    }
    function ident(e) {
      return e.ident + (e.pid ? "[" + e.pid + "]" : "");
    }
    function bootId() {
      var d = LW.bootTime ? LW.bootTime() : now();
      var hex = d.getTime().toString(16);
      while (hex.length < 32) hex = "0" + hex;
      return hex;
    }
    function humanSize(n) {
      if (n >= 1048576) return (n / 1048576).toFixed(1) + "M";
      if (n >= 1024) return Math.round(n / 1024) + "K";
      return n + "B";
    }
    function firstReal() {
      return S.journal.length ? S.journal[0].real : (LW.bootTime ? LW.bootTime() : now());
    }
  }, "query the system journal");

  // ---- the rest of the identity commands ----------------------------------
  function defSys(name, doc, run) { def(name, run, doc); }

  defSys("hostname", "print the hostname", function (args, stdin, sh) {
    return { out: V.HOST + "\n", code: 0 };
  });

  defSys("hostnamectl", "show the hostname and OS information", function (args, stdin, sh) {
    var rel = V.readFile("/etc/os-release") || "";
    var name = (/^NAME="?([^"\n]*)"?/m.exec(rel) || [])[1] || "Debian GNU/Linux";
    var pretty = (/^PRETTY_NAME="?([^"\n]*)"?/m.exec(rel) || [])[1] || name;
    var out = [
      " Static hostname: " + V.HOST,
      "       Icon name: computer-vm",
      "         Machine ID: " + machineId(),
      "      Boot ID: " + bootIdHex(),
      "",
    ].join("\n");
    var lines = [
      ["Operating System: " + name],
      ["        Kernel: Linux"],
      ["  Kernel Version: 7.2.8"],
      ["    Architecture: x86-64"],
    ];
    var row = "           " + lines[0][0].padEnd(22) + ": " + lines[0][1];
    out += row + "\n";
    lines.slice(1).forEach(function (l) {
      out += "    " + l[0].padEnd(22) + ": " + l[1] + "\n";
    });
    var prettyLine = "      " + "Operating System: ".padEnd(22) + ": " + pretty;
    out = out.replace(/^\s*Operating System:.*$/m, prettyLine);
    return { out: out, code: 0 };

    function machineId() {
      var raw = V.readFile("/etc/machine-id");
      return raw ? raw.trim() : "0" * 32;
    }
    function bootIdHex() {
      var hex = (LW.bootTime ? LW.bootTime().getTime() : Date.now()).toString(16);
      while (hex.length < 32) hex = "0" + hex;
      return hex.slice(0, 32);
    }
  });

  defSys("uname", "print system information", function (args, stdin, sh) {
    var g = getopt("uname", args, {
      short: { a: "bool", s: "bool", n: "bool", r: "bool", v: "bool", m: "bool",
               p: "bool", i: "bool", o: "bool", "0": "bool" },
      long: { all: ["bool", "a"], kernel: ["bool", "s"], nodename: ["bool", "n"],
              "kernel-release": ["bool", "r"], version: ["bool", "v"],
              machine: ["bool", "m"], processor: ["bool", "p"],
              "hardware-platform": ["bool", "i"], "operating-system": ["bool", "o"] },
    });
    var done = finish(sh, "uname", g);
    if (done) return done;
    var o = g.o;
    // with nothing selected uname prints the kernel name alone
    if (o.a) return { out: ["Linux", V.HOST, "7.2.8", "#1 SMP PREEMPT_DYNAMIC",
      "x86_64", "GNU/Linux"].join(" ") + "\n", code: 0 };
    var parts = [];
    if (o.s || (!o.n && !o.r && !o.v && !o.m && !o.p && !o.i && !o.o)) parts.push("Linux");
    if (o.n || (!o.s && !o.r && !o.v && !o.m && !o.p && !o.i && !o.o)) parts.push(V.HOST);
    if (o.r) parts.push("7.2.8");
    if (o.v) parts.push("#1 SMP PREEMPT_DYNAMIC");
    if (o.m || o.p || o.i) parts.push("x86_64");
    if (o.o) parts.push("GNU/Linux");
    return { out: parts.join(" ") + "\n", code: 0 };
  });

  defSys("arch", "print the machine architecture", function (args, stdin, sh) {
    return { out: "x86_64\n", code: 0 };
  });

  defSys("whoami", "print the effective user name", function (args, stdin, sh) {
    return { out: V.USER + "\n", code: 0 };
  });

  defSys("id", "print user identity", function (args, stdin, sh) {
    return { out: "uid=1000(" + V.USER + ") gid=1000(" + V.USER + ") groups=1000(" +
      V.USER + "),27(sudo),60(lpadmin)\n", code: 0 };
  });

  defSys("who", "display who is logged in", function (args, stdin, sh) {
    return { out: V.USER + "     pts/0        " + strftime("%Y-%m-%d %H:%M", now(), uptime()) +
      " (10.0.2.2)\n", code: 0 };
  });

  defSys("tty", "print the terminal name", function (args, stdin, sh) {
    return { out: "not a tty\n", code: 1 };
  });

  defSys("nproc", "print the number of processing units available", function (args, stdin, sh) {
    return { out: "4\n", code: 0 };
  });

})(window.LW);