// A minimal stand-in for the browser: enough of the DOM and of `window` for
// src/*.js to load in Node, plus a terminal stub the shell can write to.
// The test suites under tools/ all build on this, so the command set under
// test is loaded through exactly the same path index.html uses.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function Term() {
  this.cols = 80;
  this.rows = 25;
  this.text = "";
}
Term.prototype.write = function (s) { this.text += s; };
Term.prototype.putChar = function () {};
Term.prototype.setCursor = function () {};
Term.prototype.render = function () {};
Term.prototype.clear = function () { this.text = ""; };
Term.prototype.getRow = function () { return []; };
Term.prototype.getCol = function () { return 0; };
Term.prototype.hasContent = function () { return this.text !== ""; };
Term.prototype.isCursorVisible = function () { return true; };
Term.prototype.eraseLine = function () {};
Term.prototype.eraseDisplay = function () {};
Term.prototype.scroll = function () {};
Term.prototype.resize = function () {};

// index.html's script order.  Everything a suite needs is loaded here, so a
// new command file only has to be added once.
const DEFAULT_FILES = [
  "src/bash.data.js",
  "src/help.js",
  "src/sha256.js",
  "src/vfs.js",
  "src/devtmpfs.js",
  "src/apt.js",
  "src/bash.js",
  "src/systemd.js",
  "src/proc.js",
  "src/coreutils_help.js",
  "src/coreutils_text.js",
  "src/coreutils_file.js",
  "src/coreutils_sys.js",
  "src/coreutils_digest.js",
  "src/procps_help.js",
  "src/procps.js",
  "assets/libmagic.js",     // file(1)'s libmagic, compiled to wasm
  "src/magicmgc.data.js",
  "src/magic.js",
  "src/getty.js",
];

// Load the shell and return a handle.  `files` overrides the script list; pass
// a subset to test a command group on its own.
function loadShell(files, opts) {
  opts = opts || {};
  const dir = opts.root || path.join(__dirname, "..");
  const list = files || DEFAULT_FILES;
  const ctx = {
    __dirname: dir,
    console: opts.quiet ? { log: function () {}, warn: function () {}, error: console.error } : console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, atob, btoa,
    TextDecoder, TextEncoder, Blob, Response,
    DecompressionStream: typeof DecompressionStream !== "undefined" ? DecompressionStream : undefined,
    Uint8Array, ArrayBuffer, Buffer,
    window: {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of list) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    vm.runInContext(fs.readFileSync(p, "utf8"), ctx, { filename: f });
  }
  const LW = ctx.window.LW;
  if (!LW) throw new Error("LW was not created -- check the script list");
  // a fixed clock, so anything that prints the date is testable
  LW.clock = opts.clock || (() => "2026-10-05 09:14:03");
  LW.stampedLog = "";
  LW.plainLog = "";
  const term = new Term();
  const sh = new LW.Shell(term);
  return { LW: LW, sh: sh, ctx: ctx, term: term, Term: Term };
}

// Run one command line and return stdout with stderr appended, the way the
// shell prints them, so a test can compare both in one string.
function runLine(sh, line) {
  sh.runLine(line, false);
  return sh.lastOut;
}

module.exports = { loadShell: loadShell, runLine: runLine, Term: Term, DEFAULT_FILES: DEFAULT_FILES };