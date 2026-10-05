// Load every script index.html loads, in the page's own order, in a vm, and
// then run the commands that report on the system.  A mistake in the load
// order -- a file that needs something another file defines later -- or a
// missing <script> line shows up here instead of in a browser console.
//
//   node tools/test_pageload.js
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const dir = path.join(__dirname, "..");
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ok   " + name); return; }
  fail++;
  console.log("  FAIL " + name + (detail ? "\n       " + detail : ""));
}

console.log("--- the page's script list ---");
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const files = [];
const re = /<script src="([^"]+)"><\/script>/g;
let m;
while ((m = re.exec(html)) !== null) files.push(m[1]);
for (const f of files) {
  check(f + " is on disk", fs.existsSync(path.join(dir, f)));
}
// the unit table has to exist before the commands that report on it
check("systemd.js loads before coreutils_sys.js",
  files.indexOf("src/systemd.js") >= 0 &&
  files.indexOf("src/systemd.js") < files.indexOf("src/coreutils_sys.js"),
  "order: " + files.join(" "));

console.log("--- every script runs ---");
// Enough of a browser for the sources: they need window, and the renderer needs
// a canvas.  The timers are inert so the boot replay does not run away here.
const noop = function () { return 0; };
const context2d = {
  createImageData: function (w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
  putImageData: noop, getImageData: function () { return { data: new Uint8ClampedArray(4) }; },
  clearRect: noop, fillRect: noop, drawImage: noop, save: noop, restore: noop,
  translate: noop, scale: noop, beginPath: noop, closePath: noop, moveTo: noop,
  lineTo: noop, fill: noop, stroke: noop, fillText: noop, strokeText: noop,
  measureText: function () { return { width: 8 }; },
  setTransform: noop, getContextAttributes: function () { return {}; },
  set imageData(v) {}, get imageData() { return null; },
};
function element() {
  return {
    width: 720, height: 400, style: {}, appendChild: noop, removeChild: noop,
    getContext: function () { return context2d; }, addEventListener: noop,
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 720, height: 400 }; },
    classList: { add: noop, remove: noop, toggle: noop, contains: function () { return false; } },
    setAttribute: noop, focus: noop, blur: noop, insertBefore: noop,
    firstChild: null, children: [], childNodes: [],
  };
}
const ctx = {
  console: console,
  setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  Date: Date, Math: Math, JSON: JSON, atob: atob, btoa: btoa,
  Blob: typeof Blob !== "undefined" ? Blob : undefined,
  Response: typeof Response !== "undefined" ? Response : undefined,
  DecompressionStream: typeof DecompressionStream !== "undefined" ? DecompressionStream : undefined,
  TextDecoder: typeof TextDecoder !== "undefined" ? TextDecoder : undefined,
  Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray, ArrayBuffer: ArrayBuffer,
  DataView: DataView, Promise: Promise, RegExp: RegExp, Error: Error, TypeError: TypeError,
  document: {
    getElementById: function () { return element(); },
    createElement: function () { return element(); },
    body: element(), addEventListener: noop, removeEventListener: noop,
    fonts: { load: function () { return Promise.resolve([]); }, ready: Promise.resolve() },
  },
  location: { search: "?minDelay=0&timeScale=100000", href: "http://localhost/index.html",
              hash: "", reload: noop, pathname: "/index.html" },
  navigator: { userAgent: "test", language: "en-GB", languages: ["en-GB"], platform: "Linux x86_64" },
  addEventListener: noop, removeEventListener: noop,
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  performance: { now: function () { return 0; } },
  indexedDB: undefined, IDBKeyRange: undefined,
};
ctx.window = ctx;
ctx.self = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

let threw = 0;
for (const f of files) {
  const code = fs.readFileSync(path.join(dir, f), "utf8");
  try {
    vm.runInContext(code, ctx, { filename: f });
  } catch (e) {
    threw++;
    console.log("  FAIL " + f + " threw: " + e.message);
    console.log("       " + String(e.stack || "").split("\n").slice(1, 4).join("\n       "));
  }
}
check("no script threw while loading", threw === 0, threw + " file(s) threw");

console.log("--- the commands that read the unit table ---");
const LW = ctx.window.LW;
if (!LW || !LW.Shell) {
  check("LW.Shell exists", false);
} else {
  function Term() { this.cols = 80; this.rows = 25; this.col = 0; this.row = 0; this.text = ""; this.vt = 1; }
  Term.prototype.write = function (s) { this.text += s; };
  Term.prototype.putChar = function () {}; Term.prototype.setCursor = function () {};
  Term.prototype.render = function () {}; Term.prototype.clear = function () { this.text = ""; };

  const sh = new LW.Shell(new Term());
  const when = Date.UTC(2026, 9, 5, 9, 14, 3);
  LW.now = function () { return new Date(when); };
  LW.bootTime = function () { return new Date(when - 3000); };
  LW.uptime = function () { return 3; };
  LW.stampedLog = "[    0.000000] Linux version 7.2.8\n[    1.000000] Run /sbin/init as init process\n";

  check("LW.systemd is defined", !!LW.systemd);
  function run(cmd) {
    sh.term.text = ""; sh.lastOut = "";
    try { sh.runLine(cmd, false); return { out: sh.lastOut, err: sh.term.text }; }
    catch (e) { return { out: "", err: "THREW: " + e.message + "\n" + e.stack }; }
  }
  check("systemctl list-units", /UNIT +LOAD +ACTIVE +SUB +DESCRIPTION/.test(run("systemctl list-units").out));
  check("systemctl status ssh", /ssh\.service - OpenBSD Secure Shell server/.test(run("systemctl status ssh").out));
  check("journalctl -n 3", /linuxweb \S+(\[\d+\])?: /.test(run("journalctl -n 3").out));
  check("dmesg", /^\[    0\.000000\] Linux version/m.test(run("dmesg").out));
  check("dmesg -H", /^\[Oct  5 09:14\] /m.test(run("dmesg -H").out));
  check("the unit files are on disk", /ssh\.service/.test(run("ls /lib/systemd/system").out));
  check("systemctl cat ssh agrees with cat",
    run("systemctl cat ssh").out.replace(/^# .*\n/, "") === run("cat /lib/systemd/system/ssh.service").out);
  check("no command reports an error", run("systemctl status nginx").err === "",
    JSON.stringify(run("systemctl status nginx").err));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);