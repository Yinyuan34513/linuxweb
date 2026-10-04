// apt, emulated: a package catalogue whose packages install *working* commands.
//
// State lives in /var/lib/dpkg/status in dpkg's own text format, so installed
// packages survive a reload (the file is in the IDBFS) and are re-bound to their
// implementations at boot.  `apt install cowsay` really does give you cowsay.
(function (LW) {
  "use strict";

  var V = LW.VFS;
  var STATUS = "/var/lib/dpkg/status";
  var LISTS = "/var/lib/apt/lists";

  // ============================ ASCII art ================================

  var FIGLET = {
    A: ["  __ _ ", " / _` |", "| (_| |", " \\__,_|"],
    B: [" _    ", "| |__ ", "| '_ \\", "|_.__/"],
    C: ["  ___ ", " / __|", "| (__ ", " \\___|"],
    D: [" ___  ", "|   \\ ", "| |) |", "|___/ "],
    E: [" ___ ", "| __|", "| _| ", "|___|"],
    F: [" ___ ", "| __|", "| _| ", "|_|  "],
    G: ["  ___ ", " / __|", "| (_ |", " \\___|"],
    H: [" _   _ ", "| |_| |", "|  _  |", "|_| |_|"],
    I: [" ___ ", "|_ _|", " | | ", "|___|"],
    J: ["   _ ", "  | |", " _| |", "\\__/ "],
    K: [" _  __", "| |/ /", "| ' < ", "|_|\\_\\"],
    L: [" _    ", "| |   ", "| |__ ", "|____|"],
    M: [" __  __ ", "|  \\/  |", "| |\\/| |", "|_|  |_|"],
    N: [" _  _ ", "| \\| |", "| .  |", "|_|\\_|"],
    O: ["  ___  ", " / _ \\ ", "| (_) |", " \\___/ "],
    P: [" ___  ", "| _ \\ ", "|  _/ ", "|_|   "],
    Q: ["  ___  ", " / _ \\ ", "| (_) |", " \\__\\_\\"],
    R: [" ___  ", "| _ \\ ", "|   / ", "|_|_\\ "],
    S: [" ___ ", "/ __|", "\\__ \\", "|___/"],
    T: [" _____ ", "|_   _|", "  | |  ", "  |_|  "],
    U: [" _   _ ", "| | | |", "| |_| |", " \\___/ "],
    V: ["__   __", "\\ \\ / /", " \\ V / ", "  \\_/  "],
    W: ["__      __", "\\ \\    / /", " \\ \\/\\/ / ", "  \\_/\\_/  "],
    X: ["__  __", "\\ \\/ /", " >  < ", "/_/\\_\\"],
    Y: ["__   __", "\\ \\ / /", " \\ V / ", "  |_|  "],
    Z: [" ___ ", "|_  )", " / / ", "/___|"],
    "0": [" ___ ", "/ _ \\", "| (_) |", "\\___/"],
    "1": [" _ ", "/ |", "| |", "|_|"],
    "2": [" ___ ", "|_  )", " / / ", "/___|"],
    "3": [" ____", "|__ /", " |_ \\", "|___/"],
    "4": [" _ _  ", "| | | ", "|_  _|", "  |_| "],
    "5": [" ___ ", "| __|", "|__ \\", "|___/"],
    "6": ["  __ ", " / / ", "/ _ \\", "\\___/"],
    "7": [" ____", "|__  |", "  / / ", " /_/  "],
    "8": [" ___ ", "( _ )", "/ _ \\", "\\___/"],
    "9": [" ___ ", "/ _ \\", "\\_, /", " /_/ "],
    " ": ["   ", "   ", "   ", "   "],
    "!": ["_", "|", "|", "."],
    "-": ["      ", " ____ ", "|____|", "      "],
  };

  var LOGO = [
    "       .--.",
    "      |o_o |",
    "      |:_/ |",
    "     //   \\ \\",
    "    (|     | )",
    "   /'\\_   _/`\\",
    "   \\___)=(___/",
    "",
    "        \\   ^__^",
    "         \\  (oo)\\_______",
    "            (__)\\       )\\/\\",
    "                ||----w |",
    "                ||     ||",
  ];

  var FORTUNES = [
    "You will be surprised by a loud noise.",
    "Today is the tomorrow you worried about yesterday.",
    "A bug in the hand is better than two as yet undetected.",
    "Programs must be written for people to read, and only incidentally for machines to execute.",
    "Unix is user-friendly. It's just very selective about who its friends are.",
    "To err is human; to blame it on the computer is even more so.",
    "The best way to accelerate a Linux box is at 9.8 m/s^2.",
    "There are only two hard things in computing: cache invalidation, naming, and off-by-one errors.",
    "Real programmers count from 0.",
    "You can't grep dead trees.",
  ];

  // ============================ implementations ==========================

  function wrapText(s, w) {
    var words = s.split(/\s+/), lines = [], cur = "";
    words.forEach(function (word) {
      if ((cur + " " + word).trim().length > w) { lines.push(cur.trim()); cur = word; }
      else cur += " " + word;
    });
    if (cur.trim()) lines.push(cur.trim());
    return lines;
  }

  function cowsay(text, eyes, tongue) {
    var msg = wrapText(text || "moo", 40);
    var w = Math.max.apply(null, msg.map(function (l) { return l.length; }));
    var out = " " + "_".repeat(w + 2) + "\n";
    if (msg.length === 1) {
      out += "< " + msg[0] + " ".repeat(w - msg[0].length) + " >\n";
    } else {
      msg.forEach(function (l, i) {
        var a = i === 0 ? "/" : i === msg.length - 1 ? "\\" : "|";
        var b = i === 0 ? "\\" : i === msg.length - 1 ? "/" : "|";
        out += a + " " + l + " ".repeat(w - l.length) + " " + b + "\n";
      });
    }
    out += " " + "-".repeat(w + 2) + "\n";
    var e = eyes || "oo", t = tongue === undefined ? "  " : tongue;
    out += "        \\   ^__^\n";
    out += "         \\  (" + e + ")\\_______\n";
    out += "            (__)\\       )\\/\\\n";
    out += "             " + t + " ||----w |\n";
    out += "                ||     ||\n";
    return out;
  }

  function figlet(text) {
    var rows = ["", "", "", ""];
    String(text).toUpperCase().split("").forEach(function (ch) {
      var g = FIGLET[ch] || FIGLET["-"];
      for (var r = 0; r < 4; r++) rows[r] += (g[r] || "") + " ";
    });
    return rows.join("\n").replace(/\s+$/, "") + "\n";
  }

  function neofetch(q) {
    if (q.a || q.all) { /* fall through to the full output */ }
    var info = [
      "linuxweb@linuxweb",
      "-----------------",
      "OS: Debian GNU/Linux 13 (trixie) x86_64",
      "Host: QEMU Standard PC (i440FX + PIIX, 1996)",
      "Kernel: 7.2.8",
      "Uptime: 15 mins",
      "Packages: " + installedNames().length + " (dpkg)",
      "Shell: bash " + (LW.BASH ? LW.BASH.versionString : "5.3.0(1)-release"),
      "Resolution: 80x25 text mode",
      "DE: none",
      "Terminal: linux console (/dev/tty" + (LW.VTs ? LW.VTs.activeVt() : 1) + ")",
      "CPU: 12th Gen Intel(R) Core(TM) i7-12700H (2) @ 2.688GHz",
      "GPU: cirrusdrmfb",
      "Memory: 1419MiB / 1984MiB",
    ];
    var n = Math.max(LOGO.length, info.length), out = "";
    for (var i = 0; i < n; i++) {
      out += (LOGO[i] || " ".repeat(20)).padEnd(21) + (info[i] || "") + "\n";
    }
    return out;
  }

  // ============================ the catalogue ============================

  // Each package may carry `cmds`: the commands it installs.  A command gets
  // (args, stdin, sh) and returns {out, code}, or {async, start} to take over.
  var CATALOG = [
    {
      name: "cowsay", version: "3.7.0-1", section: "games", size: 35600, arch: "all",
      priority: "optional", suggests: ["filters", "cowsay-off"], depends: "perl:any",
      desc: "configurable talking cow",
      long: ["Cowsay generates an ASCII picture of a cow saying something provided by the user."],
      cmds: {
        cowsay: function (args) {
          var o = { eyes: null, list: false, text: [] };
          var a = args.slice(), i = 0, textParts = [];
          while (i < a.length) {
            if (a[i] === "-e" || a[i] === "-T" || a[i] === "-W") { var k = a[i++]; var v = a[i++]; if (k === "-e") o.eyes = v; continue; }
            if (a[i] === "-l") { o.list = true; i++; continue; }
            if (a[i].charAt(0) === "-" && a[i].length > 1) { i++; continue; }
            textParts.push(a[i++]);
          }
          if (o.list) return { out: "beavis.zen bong bud-frogs bunny cheese cow daemon default dragon\n", code: 0 };
          return { out: cowsay(textParts.join(" "), o.eyes), code: 0 };
        },
      },
      binary: "cowsay",
    },
    {
      name: "fortune-mod", version: "1:1.99.1-7", section: "games", size: 1548000, arch: "amd64",
      suggests: ["fortunes-min"], depends: "libc6 (>= 2.34)",
      desc: "provides fortune cookies on demand",
      binary: "fortune",
      cmds: {
        fortune: function (args) { return { out: FORTUNES[Math.floor(Math.random() * FORTUNES.length)] + "\n", code: 0 }; },
      },
    },
    {
      name: "figlet", version: "2.2.5-3", section: "text", size: 311000, arch: "amd64",
      depends: "libc6 (>= 2.34)", desc: "Make large character ASCII banners out of ordinary text",
      binary: "figlet",
      cmds: {
        figlet: function (args) {
          if (!args.length) return { out: "figlet: missing input\n", code: 1 };
          return { out: figlet(args.join(" ")), code: 0 };
        },
      },
    },
    {
      name: "neofetch", version: "7.1.0-4", section: "utils", size: 326000, arch: "all",
      suggests: ["curl", "w3m"], desc: "shows Linux System Information with Distribution Logo",
      binary: "neofetch",
      cmds: { neofetch: function (args) { return { out: neofetch({}), code: 0 }; } },
    },
    {
      name: "sl", version: "5.02-1", section: "games", size: 28900, arch: "amd64",
      suggests: ["sl-doc"], depends: "libc6 (>= 2.34)", desc: "Correct you if you type `sl' by mistake",
      binary: "sl",
      cmds: {
        sl: function (args, stdin, sh) {
          return {
            async: true,
            start: function (io) {
              var frame = 0, t = io.term;
              var art = [
                "        ====        ________                ___________ ",
                "    _D _|  |_______/        \\__I_I_____===__|_________| ",
                "     |(_)---  |   H\\________/ |   |        =|___ ___|   ",
                "     /     |  |   H  |  |     |   |         ||_| |_||   ",
                "    |      |  |   H  |__--------------------| [___] |   ",
                "    | ________|___H__/__|_____/[][]~\\_______|       |   ",
                "    |/ |   |-----------I_____I [][] []  D   |=======|__ ",
                "  __/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__ ",
                "   |/-=|___|=    ||    ||    ||    |_____/~\\___/        ",
                "    \\_/      \\O=====O=====O=====O_/      \\_/            ",
              ];
              function draw() {
                t.write("\x1b[2J");
                for (var y = 0; y < art.length; y++) {
                  t.write("\x1b[" + (y + 1) + ";1H" + art[y].slice(frame % 20));
                }
                t.write("\x1b[" + (art.length + 2) + ";1H");
              }
              var timer = setInterval(function () {
                if (io.aborted) { clearInterval(timer); t.write("\n"); return io.done(130); }
                frame += 2;
                draw();
                if (frame > 60) {
                  clearInterval(timer);
                  t.write("\n");
                  io.done(0);
                }
              }, 60);
            },
          };
        },
      },
    },
    {
      name: "cmatrix", version: "2.0-3", section: "games", size: 42500, arch: "amd64",
      desc: "simulates the display from \"The Matrix\"",
      binary: "cmatrix",
      cmds: {
        cmatrix: function (args, stdin, sh) {
          return {
            async: true,
            start: function (io) {
              var t = io.term, cols = t.cols, rows = t.rows;
              var chars = "abcdefghijklmnopqrstuvwxyz0123456789@#$%&*+=<>";
              var drops = [];
              for (var i = 0; i < cols; i++) drops.push(Math.floor(Math.random() * rows));
              var frames = 0;
              t.write("\x1b[?25l");
              var timer = setInterval(function () {
                if (io.aborted) { clearInterval(timer); t.write("\x1b[?25h\x1b[2J\x1b[H"); return io.done(130); }
                for (var c = 0; c < cols; c += 2) {
                  var r = drops[c];
                  t.write("\x1b[" + (r + 1) + ";" + (c + 1) + "H" +
                    "\x1b[1;32m" + chars.charAt(Math.floor(Math.random() * chars.length)) + "\x1b[0m");
                  drops[c] = (r + 1) % rows;
                }
                if (++frames > 40) {
                  clearInterval(timer);
                  t.write("\x1b[?25h\x1b[2J\x1b[H");
                  io.done(0);
                }
              }, 55);
            },
          };
        },
      },
    },
    {
      name: "htop", version: "3.4.1-1", section: "utils", size: 311000, arch: "amd64",
      depends: "libc6 (>= 2.38), libncursesw6 (>= 6)", desc: "interactive processes viewer",
      binary: "htop",
      cmds: {
        htop: function (args, stdin, sh) {
          var pct = [12, 4], rows = [];
          function bar(p) {
            var full = Math.round(p / 100 * 30);
            return "[" + "\u2593".repeat(full) + " ".repeat(30 - full) + "]";
          }
          rows.push("\x1b[1;32m  1" + bar(pct[0]) + "\x1b[0m  \x1b[1;36m  2" + bar(pct[1]) + "\x1b[0m");
          rows.push("");
          rows.push("  Mem" + bar(72) + " 1.42G/1.98G");
          rows.push("  Swp" + bar(0) + " 0K/0K");
          rows.push("");
          rows.push("  \x1b[7m  PID USER      PRI  NI  VIRT   RES S CPU% MEM%   TIME+  Command\x1b[0m");
          var procs = [
            [1, "root", 20, 0, "22.4M", "12.1M", "S", 0.0, 0.6, "0:03.12", "/sbin/init"],
            [412, "root", 20, 0, "18.9M", "8.4M", "S", 0.0, 0.4, "0:00.51", "/usr/lib/systemd/systemd-journald"],
            [701, "linuxweb", 20, 0, "10.2M", "5.1M", "S", 0.0, 0.2, "0:00.09", "-bash"],
            [902, "linuxweb", 20, 0, "8.7M", "4.0M", "R", 1.3, 0.2, "0:00.02", "htop"],
          ];
          procs.forEach(function (p) { rows.push("  " + String(p[0]).padStart(5) + " " + p[1].padEnd(9) + " " + p[2] + "   " + p[3] + "  " + p[4].padStart(5) + " " + p[5].padStart(6) + " " + p[6] + " " + p[7].toFixed(1).padStart(5) + " " + p[8].toFixed(1).padStart(5) + " " + p[9].padStart(8) + " " + p[10]); });
          rows.push("");
          rows.push("\x1b[1;32mF1\x1b[0mHelp  \x1b[1;32mF2\x1b[0mSetup \x1b[1;32mF3\x1b[0mSearch \x1b[1;32mF10\x1b[0mQuit");
          return {
            async: true,
            start: function (io) {
              var t = io.term;
              // full-screen apps use the alternate screen, exactly like htop
              t.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
              t.write("\x1b[1;7m  htop\x1b[0m  (emulated snapshot \u2014 press any key)\n\n");
              rows.forEach(function (r) { t.write(r + "\n"); });
              var done = false;
              function finish() {
                if (done) return; done = true;
                t.write("\x1b[?25h\x1b[?1049l");
                io.done(0);
              }
              io.onKey = function () { finish(); return true; };
              io.timeout = setTimeout(finish, 2500);
            },
          };
        },
      },
    },
    {
      name: "curl", version: "8.14.1-2", section: "web", size: 224000, arch: "amd64",
      depends: "libc6 (>= 2.38), libcurl4t64 (= 8.14.1-2)", desc: "command line tool for transferring data with URL syntax",
      binary: "curl",
      cmds: {
        curl: function (args, stdin, sh) {
          var url = args.filter(function (a) { return a.charAt(0) !== "-"; })[0];
          if (!url) return { out: "curl: try 'curl --help' for more information\n", code: 2 };
          var host = /^https?:\/\/([^\/]+)/.exec(url);
          host = host ? host[1] : url;
          return {
            out: "  % Total    % Received % Xferd  Average Speed   Time\n" +
              "100  1256  100  1256    0     0   2048      0 --:--:-- --:--:-- --:--:--  4096\n" +
              "<!DOCTYPE html>\n<html><head><title>" + host + "</title></head>\n" +
              "<body><h1>It works!</h1>\n<p>linuxweb has no network, but says hello.</p></body></html>\n",
            code: 0,
          };
        },
      },
    },
    {
      name: "git", version: "1:2.49.0-1", section: "vcs", size: 15560000, arch: "amd64",
      suggests: ["git-doc", "gitk"], depends: "libc6 (>= 2.38), zlib1g (>= 1:1.2.0)",
      desc: "fast, scalable, distributed revision control system",
      binary: "git",
      cmds: {
        git: function (args, stdin, sh) {
          if (!args.length || args[0] === "--version") return { out: "git version 2.49.0\n", code: 0 };
          if (args[0] === "init") {
            var p = sh.path(args[1] || ".");
            V.mkdirp(p + "/.git");
            V.writeFile(p + "/.git/HEAD", "ref: refs/heads/main\n", false);
            V.mkdirp(p + "/.git/objects");
            V.mkdirp(p + "/.git/refs/heads");
            return { out: "Initialized empty Git repository in " + p + "/.git/\n", code: 0 };
          }
          if (args[0] === "status") {
            return { out: "On branch main\n\nNo commits yet\n\nnothing to commit (create/copy files and use \"git add\" to track)\n", code: 0 };
          }
          return { out: "git: '" + args[0] + "' is not supported by this emulation\n", code: 1 };
        },
      },
    },
    {
      name: "hello", version: "2.10-3", section: "devel", size: 52000, arch: "amd64",
      desc: "example package based on GNU hello",
      binary: "hello",
      cmds: {
        hello: function (args) {
          if (args[0] === "--version") return { out: "hello (GNU hello) 2.10\n", code: 0 };
          return { out: "Hello, world!\n", code: 0 };
        },
      },
    },
  ];

  var BY_NAME = {};
  CATALOG.forEach(function (p) { BY_NAME[p.name] = p; });

  // ============================ dpkg status ==============================

  function parseStatus(text) {
    var out = [];
    (text || "").split("\n\n").forEach(function (block) {
      if (!block.trim()) return;
      var rec = {};
      block.split("\n").forEach(function (line) {
        var m = /^([A-Za-z-]+):\s?(.*)$/.exec(line);
        if (m) { rec[m[1]] = m[2]; if (m[1] === "Description") rec.desc = m[2]; }
      });
      if (rec.Package) out.push(rec);
    });
    return out;
  }

  function installedNames() {
    return parseStatus(V.readFile(STATUS) || "").map(function (r) { return r.Package; });
  }

  function statusText(records) {
    return records.map(function (r) {
      var lines = [
        "Package: " + r.Package,
        "Status: install ok installed",
        "Priority: optional",
        "Section: " + (r.Section || "misc"),
        "Installed-Size: " + (r["Installed-Size"] || 100),
        "Maintainer: Emulation <emulated@linuxweb>",
        "Architecture: " + (r.Architecture || "amd64"),
        "Version: " + r.Version,
        "Depends: " + (r.Depends || ""),
        "Description: " + (r.desc || r.Description || ""),
      ];
      return lines.join("\n") + "\n";
    }).join("\n");
  }

  // apt/dpkg keep their state in a few directories that a fresh image may not
  // have; create them once so the status file is not silently lost.
  function ensureDirs() {
    ["/var/lib/dpkg", "/var/lib/apt/lists/partial", "/usr/share/doc"].forEach(function (d) {
      V.mkdirp(d);
    });
    if (V.readFile(STATUS) === null) V.writeFile(STATUS, "", false);
  }

  function writeStatus(records) {
    if (!V.getNode("/var/lib/dpkg")) V.mkdirp("/var/lib/dpkg");
    V.writeFile(STATUS, statusText(records), false);
  }

  function recordFor(p) {
    return {
      Package: p.name, Version: p.version, Section: p.section,
      Architecture: p.arch, desc: p.desc,
      "Installed-Size": Math.round(p.size / 1024),
    };
  }

  // ============================ install / remove =========================

  var cmds = {};          // the dynamic command namespace the shell consults

  function bindCommands() {
    Object.keys(cmds).forEach(function (k) { if (cmds[k].__pkg) delete cmds[k]; });
    installedNames().forEach(function (n) {
      var p = BY_NAME[n];
      if (!p || !p.cmds) return;
      Object.keys(p.cmds).forEach(function (c) {
        cmds[c] = function (args, stdin, sh) { return p.cmds[c](args, stdin, sh); };
        cmds[c].__pkg = n;
      });
    });
  }

  function placeFiles(p) {
    if (p.binary) {
      V.writeFile("/usr/bin/" + p.binary,
        "\x7fELF\x02\x01\x01\x00" + "\u0000".repeat(56) + p.name + " (emulated)\n", false);
    }
    V.mkdirp("/usr/share/doc/" + p.name);
    V.writeFile("/usr/share/doc/" + p.name + "/copyright",
      "This package is emulated by linuxweb, not downloaded from Debian.\n" +
      "Package: " + p.name + " " + p.version + "\n", false);
    V.writeFile("/usr/share/doc/" + p.name + "/changelog.Debian.gz",
      "gzip compressed data (emulated)\n", false);
  }

  function removeFiles(p) {
    if (p.binary) V.unlink("/usr/bin/" + p.binary);
    ["copyright", "changelog.Debian.gz"].forEach(function (f) {
      V.unlink("/usr/share/doc/" + p.name + "/" + f);
    });
    V.unlink("/usr/share/doc/" + p.name);
  }

  function install(p, records) {
    var recs = records.filter(function (r) { return r.Package !== p.name; });
    recs.push(recordFor(p));
    writeStatus(recs);
    placeFiles(p);
    bindCommands();
    return recs;
  }

  function remove(p, records) {
    var recs = records.filter(function (r) { return r.Package !== p.name; });
    writeStatus(recs);
    removeFiles(p);
    bindCommands();
    return recs;
  }

  function records() { return parseStatus(V.readFile(STATUS) || ""); }

  // ============================ the apt command ==========================

  function humanSize(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(1) + " kB";
    return n + " B";
  }

  function fetchLine(i, p) {
    // real: Get:1 http://deb.debian.org/debian trixie/main amd64 cowsay all 3.7.0-1 [35.6 kB]
    return "Get:" + i + " http://deb.debian.org/debian trixie/main " + p.arch + " " +
      p.name + " " + p.arch + " " + p.version + " [" + humanSize(p.size) + "]";
  }

  function aptInstall(names, opts, io) {
    var want = [], missing = [];
    names.forEach(function (n) {
      if (BY_NAME[n]) want.push(BY_NAME[n]); else if (n) missing.push(n);
    });
    if (!want.length) {
      io.write("E: Unable to locate package " + missing.join(", ") + "\n");
      return io.done(100);
    }
    var already = records();
    var have = already.map(function (r) { return r.Package; });
    var todo = want.filter(function (p) { return have.indexOf(p.name) < 0; });
    if (!todo.length) {
      todo = [];
      io.write("Reading package lists... Done\n");
      io.write("Building dependency tree... Done\n");
      io.write("Reading state information... Done\n");
      want.forEach(function (p) { io.write(p.name + " is already the newest version (" + p.version + ").\n"); });
      io.write("0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n");
      return io.done(0);
    }
    var totalBytes = todo.reduce(function (a, p) { return a + p.size; }, 0);
    var steps = [];
    steps.push(function () {
      io.write("Reading package lists... Done\n");
      io.write("Building dependency tree... Done\n");
      io.write("Reading state information... Done\n");
      if (missing.length) {
        io.write("E: Unable to locate package " + missing.join(", ") + "\n");
        return;
      }
      var suggests = [];
      todo.forEach(function (p) { (p.suggests || []).forEach(function (s) { suggests.push(s); }); });
      if (suggests.length) {
        io.write("Suggested packages:\n");
        io.write("  " + suggests.join(" ") + "\n");
      }
      io.write("The following NEW packages will be installed:\n");
      io.write("  " + todo.map(function (p) { return p.name; }).join(" ") + "\n");
      io.write("0 upgraded, " + todo.length + " newly installed, 0 to remove and 0 not upgraded.\n");
      io.write("Need to get " + humanSize(totalBytes) + " of archives.\n");
      io.write("After this operation, " + humanSize(totalBytes * 3) + " of additional disk space will be used.\n");
    });
    todo.forEach(function (p, idx) {
      steps.push(function () {
        io.write(fetchLine(idx + 1, p) + "\n");
      });
      steps.push(function () {
        // a progress line redrawn in place with CR + erase-to-end-of-line
        var pct = 0;
        io.write("\r" + humanSize(p.size) + " " + "100%".padStart(20) + "  " + humanSize(p.size * 8) + "/s  0s");
      });
    });
    steps.push(function () {
      io.write("Fetched " + humanSize(totalBytes) + " in 1s (" + humanSize(totalBytes) + "/s)\n");
    });
    todo.forEach(function (p) {
      steps.push(function () { io.write("Selecting previously unselected package " + p.name + ".\n"); });
      steps.push(function () {
        // dpkg's own database line, exactly as it appears during an install
        io.write("(Reading database ... 332820 files and directories currently installed.)\n");
        io.write("Preparing to unpack .../archives/" + p.name + "_" + p.version + "_" + p.arch + ".deb ...\n");
        io.write("Unpacking " + p.name + " (" + p.version + ") ...\n");
      });
    });
    todo.forEach(function (p) {
      steps.push(function () {
        install(p, records());
        io.write("Setting up " + p.name + " (" + p.version + ") ...\n");
        if (Object.keys(p.cmds || {}).length) io.write("Processing triggers for man-db (2.13.1-1) ...\n");
      });
    });
    steps.push(function () {
      io.write("\nThe following commands are now available: " +
        todo.map(function (p) { return Object.keys(p.cmds || {}).join(" "); }).join(" ") + "\n");
    });
    return runSteps(steps, io, opts.quiet ? 0 : 45);
  }

  function aptRemove(names, opts, io) {
    var recs = records();
    var have = recs.map(function (r) { return r.Package; });
    var todo = names.filter(function (n) { return have.indexOf(n) >= 0; });
    if (!todo.length) {
      io.write("Reading package lists... Done\n");
      io.write("Building dependency tree... Done\n");
      io.write("Reading state information... Done\n");
      names.forEach(function (n) { io.write("Package '" + n + "' is not installed, so not removed\n"); });
      return io.done(0);
    }
    var steps = [
      function () {
        io.write("Reading package lists... Done\n");
        io.write("Building dependency tree... Done\n");
        io.write("Reading state information... Done\n");
        io.write("The following packages will be REMOVED:\n  " + todo.join(" ") + "\n");
        io.write("0 upgraded, 0 newly installed, " + todo.length + " to remove and 0 not upgraded.\n");
      },
    ];
    todo.forEach(function (n) {
      steps.push(function () {
        remove(BY_NAME[n], records());
        io.write("Removing " + n + " (" + BY_NAME[n].version + ") ...\n");
      });
    });
    return runSteps(steps, io, opts.quiet ? 0 : 45);
  }

  function runSteps(steps, io, delay) {
    var i = 0;
    function next() {
      if (i >= steps.length) return io.done(0);
      steps[i++]();
      if (delay) setTimeout(next, delay); else next();
    }
    next();
  }

  // ============================ apt / dpkg ===============================

  // Copied verbatim from `apt --help` on a Debian-family box.
  var APT_HELP =
    "apt 2.9.17 (amd64)\n" +
    "Usage: apt [options] command\n" +
    "\n" +
    "apt is a commandline package manager and provides commands for\n" +
    "searching and managing as well as querying information about packages.\n" +
    "It provides the same functionality as the specialized APT tools,\n" +
    "like apt-get and apt-cache, but enables options more suitable for\n" +
    "interactive use by default.\n" +
    "\n" +
    "Most used commands:\n" +
    "  list - list packages based on package names\n" +
    "  search - search in package descriptions\n" +
    "  show - show package details\n" +
    "  install - install packages\n" +
    "  reinstall - reinstall packages\n" +
    "  remove - remove packages\n" +
    "  autoremove - automatically remove all unused packages\n" +
    "  update - update list of available packages\n" +
    "  upgrade - upgrade the system by installing/upgrading packages\n" +
    "  full-upgrade - upgrade the system by removing/installing/upgrading packages\n" +
    "  edit-sources - edit the source information file\n" +
    "  satisfy - satisfy dependency strings\n" +
    "\n" +
    "See apt(8) for more information about the available commands.\n" +
    "Configuration options and syntax is detailed in apt.conf(5).\n" +
    "Information about how to configure sources can be found in sources.list(5).\n" +
    "Package and version choices can be expressed via apt_preferences(5).\n" +
    "Security details are available in apt-secure(8).\n" +
    "                                        This APT has Super Cow Powers.\n";

  function aptCommand(args, stdin, sh) {
    var opts = { yes: false, quiet: false };
    var words = [];
    args.forEach(function (a) {
      if (a === "-y" || a === "--yes" || a === "--assume-yes") opts.yes = true;
      else if (a === "-q" || a === "--quiet") opts.quiet = true;
      else if (a.charAt(0) !== "-") words.push(a);
    });
    var sub = words.shift();
    var wanted = words;

    if (!sub || sub === "help") {
      return { out: APT_HELP, code: 0 };
    }

    if (sub === "update") {
      return {
        async: true,
        start: function (io) {
          // Shape copied from a real `apt-get update`: Get:/Ign:/Err: blocks,
          // then the Fetched line and the three "... Done" passes.
          var lines = [
            "Get:1 http://deb.debian.org/debian trixie InRelease [140 kB]",
            "Get:2 http://deb.debian.org/debian trixie/main amd64 Packages [9,588 kB]",
            "Ign:3 http://deb.debian.org/debian trixie/main Translation-en",
            "Get:4 http://security.debian.org/debian-security trixie-security InRelease [47.1 kB]",
            "Err:5 http://deb.debian.org/debian trixie/main all c-n-f Metadata",
            "  404  Not Found [IP: 151.101.2.132 80]",
            "Fetched 9,729 kB in 2s (4,812 kB/s)",
            "Reading package lists... Done",
            "Building dependency tree... Done",
            "Reading state information... Done",
            "All packages are up to date.",
          ];
          runSteps(lines.map(function (l) { return function () { io.write(l + "\n"); }; }), io, opts.quiet ? 0 : 60);
        },
      };
    }

    if (sub === "install" || sub === "reinstall") {
      if (!wanted.length) { return { out: "E: Invalid operation install (no package given)\n", code: 100 }; }
      return { async: true, start: function (io) { aptInstall(wanted, opts, io); } };
    }
    if (sub === "remove" || sub === "purge") {
      if (!wanted.length) { return { out: "E: Invalid operation remove (no package given)\n", code: 100 }; }
      return { async: true, start: function (io) { aptRemove(wanted, opts, io); } };
    }
    if (sub === "upgrade" || sub === "full-upgrade") {
      return { async: true, start: function (io) {
        runSteps([
          function () { io.write("Reading package lists... Done\n"); },
          function () { io.write("Building dependency tree... Done\n"); },
          function () { io.write("Reading state information... Done\n"); },
          function () { io.write("Calculating upgrade... Done\n"); },
          function () { io.write("0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n"); },
        ], io, opts.quiet ? 0 : 60);
      } };
    }

    var inst = installedNames();
    if (sub === "list") {
      var upgradable = wanted.indexOf("--upgradable") >= 0;
      var wantInstalled = wanted.indexOf("--installed") >= 0;
      var out = "Listing... Done\n";
      if (upgradable) return { out: out, code: 0 };
      CATALOG.forEach(function (p) {
        var isIn = inst.indexOf(p.name) >= 0;
        if (wantInstalled && !isIn) return;
        out += isIn
          ? p.name + "/stable,now " + p.version + " " + p.arch + " [installed]\n"
          : p.name + "/stable " + p.version + " " + p.arch + "\n";
      });
      return { out: out, code: 0 };
    }
    if (sub === "search") {
      var q = (wanted[0] || "").toLowerCase();
      var res = "Sorting... Done\nFull Text Search... Done\n";
      CATALOG.filter(function (p) {
        return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.desc.toLowerCase().indexOf(q) >= 0;
      }).forEach(function (p) {
        res += p.name + "/stable " + p.version + " " + p.arch + "\n  " + p.desc + "\n\n";
      });
      return { out: res, code: 0 };
    }
    if (sub === "show" || sub === "policy") {
      var p = BY_NAME[wanted[0]];
      if (!p) return { out: "E: No packages found\n", code: 100 };
      var lines = [
        "Package: " + p.name,
        "Version: " + p.version,
        "Priority: " + (p.priority || "optional"),
        "Section: " + p.section,
        "Maintainer: " + (p.maintainer || "Emulation <emulated@linuxweb>"),
        "Architecture: " + p.arch,
        "Installed-Size: " + Math.round(p.size / 1024) + " kB",
      ];
      if (p.depends) lines.push("Depends: " + p.depends);
      if (p.suggests) lines.push("Suggests: " + p.suggests.join(", "));
      lines.push("Description: " + p.desc);
      (p.long || []).forEach(function (l) { lines.push(" " + l); });
      return { out: lines.join("\n") + "\n", code: 0 };
    }
    if (sub === "list" || sub === "cache") { /* handled above */ }
    return { out: "E: Invalid operation " + sub + "\n", code: 100 };
  }

  function dpkgCommand(args, stdin, sh) {
    var recs = records();
    if (!args.length || args[0] === "-l" || args[0] === "--list") {
      // Geometry copied from dpkg -l: name@4 w50, version@54 w41, arch@95 w13,
      // description w151 — i.e. 119-char header and 259-char rule, even on an
      // 80-column console (which is why dpkg -l output is famous for wrapping).
      function pad(s, w) { s = String(s); return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length); }
      var out = "Desired=Unknown/Install/Remove/Purge/Hold\n" +
        "| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend\n" +
        "|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)\n" +
        "||/ " + pad("Name", 50) + pad("Version", 41) + pad("Architecture", 13) + "Description\n" +
        "+++-" + "=".repeat(49) + "-" + "=".repeat(40) + "-" + "=".repeat(12) + "-" + "=".repeat(151) + "\n";
      recs.forEach(function (r) {
        out += "ii  " + pad(r.Package, 50) + pad(r.Version, 41) +
          pad(r.Architecture || "amd64", 13) + (r.desc || "") + "\n";
      });
      return { out: out, code: 0 };
    }
    if (args[0] === "-s" || args[0] === "--status") {
      var want = args[1];
      var rec = recs.filter(function (r) { return r.Package === want; })[0];
      if (!rec) return { out: "dpkg-query: no packages found matching " + want + "\n", code: 1 };
      return { out: "Package: " + rec.Package + "\nStatus: install ok installed\nVersion: " + rec.Version + "\n", code: 0 };
    }
    return { out: "dpkg: unknown option\n", code: 2 };
  }

  // ============================ wiring ==================================

  cmds.apt = function (args, stdin, sh) { return aptCommand(args, stdin, sh); };
  cmds["apt-get"] = cmds.apt;
  cmds["apt-cache"] = cmds.apt;
  cmds.dpkg = function (args, stdin, sh) { return dpkgCommand(args, stdin, sh); };

  // installed packages are re-bound to their implementations after a reload
  if (LW.VFS && LW.VFS.onLoad) {
    LW.VFS.onLoad.push(function () { ensureDirs(); bindCommands(); });
  }

  LW.APT = {
    catalog: CATALOG,
    byName: BY_NAME,
    cmds: cmds,
    installed: installedNames,
    records: records,
    bind: bindCommands,
    humanSize: humanSize,
    install: function (name) { var p = BY_NAME[name]; return p ? install(p, records()) : null; },
    remove: function (name) { var p = BY_NAME[name]; return p ? remove(p, records()) : null; },
  };
})(window.LW);
