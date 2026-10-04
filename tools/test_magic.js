// `file` is backed by the wasm libmagic in assets/libmagic.js, so this suite
// runs it the way the shell does: through the async task path (libmagic is
// instantiated on a promise, so the assertions await it).
const fs = require("fs"), vm = require("vm"), path = require("path");

function Term() {
  this.cols = 80; this.rows = 25; this.text = "";
}
Term.prototype.write = function (s) { this.text += s; };
Term.prototype.putChar = function (c) {};
Term.prototype.setCursor = function () {};
Term.prototype.render = function () {};
Term.prototype.clear = function () { this.text = ""; };

const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval,
              Date, atob, Blob, Response, DecompressionStream, window: {} };
vm.createContext(ctx);
const dir = path.join(__dirname, "..");
for (const f of ["src/bash.data.js", "src/help.js", "src/vfs.js", "src/devtmpfs.js",
                 "src/coreutils_help.js", "assets/libmagic.js",
                 "src/magicmgc.data.js", "src/bash.js", "src/magic.js"]) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
}
const LW = ctx.window.LW;
LW.clock = () => "09:14:03";
LW.stampedLog = "";
LW.plainLog = "";

const term = new Term();
const sh = new LW.Shell(term);

let pass = 0, fail = 0;
function sync(line) { sh.runLine(line, false); return sh.lastOut; }
async function asyncRun(line) {
  sh.runLine(line, false);
  if (!sh._asyncTask) return sh.lastOut;
  const out = [];
  let done;
  const finished = new Promise((r) => { done = r; });
  sh.busy = true;
  sh._asyncIO = null;
  const task = sh._asyncTask;
  sh._asyncTask = null;
  const io = {
    term, aborted: false,
    write: function (s) { out.push(s); term.write(s); },
    done: function (code) {
      sh.status = code === undefined ? 0 : code;
      sh.busy = false; sh._asyncIO = null;
      done();
    },
  };
  sh._asyncIO = io;
  task(io);
  await finished;
  return out.join("");
}
function check(name, got, want) {
  const ok = typeof want === "function" ? want(got) : got === want;
  if (ok) { pass++; console.log("  ok   " + name); }
  else {
    fail++;
    console.log("  FAIL " + name + "\n       got:  " + JSON.stringify(got) +
                "\n      want:  " + JSON.stringify(want));
  }
}

LW.VFS.open({ reset: true }, async function () {
  await LW.magic.ready;
  console.log("--- libmagic through the shell ---");
  check("ASCII text", await asyncRun("file /etc/hostname"), "/etc/hostname: ASCII text\n");
  check("brief", await asyncRun("file -b /etc/hostname"), "ASCII text\n");
  check("directory", await asyncRun("file /etc"), "/etc: directory\n");
  check("char device", await asyncRun("file /dev/null"), "/dev/null: character special (1/3)\n");
  check("block device", await asyncRun("file /dev/sda"), "/dev/sda: block special (8/0)\n");
  check("symlink", await asyncRun("file /bin"), (o) => /^\/bin: symbolic link to \/usr\/bin\n$/.test(o));
  check("symlink dereferenced", await asyncRun("ln -sf /etc/hostname /tmp/l; file -L /tmp/l"),
        (o) => /ASCII text/.test(o));
  check("no operand prints usage", sync("file 2>&1"), (o) => o.indexOf("Usage: file") === 0);
  check("missing file -> stderr", await asyncRun("file /nope 2>&1"),
        "/nope: cannot open `/nope' (No such file or directory)\n");
  check("missing file, unmerged, is silent on stdout", sync("file /nope"), "");
  check("missing file status is 0", sync("file /nope >/dev/null 2>&1; echo $?"), "0\n");
  // file aligns the description column to the widest name, and (like the real
  // one, whose stderr is unbuffered) reports what it could not open first.
  check("name column is padded", await asyncRun("file /etc/hostname /nope 2>&1"),
        "/nope:         cannot open `/nope' (No such file or directory)\n" +
        "/etc/hostname: ASCII text\n");

  await asyncRun("printf '\\177ELF\\002\\001\\001' > /tmp/e");
  check("elf", await asyncRun("file /tmp/e"), (o) => /ELF/.test(o));
  await asyncRun("printf '\\037\\213\\010\\000\\000\\000\\000\\000\\000\\003' > /tmp/g");
  check("gzip", await asyncRun("file /tmp/g"), (o) => /gzip compressed data/.test(o));
  // An 8-byte PNG signature is "data" to the real file too -- the magic rule
  // needs the IHDR chunk, so that is what we compare against.
  await asyncRun("printf '\\211PNG\\r\\n\\032\\n' > /tmp/p");
  check("png signature alone is data", await asyncRun("file /tmp/p"), "/tmp/p: data\n");
  await asyncRun("printf '{\"a\":1}\\n' > /tmp/j");
  check("json", await asyncRun("file /tmp/j"), (o) => /JSON text data/.test(o));
  check("mime type", await asyncRun("file -I /tmp/j"),
        (o) => /application\/json|application\/x-json|text\/json/.test(o));
  // A real PNG: the magic rule needs the IHDR chunk, not just the signature.
  await asyncRun("printf '\\211PNG\\r\\n\\032\\n\\0\\0\\0\\rIHDR\\0\\0\\0\\1\\0\\0\\0\\1\\10\\2\\0\\0\\0\\211\\115\\65\\240\\74\\203B\\0\\0\\0\\0IEND\\256B\\140\\202' > /tmp/real.png");
  check("png with IHDR", await asyncRun("file /tmp/real.png"),
        (o) => /PNG image data, 1 x 1, 8-bit\/color RGB, non-interlaced/.test(o));
  await asyncRun("true > /tmp/z");
  check("empty file", await asyncRun("file /tmp/z"), "/tmp/z: empty\n");
  check("keeps going", await asyncRun("file /etc/hostname /nope /etc 2>&1"),
        "/nope:         cannot open `/nope' (No such file or directory)\n" +
        "/etc/hostname: ASCII text\n" +
        "/etc:          directory\n");

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
});