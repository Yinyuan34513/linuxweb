// devtmpfs, emulated: /dev is not a static directory here, it is generated from
// a device registry the way the kernel's devtmpfs is.  Register a device and it
// appears in /dev, in /sys/dev/{char,block}/<maj>:<min> and in /proc/devices;
// unregister it and it is gone.  Nothing about it is written to the IDBFS.
(function (LW) {
  "use strict";

  var V = LW.VFS;

  var DEV = {
    nodes: [],
    byName: {},
    byId: {},
    onChange: null,
  };

  // ------------------------------------------------------------ registry ---
  DEV.register = function (spec) {
    var n = {
      name: spec.name,
      type: spec.type === "b" ? "b" : "c",
      major: spec.major,
      minor: spec.minor,
      mode: spec.mode !== undefined ? spec.mode : (spec.type === "b" ? "0660" : "0666"),
      owner: spec.owner || "root",
      group: spec.group || (spec.type === "b" ? "disk" : "root"),
      class: spec.class || "",
      driver: spec.driver || "",
      blocks: spec.blocks || 0,
      symlink: spec.symlink || null,
    };
    var old = DEV.byName[n.name];
    if (old) {
      if (old.id) delete DEV.byId[old.id];
      DEV.nodes[DEV.nodes.indexOf(old)] = n;
    } else {
      DEV.nodes.push(n);
    }
    n.id = n.type + " " + n.major + ":" + n.minor;
    DEV.byName[n.name] = n;
    DEV.byId[n.id] = n;
    if (DEV.onChange) DEV.onChange(n, true);
    return n;
  };

  DEV.unregister = function (name) {
    var n = DEV.byName[name];
    if (!n) return false;
    delete DEV.byName[name];
    delete DEV.byId[n.id];
    var i = DEV.nodes.indexOf(n);
    if (i >= 0) DEV.nodes.splice(i, 1);
    if (DEV.onChange) DEV.onChange(n, false);
    return true;
  };

  DEV.list = function () { return DEV.nodes.slice(); };
  DEV.filter = function (type) {
    return DEV.nodes.filter(function (n) { return n.type === type; });
  };
  DEV.get = function (name) { return DEV.byName[name] || null; };

  // how a real `ls -l` renders the node
  DEV.perms = function (n) {
    var m = String(n.mode).slice(-3);        // "0666" -> "666"
    var d = parseInt(m.charAt(0), 10), t = parseInt(m.charAt(1), 10), x = parseInt(m.charAt(2), 10);
    function rw(bits, ugo) {
      return (bits & ugo ? "r" : "-") + (bits & (ugo >> 1) ? "w" : "-") + (bits & (ugo >> 2) ? "x" : "-");
    }
    return (n.type === "b" ? "b" : "c") + rw(d, 4) + rw(t, 4) + rw(x, 4);
  };

  // ------------------------------------------------------------ the tree ---
  function nodeFor(n) {
    return {
      t: "f", dev: true, devType: n.type,
      major: n.major, minor: n.minor, class: n.class, driver: n.driver,
      get: function () {
        switch (n.class) {
          case "zero": return "\u0000".repeat(512);
          case "null": return "";
          case "random": return "\u0000".repeat(4);
          case "kmsg": return LW.stampedLog || "";
          default: return "";
        }
      },
    };
  }

  function buildDev() {
    var c = {};
    DEV.nodes.forEach(function (n) {
      if (n.name.indexOf("/") >= 0) {                 // e.g. pts/0
        var parts = n.name.split("/");
        if (!c[parts[0]]) c[parts[0]] = V.dynDir(function () { return buildDev().pts || {}; });
        return;
      }
      c[n.name] = nodeFor(n);
    });
    // the classic /dev symlinks
    c.fd = { t: "l", to: "/proc/self/fd" };
    c.stdin = { t: "l", to: "/proc/self/fd/0" };
    c.stdout = { t: "l", to: "/proc/self/fd/1" };
    c.stderr = { t: "l", to: "/proc/self/fd/2" };
    c.core = { t: "l", to: "/proc/kcore" };
    c.shm = { t: "d", c: {} };
    return c;
  }

  function buildPts() {
    var c = {};
    DEV.nodes.forEach(function (n) {
      if (n.name.indexOf("pts/") === 0) c[n.name.slice(4)] = nodeFor(n);
    });
    return c;
  }

  function buildSysDevDir(type) {
    var c = {};
    DEV.filter(type).forEach(function (n) {
      c[n.major + ":" + n.minor] = { t: "l", to: "/dev/" + n.name };
    });
    return c;
  }

  function procDevices() {
    var chars = {}, blocks = {};
    DEV.nodes.forEach(function (n) {
      var cls = n.class || String(n.major);
      if (n.type === "b") blocks[cls] = n.major;
      else chars[cls] = n.major;
    });
    var out = "Character devices:\n";
    Object.keys(chars).sort().forEach(function (k) {
      out += String(chars[k]).padStart(4) + " " + k + "\n";
    });
    out += "\nBlock devices:\n";
    Object.keys(blocks).sort().forEach(function (k) {
      out += String(blocks[k]).padStart(4) + " " + k + "\n";
    });
    return out;
  }

  function procPartitions() {
    var out = "major minor  #blocks  name\n\n";
    DEV.filter("b").forEach(function (n) {
      out += String(n.major).padStart(5) + " " + String(n.minor).padStart(7) + " " +
        String(n.blocks).padStart(9) + " " + n.name + "\n";
    });
    return out;
  }

  // ------------------------------------------------------------- mounting ---
  function mount() {
    V.mountDir("/dev", buildDev);
    V.mountDir("/dev/pts", buildPts);
    var sys = V.getNode("/sys");
    if (sys && sys.t === "d") {
      if (!sys.c.dev) sys.c.dev = V.dir({});
      sys.c.dev.c.char = V.dynDir(function () { return buildSysDevDir("c"); });
      sys.c.dev.c.block = V.dynDir(function () { return buildSysDevDir("b"); });
    }
    var proc = V.getNode("/proc");
    if (proc && proc.t === "d") {
      proc.c.devices = { t: "f", get: procDevices };
      proc.c.partitions = { t: "f", get: procPartitions };
    }
  }

  // ------------------------------------------------------------ plumbing ---
  DEV.hotplug = function (name) {
    // a device appearing on the bus (a USB stick, a new partition...)
    var presets = {
      sdb: { type: "b", major: 8, minor: 16, class: "sd", driver: "sd", blocks: 15667200 },
      "sdb1": { type: "b", major: 8, minor: 17, class: "sd", driver: "sd", blocks: 15665152 },
      sdc: { type: "b", major: 8, minor: 32, class: "sd", driver: "sd", blocks: 31260672 },
      sr0: { type: "b", major: 11, minor: 0, class: "sr", driver: "sr", blocks: 2097152 },
      "ttyUSB0": { type: "c", major: 188, minor: 0, class: "ttyUSB", driver: "usbserial" },
      "video0": { type: "c", major: 81, minor: 0, class: "video4linux", driver: "uvcvideo" },
    };
    var spec = presets[name];
    if (!spec) return null;
    spec = Object.assign({ name: name }, spec);
    return DEV.register(spec);
  };

  DEV.mknod = function (name, type, major, minor) {
    if (DEV.byName[name]) return { code: 1, msg: "mknod: " + name + ": File exists" };
    if (type !== "c" && type !== "b") return { code: 1, msg: "mknod: invalid device type '" + type + "'" };
    if (!(major >= 0) || !(minor >= 0) || major > 4095 || minor > 1048575) {
      return { code: 1, msg: "mknod: " + major + ":" + minor + ": invalid major/minor" };
    }
    DEV.register({ name: name, type: type, major: major, minor: minor, class: "misc", driver: "unknown" });
    return { code: 0 };
  };

  // --------------------------------------------------------------- seeding ---
  function seed() {
    var chars = [
      ["mem", 1, 1, "mem"], ["kmem", 1, 2, "mem"], ["null", 1, 3, "mem"],
      ["port", 1, 4, "mem"], ["zero", 1, 5, "mem"], ["full", 1, 7, "mem"],
      ["random", 1, 8, "mem"], ["urandom", 1, 9, "mem"], ["kmsg", 1, 11, "mem"],
      ["tty", 5, 0, "tty"], ["console", 5, 1, "tty"], ["ptmx", 5, 2, "tty"],
      ["tty0", 4, 0, "tty"], ["tty1", 4, 1, "tty"], ["tty2", 4, 2, "tty"],
      ["tty3", 4, 3, "tty"], ["tty4", 4, 4, "tty"], ["tty5", 4, 5, "tty"],
      ["tty6", 4, 6, "tty"], ["ttyS0", 4, 64, "ttyS"],
      ["pts/0", 136, 0, "pts"], ["pts/1", 136, 1, "pts"], ["pts/2", 136, 2, "pts"],
      ["tun", 10, 200, "misc"], ["uinput", 10, 223, "misc"], ["fuse", 10, 229, "misc"],
      ["event0", 13, 64, "input"], ["event1", 13, 65, "input"], ["mice", 13, 63, "input"],
      ["snd", 116, 1, "snd"],
    ];
    chars.forEach(function (d) {
      DEV.register({ name: d[0], type: "c", major: d[1], minor: d[2], class: d[3], driver: "" });
    });

    var blocks = [
      ["loop0", 7, 0, "loop", 65536, "0000"],
      ["loop1", 7, 1, "loop", 65536, "0000"],
      ["sda", 8, 0, "sd", 41943040, "disk"],
      ["sda1", 8, 1, "sd", 524288, "part"],
      ["sda2", 8, 2, "sd", 39845888, "part"],
      ["sda3", 8, 3, "sd", 2097152, "part"],
      ["sr0", 11, 0, "sr", 2097152, "disk"],
    ];
    blocks.forEach(function (d) {
      DEV.register({
        name: d[0], type: "b", major: d[1], minor: d[2],
        class: d[3], blocks: d[4], driver: d[3],
      });
    });
  }

  seed();
  LW.DEV = DEV;
  LW.DEV.mount = mount;
  // /dev is generated from the registry, and rebuilt after every FS reset
  if (LW.VFS && LW.VFS.onLoad) LW.VFS.onLoad.push(mount);
})(window.LW);
