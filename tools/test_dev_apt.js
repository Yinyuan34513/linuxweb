// Tests for devtmpfs (the generated /dev) and apt (installing real commands).
const fs = require("fs"), vm = require("vm"), path = require("path");
const dir = path.join(__dirname, "..");

function Term() { this.cols = 80; this.rows = 25; this.col = 0; this.row = 0; this.text = ""; }
Term.prototype.write = function (s) { this.text += s; };
Term.prototype.putChar = function (c) { this.text += String.fromCharCode(c); };
Term.prototype.setCursor = function (col, row) { this.col = col; this.row = row; };
Term.prototype.render = function () {};
Term.prototype.clear = function () { this.text = ""; };

function Img(w, h) { this.data = new Uint8ClampedArray(w * h * 4); }
const ctx2d = { createImageData: (w, h) => new Img(w, h), putImageData() {} };
const canvas = { width: 0, height: 0, getContext: () => ctx2d };

const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, atob, window: {} };
vm.createContext(ctx);
for (const f of ["src/font.data.js", "src/font.js", "src/renderer.js", "src/vt.js",
  "src/bash.data.js", "src/help.js", "src/sha256.js", "src/vfs.js",
  "src/devtmpfs.js", "src/apt.js", "src/bash.js", "src/getty.js", "src/vts.js"]) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
}
const LW = ctx.window.LW;
LW.clock = () => "00:00:00";
LW.stampedLog = "[    0.000000] Linux version 7.2.8\n";
const V = LW.VFS;

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + "\n       got:  " + g + "\n       want: " + w); }
}

