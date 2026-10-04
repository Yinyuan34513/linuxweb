// Check the wasm libmagic against the real file(1), byte for byte.
//
//   node tools/verify_magic.js [corpus-dir ...]
//
// The console's `file` is only worth having if it agrees with the tool it
// emulates, so this runs the same buffers through both: the wasm build in
// assets/libmagic.js with the database in src/magicmgc.data.js, and the
// system's `file -b` (LC_ALL=C, -m pointing at the same database).  Every
// difference is printed; the exit status is the number of disagreements.
const fs = require("fs"), vm = require("vm"), path = require("path"), zlib = require("zlib");

const root = path.join(__dirname, "..");
const libmagicJs = fs.readFileSync(path.join(root, "assets/libmagic.js"), "utf8");
const mgcJs = fs.readFileSync(path.join(root, "src/magicmgc.data.js"), "utf8");

// ---- our side ---------------------------------------------------------------
const ctx = { console, TextDecoder, TextEncoder, Blob, Response, DecompressionStream,
              process, require, __dirname: __dirname, module: { exports: {} } };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(libmagicJs, ctx, { filename: "libmagic.js" });
vm.runInContext(mgcJs, ctx, { filename: "magicmgc.data.js" });
const LW = ctx.window.LW;

// The embedded database, byte for byte, so the comparison cannot drift.
function embedded() {
  const raw = Buffer.from(LW.MAGIC_MGC, "base64");
  return LW.MAGIC_MGC_ENCODING === "gzip" ? zlib.gunzipSync(raw) : raw;
}

// ---- the corpus -------------------------------------------------------------
// Real files from the system, plus buffers this filesystem can produce.
const corpus = [];
const seeds = process.argv.slice(2);
const dirs = seeds.length ? seeds : ["/bin", "/usr/lib", "/etc", "/usr/share/mime",
                                      "/usr/share/doc", "/lib", "/usr/bin"];
let count = 0;
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue;
  const stack = [dir];
  while (stack.length && count < 400) {
    const d = stack.pop();
    let names;
    try { names = fs.readdirSync(d); } catch (e) { continue; }
    for (const n of names) {
      const p = path.join(d, n);
      let st;
      try { st = fs.lstatSync(p); } catch (e) { continue; }
      if (st.isDirectory()) { if (stack.length < 40) stack.push(p); continue; }
      if (!st.isFile() || st.size === 0 || st.size > 4 * 1024 * 1024) continue;
      corpus.push(p);
      count++;
      if (count >= 400) break;
    }
  }
}

// Synthetic samples for the formats a user creates here.
const tmp = fs.mkdtempSync("/tmp/opencode/magic-");
const synthetic = {
  "ascii text": "hello world\nsecond line\n",
  "utf-8 text": "héllo wörld — ünïcode\n",
  "json": '{"name":"linuxweb","ports":[80,443]}\n',
  "csv": "a,b,c\n1,2,3\n4,5,6\n",
  "elf header": "\x7fELF\x02\x01\x01\x00" + "\0".repeat(56),
  "gzip": "\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03" + "\0".repeat(20),
  "zip": "PK\x03\x04\x14\x00\x00\x00\x00\x00",
  "png": "\x89PNG\r\n\x1a\n" + "\0".repeat(24),
  "jpeg": "\xff\xd8\xff\xe0\x00\x10JFIF\x00" + "\0".repeat(16),
  "gif": "GIF89a" + "\0".repeat(16),
  "pdf": "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n",
  "tar": "\0".repeat(257) + "ustar  \x00" + "file".padEnd(100, "\0"),
  "sqlite": "SQLite format 3\x00" + "\0".repeat(32),
  "wasm": "\x00asm\x01\x00\x00\x00",
  "random": Array.from({ length: 64 }, () => String.fromCharCode(Math.floor(Math.random() * 256))).join(""),
  "empty": "",
};
for (const [name, text] of Object.entries(synthetic)) {
  const p = path.join(tmp, name.replace(/[^a-z0-9]+/gi, "_"));
  fs.writeFileSync(p, Buffer.from(text, "latin1"));
  corpus.push(p);
}

// ---- compare ----------------------------------------------------------------
function host(path) {
  const r = require("child_process").spawnSync("file", ["-b", "-m", mgcPath, path],
                                               { encoding: "latin1" });
  if (r.error) throw r.error;
  return (r.stdout || "").trim();
}
const systemMgc = fs.realpathSync("/usr/share/misc/magic.mgc");
const mgcPath = fs.existsSync(systemMgc) ? systemMgc : path.join(tmp, "magic.mgc");
if (!fs.existsSync(systemMgc)) fs.writeFileSync(mgcPath, embedded());

ctx.createLibmagic({}).then(async (Module) => {
  Module.FS.writeFile("/magic.mgc", embedded());
  const open = Module._mg_open(0);
  if (open) { console.error("magic_open:", Module.UTF8ToString(open)); process.exit(2); }
  const err = Module.ccall("mg_load", "number", ["string"], ["/magic.mgc"]);
  if (err) { console.error("magic_load:", Module.UTF8ToString(err)); process.exit(2); }

  // Same path the page uses: the bytes go into the module's filesystem and
  // magic_file() reads them, because readelf.c needs pread().
  let seq = 0;
  const ours = (p) => {
    const bytes = fs.readFileSync(p);
    const inFs = "/corpus" + (seq++) + ".bin";
    Module.FS.writeFile(inFs, bytes);
    // file(1) reads the mode too ("setuid ELF ..."), and the module's
    // filesystem starts every file at 0644 -- so hand it the real mode.
    try { Module.FS.chmod(inFs, fs.statSync(p).mode & 0o7777); } catch (e) { /* ignore */ }
    const r = Module.UTF8ToString(Module.ccall("mg_check_file", "number", ["string"], [inFs]));
    return r.trim();
  };

  let same = 0, diff = 0;
  const shown = [];
  for (const p of corpus) {
    const a = ours(p), b = host(p);
    if (a === b) { same++; continue; }
    diff++;
    if (shown.length < 40) shown.push({ p, ours: a, host: b });
  }
  for (const d of shown) {
    console.log("DIFF " + d.p);
    console.log("  ours: " + d.ours);
    console.log("  host: " + d.host);
  }
  console.log("\n" + same + " identical, " + diff + " different, " + corpus.length + " files");
  process.exit(diff ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(2); });