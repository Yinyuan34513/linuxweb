// The shell's virtual filesystem.
//
// The tree lives in memory (so the shell stays synchronous) and is mirrored to
// IndexedDB one record per path, so files you create survive a page reload.
// On first run the database is seeded from the default Debian-ish tree below.
//
// Node shapes: { t:"d", c:{} } | { t:"f", d:"..." , get?:fn } | { t:"l", to:"..." }
(function (LW) {
  "use strict";

  var HOME = "/home/linuxweb";
  var USER = "linuxweb";
  var HOST = "linuxweb";
  var DB_NAME = "linuxweb-vfs";
  var DB_STORE = "nodes";

  function dir(children) { return { t: "d", c: children || {} }; }
  function file(data) { return { t: "f", d: data }; }

  // A directory whose contents are produced on demand (devtmpfs, sysfs...).
  // It is read-only and never written to the backing store.
  function dynDir(build) {
    var d = { t: "d", dyn: true, ro: true };
    Object.defineProperty(d, "c", {
      get: function () { return build(); }, configurable: true,
    });
    return d;
  }
  function lines(a) { return a.join("\n") + "\n"; }

  // ---------- default (seed) tree ----------

  function defaultTree() {
    var proc = dir({
      version: { t: "f", get: function () {
        return "Linux version 7.2.8 (build@linuxweb) (gcc (GCC) 14.2.0 20250315, GNU ld (GNU Binutils) 2.44) #1 SMP PREEMPT_DYNAMIC Thu Oct 2 21:14:07 UTC 2026\n";
      } },
      cmdline: { t: "f", get: function () {
        return "BOOT_IMAGE=/boot/vmlinuz-7.2.8 root=UUID=9f0e5c7a-3b2d-4e18-9a6f-1c2d3e4f5a6b ro console=tty0\n";
      } },
      cpuinfo: { t: "f", get: function () {
        var cpu = [
          "vendor_id\t: GenuineIntel", "cpu family\t: 6", "model\t\t: 154",
          "model name\t: 12th Gen Intel(R) Core(TM) i7-12700H", "stepping\t: 3",
          "cpu MHz\t\t: 2688.000", "cache size\t: 24576 KB",
          "flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat",
          "\t\t: pse36 clflush mmx fxsr sse sse2 ss ht syscall nx pdpe1gb rdtscp lm",
          "\t\t: constant_tsc rep_good nopl xtopology cpuid pni pclmulqdq ssse3 fma",
          "\t\t: cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c",
          "\t\t: rdrand hypervisor lahf_lm abm 3dnowprefetch fsgsbase bmi1 avx2",
        ];
        var out = [];
        for (var i = 0; i < 2; i++) {
          out.push("processor\t: " + i);
          out = out.concat(cpu); out.push("");
        }
        return out.join("\n");
      } },
      meminfo: { t: "f", get: function () {
        return lines([
          "MemTotal:        2032604 kB", "MemFree:         1452336 kB",
          "MemAvailable:    1729108 kB", "Buffers:           41228 kB",
          "Cached:           402116 kB", "SwapCached:            0 kB",
          "SwapTotal:             0 kB", "SwapFree:              0 kB",
          "Dirty:               232 kB", "Writeback:             0 kB",
          "Shmem:             18896 kB", "Slab:              92144 kB",
          "SReclaimable:      46072 kB", "SUnreclaim:        46072 kB",
        ]);
      } },
      uptime: { t: "f", get: function () { return "912.44 3661.02\n"; } },
      loadavg: { t: "f", get: function () { return "0.00 0.01 0.00 1/168 1042\n"; } },
      mounts: { t: "f", get: function () { return mountsText(); } },
      filesystems: { t: "f", get: function () {
        return lines(["nodev\tsysfs", "nodev\tproc", "nodev\ttmpfs", "nodev\tdevtmpfs",
          "\text4", "\tvfat", "nodev\tnfs", "nodev\tcgroup2"]);
      } },
    });

    return dir({
      bin: { t: "l", to: "/usr/bin" },
      sbin: { t: "l", to: "/usr/sbin" },
      lib: { t: "l", to: "/usr/lib" },
      lib64: { t: "l", to: "/usr/lib64" },
      boot: dir({
        "vmlinuz-7.2.8": file("<binary>\n"),
        "initrd.img-7.2.8": file("<binary>\n"),
        "config-7.2.8": file(lines([
          "#", "# Automatically generated file; DO NOT EDIT.",
          "# Linux/x86 7.2.8 Kernel Configuration", "#",
          "CONFIG_64BIT=y", "CONFIG_SMP=y", "CONFIG_NR_CPUS=8192",
          "CONFIG_PREEMPT_DYNAMIC=y", "CONFIG_EXT4_FS=y", "CONFIG_E1000=y",
        ])),
      }),
      dev: dir({
        null: file(""), zero: file(""), tty: file(""), console: file(""),
        tty0: file(""), tty1: file(""), sda: file(""), sda1: file(""),
        random: file(""), urandom: file(""), stdin: file(""), stdout: file(""),
        stderr: file(""), pts: dir({ "0": file(""), "1": file("") }),
      }),
      etc: dir({
        hostname: file(HOST + "\n"),
        "os-release": file(lines([
          'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"',
          'NAME="Debian GNU/Linux"', 'VERSION_ID="13"',
          'VERSION="13 (trixie)"', 'VERSION_CODENAME=trixie', "ID=debian",
          'HOME_URL="https://www.debian.org/"',
          'SUPPORT_URL="https://www.debian.org/support"',
          'BUG_REPORT_URL="https://bugs.debian.org/"',
        ])),
        debian_version: file("trixie/sid\n"),
        passwd: file(lines([
          "root:x:0:0:root:/root:/bin/bash",
          "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
          "bin:x:2:2:bin:/bin:/usr/sbin/nologin",
          "sys:x:3:3:sys:/dev:/usr/sbin/nologin",
          "sync:x:4:65534:sync:/bin:/bin/sync",
          "linuxweb:x:1000:1000:linuxweb,,,:/home/linuxweb:/bin/bash",
        ])),
        shadow: file(lines([
          "root:$sha256$root$0242c0436daa4c241ca8a793764b7dfb50c223121bb844cf49be670a3af4dd18:20300:0:99999:7:::",
          "daemon:*:20300:0:99999:7:::",
          "bin:*:20300:0:99999:7:::",
          "sys:*:20300:0:99999:7:::",
          "sync:*:20300:0:99999:7:::",
          "linuxweb:$sha256$linuxweb$181e95d0a42855bc2196f21b072655a998d9f4bb2f73f94a3d2ae3e55f095c79:20300:0:99999:7:::",
        ])),
        group: file(lines([
          "root:x:0:", "daemon:x:1:", "bin:x:2:", "sys:x:3:",
          "sudo:x:27:linuxweb", "linuxweb:x:1000:",
        ])),
        hosts: file(lines([
          "127.0.0.1\tlocalhost", "127.0.1.1\t" + HOST, "",
          "::1\tlocalhost ip6-localhost ip6-loopback",
          "ff02::1\tip6-allnodes", "ff02::2\tip6-allrouters",
        ])),
        fstab: file(lines([
          "# <file system> <mount point>   <type>  <options>       <dump>  <pass>",
          "UUID=9f0e5c7a-3b2d-4e18-9a6f-1c2d3e4f5a6b /     ext4    errors=remount-ro 0  1",
          "UUID=1A2B-3C4D                            /boot/efi vfat umask=0077     0  1",
          "/dev/sda3                                 none      swap  sw            0  0",
        ])),
        "resolv.conf": file(lines([
          "# Generated by NetworkManager", "nameserver 192.168.1.1", "nameserver 9.9.9.9",
        ])),
        "bash.bashrc": file(lines([
          "# System-wide .bashrc file for interactive bash(1) shells.",
          "if ! shopt -oq posix; then",
          "  if [ -f /usr/share/bash-completion/bash_completion ]; then",
          "    . /usr/share/bash-completion/bash_completion",
          "  fi",
          "fi", "", "PS1='\\u@\\h:\\w\\$ '",
        ])),
        profile: file(lines([
          "# /etc/profile: system-wide .profile file for the Bourne shell",
          'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
        ])),
        issue: file("Debian GNU/Linux 13 \\n \\l\n\n"),
        motd: file(lines([
          "The programs included with the Debian GNU/Linux system are free software;",
          "the exact distribution terms for each program are described in the",
          "individual files in /usr/share/doc/*/copyright.", "",
          "Debian GNU/Linux comes with ABSOLUTELY NO WARRANTY, to the extent",
          "permitted by applicable law.",
        ])),
        "machine-id": file("b1f3d4e2a8c94f6d90e7c5a2b3d81f47\n"),
      }),
      home: dir({
        linuxweb: dir({
          ".bashrc": file(lines([
            "# ~/.bashrc: executed by bash(1) for non-login shells.",
            "case $- in", "    *i*) ;;", "      *) return;;", "esac", "",
            "alias ll='ls -alF'", "alias la='ls -A'", "alias l='ls -CF'",
            "alias grep='grep --color=auto'",
          ])),
          ".profile": file(lines([
            "# ~/.profile: executed by the command interpreter for login shells.",
            'if [ -d "$HOME/bin" ] ; then', '    PATH="$HOME/bin:$PATH"', "fi",
          ])),
          ".bash_history": file(lines(["ls -la", "cat /etc/os-release", "uname -a", "dmesg | tail", "free -h"])),
          "notes.txt": file(lines([
            "linuxweb - a web page that pretends to be Linux.", "",
            "Real:    the VGA 8x16 font (Linux 7.2.8), the boot log anchors,",
            "         and this filesystem, which really does persist in IndexedDB.",
            "Fake:    everything else, including this shell.",
          ])),
          Documents: dir({ "todo.md": file(lines(["# TODO", "", "- [x] kernel boot log", "- [x] bash", "- [ ] fool everyone"])) }),
          Pictures: dir({}),
          Downloads: dir({}),
        }),
      }),
      proc: proc,
      root: dir({ ".bashrc": file("# ~/.bashrc\n") }),
      run: dir({}), sbin: dir({}), srv: dir({}), sys: dir({}), tmp: dir({}),
      usr: dir({
        bin: dir({}), lib: dir({}), sbin: dir({}),
        share: dir({ doc: dir({}) }),
        local: dir({ bin: dir({}), lib: dir({}) }),
      }),
      var: dir({
        log: dir({
          syslog: file(lines([
            "Oct  3 09:14:02 linuxweb systemd[1]: Started Journal Service.",
            "Oct  3 09:14:02 linuxweb sshd[812]: Server listening on 0.0.0.0 port 22.",
            "Oct  3 09:14:03 linuxweb cron[844]: (CRON) INFO (pidfile fd = 3)",
            "Oct  3 09:14:03 linuxweb login[901]: pam_unix(login:session): session opened for user linuxweb",
          ])),
          "auth.log": file(lines([
            "Oct  3 09:14:03 linuxweb login[901]: pam_unix(login:session): session opened for user linuxweb(uid=1000)",
          ])),
        }),
        tmp: dir({}), run: dir({}), lib: dir({}),
        spool: dir({ cron: dir({ crontabs: dir({}) }) }),
      }),
    });
  }

  function mountsText() {
    return lines([
      "sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0",
      "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0",
      "udev /dev devtmpfs rw,nosuid,relatime,size=1009540k,nr_inodes=252385,mode=755 0 0",
      "devpts /dev/pts devpts rw,nosuid,noexec,relatime,gid=5,mode=620,ptmxmode=000 0 0",
      "tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime,size=204276k,mode=755 0 0",
      "/dev/sda2 / ext4 rw,relatime,errors=remount-ro 0 0",
      "tmpfs /tmp tmpfs rw,nosuid,nodev,relatime 0 0",
      "tmpfs /run/user/1000 tmpfs rw,nosuid,nodev,relatime,size=204276k,mode=700,uid=1000,gid=1000 0 0",
    ]);
  }

  // ---------- in-memory operations ----------

  var root = defaultTree();

  function norm(path, cwd) {
    var p = String(path);
    if (p.charAt(0) !== "/") p = (cwd || "/") + "/" + p;
    var parts = p.split("/"), out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (seg === "" || seg === ".") continue;
      if (seg === "..") out.pop(); else out.push(seg);
    }
    return "/" + out.join("/");
  }

  function parentOf(p) { var i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); }
  function baseName(p) { var i = p.lastIndexOf("/"); return p.slice(i + 1); }

  function getNode(path, depth) {
    if (path === "/") return root;
    var parts = path.split("/").slice(1);
    var n = root;
    for (var i = 0; i < parts.length; i++) {
      if (!n || n.t !== "d") return null;
      n = n.c[parts[i]];
      if (!n) return null;
      if (n.t === "l") {
        if (depth > 8) return null;
        n = getNode(norm(n.to, "/"), (depth || 0) + 1);
      }
    }
    return n || null;
  }

  function isDir(path) { var n = getNode(path); return !!n && n.t === "d"; }

  function readFile(path) {
    var n = getNode(path);
    if (!n || n.t !== "f") return null;
    return n.get ? n.get() : (n.d || "");
  }

  function lsDir(path) {
    var n = getNode(path);
    if (!n || n.t !== "d") return null;
    return Object.keys(n.c).sort();
  }

  function writeFile(path, data, append) {
    var par = getNode(parentOf(path));
    if (!par || par.t !== "d") return false;
    if (par.ro) return false;                      // e.g. /dev, /sys
    var name = baseName(path), old = par.c[name];
    if (old && old.t === "d") return false;
    par.c[name] = file(append && old && old.t === "f" ? (old.d || "") + data : data);
    persist(path);
    return true;
  }

  function mkdirp(path) {
    var parts = path.split("/").filter(Boolean), cur = "";
    for (var i = 0; i < parts.length; i++) {
      cur += "/" + parts[i];
      if (!getNode(cur)) {
        var par = getNode(parentOf(cur));
        if (!par || par.t !== "d") return false;
        par.c[parts[i]] = dir({});
      }
    }
    persistTree(path);
    return true;
  }

  function unlink(path) {
    var par = getNode(parentOf(path));
    var nm = baseName(path);
    if (!par || par.t !== "d" || !par.c[nm]) return false;
    if (par.ro) return false;                      // e.g. /dev, /sys
    var doomed = collectPaths(par.c[nm], path, []);
    delete par.c[nm];
    doomed.forEach(function (p) { enqueue(p, null); });
    return true;
  }

  // ---------- globbing ----------

  function globToRe(pat) {
    var re = "^";
    for (var i = 0; i < pat.length; i++) {
      var ch = pat.charAt(i);
      if (ch === "*") re += "[^/]*";
      else if (ch === "?") re += "[^/]";
      else if (ch === "[") {
        var j = pat.indexOf("]", i + 1);
        if (j < 0) re += "\\[";
        else { re += "[" + pat.slice(i + 1, j).replace(/\\/g, "\\\\") + "]"; i = j; }
      } else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
    return new RegExp(re + "$");
  }

  function glob(pattern, cwd) {
    var p = norm(pattern, cwd);
    var parts = p.split("/").slice(1);
    var results = [];
    (function walk(node, prefix, i) {
      if (i >= parts.length) { results.push(prefix || "/"); return; }
      if (!node || node.t !== "d") return;
      var re = globToRe(parts[i]);
      Object.keys(node.c).forEach(function (name) {
        if (re.test(name)) walk(node.c[name], prefix + "/" + name, i + 1);
      });
    })(root, "", 0);
    return results;
  }

  // ---------- IDBFS: the IndexedDB-backed filesystem ----------
  //
  // One record per path.  Writes are queued and flushed in a single
  // transaction (debounced), and `syncfs` gives an explicit flush + reload,
  // so the tree survives reloads while commands stay synchronous.

  var db = null;
  var dbReady = false;
  var autoPersist = true;
  var pending = {};        // path -> record | null (delete)
  var flushTimer = null;
  var dbError = null;

  function record(node, path) {
    if (node.dyn) return null;                     // dynamic mount, never persisted
    if (node.t === "f" && node.get) return null;   // generated, never persisted
    return { path: path, t: node.t, d: node.d, to: node.to };
  }

  function collectPaths(node, path, out) {
    if (node.dyn) return out;
    out.push(path);
    if (node.t === "d") {
      Object.keys(node.c).forEach(function (k) {
        collectPaths(node.c[k], path === "/" ? "/" + k : path + "/" + k, out);
      });
    }
    return out;
  }

  function tx(mode) { return db.transaction([DB_STORE], mode).objectStore(DB_STORE); }

  function enqueue(path, rec) {
    pending[path] = rec;
    if (!autoPersist || flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; flush(null); }, 200);
  }

  function enqueueTree(node, path) {
    collectPaths(node, path, []).forEach(function (p) {
      var n = getNode(p);
      var r = n ? record(n, p) : null;
      if (r !== null) pending[p] = r; else delete pending[p];
    });
    if (autoPersist && !flushTimer) {
      flushTimer = setTimeout(function () { flushTimer = null; flush(null); }, 200);
    }
  }

  function requeue(batch) {
    Object.keys(batch).forEach(function (p) {
      if (pending[p] === undefined) pending[p] = batch[p];
    });
  }

  function flush(cb) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!db) { if (cb) cb(false); return false; }
    var paths = Object.keys(pending);
    if (!paths.length) { if (cb) cb(true); return true; }
    var batch = pending;
    pending = {};
    try {
      var os = tx("readwrite");
      paths.forEach(function (p) {
        if (batch[p]) os.put(batch[p]); else os.delete(p);
      });
      os.transaction.oncomplete = function () { if (cb) cb(true); };
      os.transaction.onabort = function (e) { dbError = e; requeue(batch); if (cb) cb(false); };
      os.transaction.onerror = function (e) { dbError = e; requeue(batch); if (cb) cb(false); };
    } catch (e) {
      dbError = e; requeue(batch); if (cb) cb(false); return false;
    }
    return true;
  }

  function persist(path) {
    var n = getNode(path);
    enqueue(path, n ? record(n, path) : null);
  }

  function persistTree(path) {
    var n = getNode(path);
    if (!n) { enqueue(path, null); return; }
    enqueueTree(n, path);
  }

  function deleteTree(path) {
    var n = getNode(path);
    if (n) collectPaths(n, path, []).forEach(function (p) { enqueue(p, null); });
    else enqueue(path, null);
  }

  function buildFromRecords(records) {
    var r = dir({});
    records.sort(function (a, b) { return a.path.length - b.path.length; });
    records.forEach(function (rec) {
      var parts = rec.path.split("/").filter(Boolean);
      var n = r;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!n.c[parts[i]]) n.c[parts[i]] = dir({});
        n = n.c[parts[i]];
      }
      var leaf = parts[parts.length - 1];
      if (!leaf) return;
      if (rec.t === "d") n.c[leaf] = dir({});
      else if (rec.t === "l") n.c[leaf] = { t: "l", to: rec.to };
      else n.c[leaf] = file(rec.d || "");
    });
    return r;
  }

  function readAll(cb) {
    var req;
    try { req = tx("readonly").getAll(); } catch (e) { cb(null); return; }
    req.onsuccess = function () { cb(req.result || []); };
    req.onerror = function () { cb(null); };
  }

  // Add any default file that is missing from the loaded tree -- e.g. a store
  // seeded by an older version of this page.  Additive only: never overwrites
  // anything already present.
  function mergeDefaults() {
    var fresh = defaultTree();
    var added = 0;
    (function walk(fnode, path) {
      if (fnode.t === "d") {
        if (path !== "/" && !isDir(path)) { mkdirp(path); added++; }
        Object.keys(fnode.c).forEach(function (k) {
          walk(fnode.c[k], path === "/" ? "/" + k : path + "/" + k);
        });
        return;
      }
      if (fnode.get) return;                       // generated /proc content
      if (getNode(path)) return;                   // already there
      var par = getNode(parentOf(path));
      if (!par || par.t !== "d") return;
      var name = baseName(path);
      par.c[name] = fnode.t === "l" ? { t: "l", to: fnode.to } : file(fnode.d);
      enqueue(path, record(par.c[name], path));
      added++;
    })(fresh, "/");
    return added;
  }

  function loadInto(cb) {
    readAll(function (recs) {
      if (recs && recs.length) {
        root = buildFromRecords(recs);
        root.c.proc = defaultTree().c.proc;   // generated, not stored
        if (mergeDefaults()) flush(null);
      } else {
        root = defaultTree();
        enqueueTree(root, "/");
        flush(null);
      }
      runHooks();
      cb(true);
    });
  }

  // Dynamic mounts (devtmpfs, apt bindings) rebuild themselves after every load.
  function runHooks() {
    LW.VFS.onLoad.forEach(function (h) { try { h(); } catch (e) { /* keep booting */ } });
  }

  function open(opts, cb) {
    opts = opts || {};
    if (opts.memory || typeof indexedDB === "undefined") {
      dbReady = true;
      runHooks();
      if (cb) cb(false);
      return;
    }
    var req;
    try { req = indexedDB.open(DB_NAME, 1); }
    catch (e) { dbReady = true; runHooks(); if (cb) cb(false); return; }
    req.onupgradeneeded = function () {
      var d = req.result;
      if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE, { keyPath: "path" });
    };
    req.onerror = function (e) { dbError = e; dbReady = true; runHooks(); if (cb) cb(false); };
    req.onsuccess = function () {
      db = req.result;
      db.onversionchange = function () { db.close(); db = null; };
      if (opts.reset) {
        var os;
        try { os = tx("readwrite"); }
        catch (e) { dbReady = true; if (cb) cb(false); return; }
        var clear = os.clear();
        clear.onsuccess = function () { pending = {}; loadInto(function () { dbReady = true; if (cb) cb(true); }); };
        clear.onerror = function () { dbReady = true; if (cb) cb(false); };
        return;
      }
      loadInto(function () { dbReady = true; if (cb) cb(true); });
    };
  }

  function reset(cb) { pending = {}; open({ reset: true }, cb); }

  // Replace the subtree at `path` with a dynamic one (idempotent).
  function mountDir(path, build) {
    var p = norm(path, "/");
    var par = getNode(parentOf(p));
    if (!par || par.t !== "d") return false;
    par.c[baseName(p)] = dynDir(build);
    return true;
  }

  // Explicit flush, optionally re-populating the tree from the store
  // (the IDBFS syncfs(populate, callback) contract).
  function syncfs(populate, cb) {
    flush(function (ok) {
      if (!populate) { cb(ok); return; }
      loadInto(function () { cb(ok); });
    });
  }

  function stats() {
    var bytes = 0, files = 0, dirs = 0;
    (function walk(path) {
      var n = getNode(path);
      if (!n) return;
      if (n.t === "d") {
        dirs++;
        Object.keys(n.c).forEach(function (k) { walk(path === "/" ? "/" + k : path + "/" + k); });
      } else {
        files++;
        bytes += (n.get ? 0 : (n.d || "").length);
      }
    })("/");
    return {
      open: !!db, ready: dbReady, mounted: !!db,
      files: files, dirs: dirs, records: files + dirs,
      bytes: bytes, pending: Object.keys(pending).length,
      autoPersist: autoPersist, error: dbError ? String(dbError) : null,
    };
  }

  LW.VFS = {
    HOME: HOME, USER: USER, HOST: HOST,
    open: open, reset: reset, syncfs: syncfs, flush: flush, stats: stats,
    isReady: function () { return dbReady; },
    hasDB: function () { return !!db; },
    setAutoPersist: function (on) { autoPersist = !!on; return autoPersist; },
    getRoot: function () { return root; },
    dir: dir, file: file,
    norm: norm, parentOf: parentOf, baseName: baseName,
    getNode: getNode, isDir: isDir, readFile: readFile, lsDir: lsDir,
    writeFile: writeFile, mkdirp: mkdirp, unlink: unlink,
    dynDir: dynDir, mountDir: mountDir, onLoad: [],
    persist: persist, persistTree: persistTree, deleteTree: deleteTree,
    glob: glob, globToRe: globToRe,
    mountsText: mountsText,
    _buildFromRecords: buildFromRecords,
  };
})(window.LW);