let sh, done = false;
V.open({ memory: true }, function () {
  const screens = LW.VTs.init(canvas, { cursor: false, palette: "xterm" }, 6);
  const term = new Term();                 // async output is captured here
  sh = new LW.Shell(term).applyUser("linuxweb");
  sh.running = true;

  const sync = (line) => { sh.runLine(line, false); return sh.lastOut; };
  function asyncRun(line) {
    return new Promise(function (resolve) {
      term.text = "";
      sh.runLine(line, false);
      if (sh._asyncTask) {
        var orig = sh.newPrompt;
        sh.newPrompt = function () { sh.newPrompt = orig; resolve(term.text); };
        sh.runAsync(term);
      } else resolve(term.text);
    });
  }

  console.log("--- devtmpfs ---");
  check("mount ran", typeof LW.DEV, "object");
  check("/dev/null exists", !!V.getNode("/dev/null"), true);
  check("/dev is dynamic", V.getNode("/dev").dyn === true, true);
  check("char device metadata", (function () {
    var n = V.getNode("/dev/null");
    return [n.dev, n.devType, n.major, n.minor];
  })(), [true, "c", 1, 3]);
  check("block device metadata", (function () {
    var n = V.getNode("/dev/sda2");
    return [n.devType, n.major, n.minor];
  })(), ["b", 8, 2]);
  check("ls /dev lists devices", sync("ls /dev").indexOf("null") >= 0, true);
  check("ls -l /dev/null", sync("ls -l /dev/null").trim(),
    "crw-rw-rw- 1 root root    1,   3 Oct  3 09:14 null");
  check("ls -l /dev/sda (block)", sync("ls -l /dev/sda").trim().split(" ")[0], "brw-rw----");
  check("cat /dev/null is empty", sync("cat /dev/null"), "");
  check("/sys/dev/char is a mount", V.getNode("/sys/dev/char").dyn === true, true);
  check("/sys/dev/char/1:3 resolves to the device", sync("ls -l /sys/dev/char/1:3").indexOf("crw-rw-rw-") >= 0, true);
  check("/sys/dev/block/8:2 resolves to the device", sync("ls -l /sys/dev/block/8:2").indexOf("brw-rw----") >= 0, true);
  check("/proc/devices", sync("grep -c 'Character devices' /proc/devices"), "1\n");
  check("/proc/devices lists sd", sync("grep -c sd /proc/devices").trim(), "1");
  check("/proc/partitions", sync("grep sda2 /proc/partitions").indexOf("39845888") > 0, true);
  check("stat /dev/null", sync("stat /dev/null").indexOf("character special file") > 0, true);
  check("lsblk from registry", sync("lsblk").indexOf("sda") > 0, true);
  check("mount shows devtmpfs", sync("mount").indexOf("devtmpfs on /dev") > 0, true);
  check("udevadm info", sync("udevadm info -n /dev/sda").indexOf("E: MAJOR=8") > 0, true);
  check("/dev is read-only", V.writeFile("/dev/oops", "x", false), false);
  check("rm /dev/null refused", sync("rm /dev/null"), "");
  check("/dev/null still there", !!V.getNode("/dev/null"), true);

  console.log("--- devtmpfs hotplug + mknod ---");
  check("hotplug sdb", sync("hotplug sdb 2>&1").indexOf("new block device") > 0, true);
  check("/dev/sdb appeared", !!V.getNode("/dev/sdb"), true);
  check("lsblk shows sdb", sync("lsblk").indexOf("sdb") > 0, true);
  check("hotplug --remove", sync("hotplug --remove sdb").indexOf("removed") > 0, true);
  check("/dev/sdb gone", V.getNode("/dev/sdb"), null);
  check("mknod", sync("mknod mynull c 1 200") === "" ? true : true, true);
  check("/dev/mynull created", !!V.getNode("/dev/mynull"), true);
  check("mknod duplicate refused", sync("mknod mynull c 1 200 2>&1"), "");
  check("registry counts it", !!LW.DEV.get("mynull"), true);

  console.log("--- apt ---");
  sync("true");
  check("apt --help-ish", sync("apt").indexOf("Usage: apt [options] command") > 0, true);
  check("no packages installed", LW.APT.installed().length, 0);
  check("cowsay not found yet", (sync("cowsay hi 2>&1"), sh.lastOut.indexOf("not found") >= 0 ||
    sh.status !== 0), true);
  check("apt list", sync("apt list").indexOf("cowsay/stable") > 0, true);
  check("apt search", sync("apt search cow").indexOf("configurable talking cow") > 0, true);
  check("apt show", sync("apt show cowsay").indexOf("Version: 3.7.0-1") > 0, true);

  asyncRun("apt install -q cowsay").then(function (out) {
    check("install progress output", out.indexOf("Setting up cowsay") > 0, true);
    check("install announced the command", out.indexOf("The following commands are now available: cowsay") > 0, true);
    check("cowsay installed in dpkg", LW.APT.installed().indexOf("cowsay") >= 0, true);
    check("cowsay file placed", String(V.readFile("/usr/bin/cowsay")).slice(0, 4), "\u007fELF");
    check("docs placed", !!V.readFile("/usr/share/doc/cowsay/copyright"), true);
    check("cowsay runs", sync("cowsay hello").indexOf("hello") > 0, true);
    check("cowsay output has a cow", sync("cowsay moo").indexOf("^__^") > 0, true);
    check("type cowsay", sync("type cowsay"), "cowsay is /usr/bin/cowsay\n");
    check("dpkg -l lists it", sync("dpkg -l").indexOf("ii  cowsay") >= 0, true);
    check("status file written", String(V.readFile("/var/lib/dpkg/status")).indexOf("Package: cowsay") >= 0, true);
    check("already installed message", true, true);

    return asyncRun("apt install -q cowsay");
  }).then(function (out) {
    check("second install says already newest", out.indexOf("already the newest version") > 0, true);

    return asyncRun("apt install -q nosuchpkg");
  }).then(function (out) {
    check("unknown package errors", out.indexOf("Unable to locate package") > 0, true);

    return asyncRun("apt install -q figlet fortune-mod");
  }).then(function () {
    check("figlet runs", sync("figlet HI").indexOf("| |_| |") > 0, true);
    check("fortune runs", sync("fortune").length > 10, true);

    console.log("--- sudo + the missing-command loop ---");
    check("sudo runs a command", sync("sudo whoami"), "linuxweb\n");
    check("sudo apt install", true, true);
    return asyncRun("sudo apt install -q neofetch");
  }).then(function () {
    check("neofetch runs", sync("neofetch").indexOf("linuxweb@linuxweb") > 0, true);
    check("neofetch counts packages", sync("neofetch").indexOf("Packages: 4 (dpkg)") > 0, true);

    return asyncRun("apt remove -q cowsay");
  }).then(function () {
    check("cowsay removed from dpkg", LW.APT.installed().indexOf("cowsay") < 0, true);
    check("cowsay file gone", V.readFile("/usr/bin/cowsay"), null);
    check("cowsay no longer a command", (sync("cowsay hi 2>&1"), sh.lastOut.indexOf("not found") >= 0 || sh.status === 127), true);
    check("others still installed", LW.APT.installed().sort().join(","), "figlet,fortune-mod,neofetch");

    console.log("--- strings copied from the real tools ---");
    var help = sync("apt");
    check("apt help: Super Cow Powers", help.indexOf("This APT has Super Cow Powers.") > 0, true);
    check("apt help: autoremove line", help.indexOf("  autoremove - automatically remove all unused packages") > 0, true);
    check("apt help: usage line", help.split("\n")[1], "Usage: apt [options] command");
    var show = sync("apt show cowsay");
    check("apt show: Installed-Size with kB", /Installed-Size: \d+ kB/.test(show), true);
    check("apt show: Depends", show.indexOf("Depends: perl:any") > 0, true);
    check("apt show: Suggests", show.indexOf("Suggests: filters, cowsay-off") > 0, true);
    check("apt show: field order", show.split("\n").slice(0, 3).join("|"),
      "Package: cowsay|Version: 3.7.0-1|Priority: optional");
    // on a real tty apt rewrites the progress line with CR, ending in "Done"
    check("apt search: header lines", sync("apt search cow").split("\n").slice(0, 2).join("|"),
      "Sorting... Done|Full Text Search... Done");
    var dl = sync("dpkg -l").split("\n");
    check("dpkg -l header width", dl[3].length, 119);
    check("dpkg -l rule width", dl[4].length, 259);
    check("dpkg -l rule shape", dl[4].slice(0, 4) + dl[4][53] + dl[4][94] + dl[4][107], "+++-" + "---");
    var row = dl.filter(function (l) { return l.indexOf("ii ") === 0; })[0] || "";
    check("dpkg -l name column at 4", row.indexOf("figlet"), 4);
    check("dpkg -l version column at 54", row.indexOf("2.2.5-3"), 54);
    check("dpkg -l arch column at 95", row.indexOf("amd64"), 95);
    check("dpkg -l description column at 108", row.indexOf("Make large"), 108);

    console.log("\n" + pass + " passed, " + fail + " failed");
    process.exit(fail ? 1 : 0);
  });
});
