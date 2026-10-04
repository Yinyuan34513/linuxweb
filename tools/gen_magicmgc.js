// Compile a magic.mgc with the wasm libmagic we just built.
//
//   node tools/gen_magicmgc.js <libmagic.js> <file-source-dir> [out.js] [sets]
//
// The database is versioned, so it has to be produced by the very library
// that will read it: this loads assets/libmagic.js, feeds it the curated
// Magdir fragments, calls magic_compile() and copies the resulting
// <name>.mgc out of the module's filesystem as a base64 JS table.
const fs = require("fs"), path = require("path"), vm = require("vm");

const MAGIC_CHECK = 0x0000400;   // src/file.h
const wasmJs = process.argv[2] || "assets/libmagic.js";
const srcDir = process.argv[3] || "file";
const outJs = process.argv[4] || "src/magicmgc.data.js";

// What to compile:
//
//   node tools/gen_magicmgc.js <libmagic.js> <src> [out.js] [sets]
//
//   <src> a file        -> that file verbatim (our own data/magic)
//   <src> a directory   -> file(1)'s own tree; [sets] picks the Magdir
//                          fragments, or "all" for the complete database
//
// "all" is file(1)'s own magic: ~1.5 MB of Magdir fragments that compile to a
// 10.8 MB magic.mgc.  "sets" (the default) is the curated subset -- see
// data/magic for why the full database is not what a web page wants.
const SETS_ARG = process.argv[5] || "images,jpeg,pdf,zip,archive,elf,msdos,rtf,audio,sgml,animation";

// The magic source to compile: either a single file (path) or, when
// `srcDir` is "data/magic", that file verbatim.  Anything with a "magic/"
// child is treated as a file/source-tree pair and its fragments are used.
const src = fs.readFileSync(wasmJs, "utf8");
const ctx = { console, TextDecoder, TextEncoder, process, require, __dirname: __dirname, module: { exports: {} } };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(src, ctx, { filename: wasmJs });
const createLibmagic = ctx.createLibmagic || ctx.module.exports;

createLibmagic({}).then((Module) => {
  const FS = Module.FS;

  let text, fragCount = 1, label = srcDir;
  if (srcDir.endsWith(".mgc")) {
    // An already-compiled database (e.g. /usr/share/misc/magic.mgc from the
    // system's libmagic-mgc).  It is shipped gzipped: 8.5 MB of database is
    // about 400 KB that way, which is what makes it shippable at all.
    const mgcIn = fs.readFileSync(srcDir);
    const zlib = require("zlib");
    const gz = zlib.gzipSync(mgcIn, { level: 9 });
    console.log("magic.mgc:", (mgcIn.length / 1024 / 1024).toFixed(2), "MB ->",
                (gz.length / 1024).toFixed(0), "KB gzipped from", srcDir);
    emit(gz, "gzip");
    return;
  }
  if (fs.existsSync(srcDir) && fs.statSync(srcDir).isFile()) {
    text = fs.readFileSync(srcDir, "latin1");          // our own data/magic
  } else {
    const magicDir = path.join(srcDir, "magic");
    const fragDir = path.join(magicDir, "Magdir");
    text = fs.readFileSync(path.join(magicDir, "Header"), "latin1");
    text += fs.readFileSync(path.join(magicDir, "Localstuff"), "latin1");
    const sets = SETS_ARG === "all"
      ? fs.readdirSync(fragDir).filter((f) => !f.startsWith(".")).sort()
      : SETS_ARG.split(",");
    for (const name of sets) {
      const f = path.join(fragDir, name);
      if (!fs.existsSync(f)) { console.error("missing magic fragment:", f); process.exit(1); }
      text += fs.readFileSync(f, "latin1") + "\n";
    }
    fragCount = sets.length;
    label = srcDir + " " + (SETS_ARG === "all" ? "(complete Magdir)" : SETS_ARG);
  }
  FS.mkdir("/magic");
  FS.writeFile("/magic/magic", text);

  let err = Module._mg_open(0);
  if (err) die(Module, err, "open");
  err = Module._mg_open(MAGIC_CHECK);            // magic_compile wants MAGIC_CHECK
  if (err) die(Module, err, "open(CHECK)");

  err = Module.ccall("mg_compile", "number", ["string", "string"],
                     ["/magic/magic", null]);
  if (err) die(Module, err, "compile");

  // magic_compile() writes <name>.mgc into the default magic directory, which
  // is the module's root here -- not next to the source text.
  let found = null;
  for (const dir of ["/", "/magic"]) {
    for (const name of FS.readdir(dir)) {
      if (name.endsWith(".mgc")) found = dir + "/" + name;
    }
  }
  if (!found) { console.error("no .mgc produced:", FS.readdir("/"), FS.readdir("/magic")); process.exit(1); }
  const mgc = FS.readFile(found);
  console.log("magic.mgc:", (mgc.length / 1024 / 1024).toFixed(2) + " MB",
              "from", fragCount, "fragments of", label);

  // sanity: load it back and identify a few buffers
  Module._mg_free(err);
  err = Module._mg_open(0);
  if (err) die(Module, err, "open");
  err = Module.ccall("mg_load", "number", ["string"], [found]);
  if (err) die(Module, err, "load");
  const samples = [
    ["plain text", "hello world\nsecond line\n"],
    ["json", "{\"a\": 1}\n"],
    ["elf", "\x7fELF\x02\x01\x01\x00" + "\0".repeat(56)],
    ["png", "\x89PNG\r\n\x1a\n" + "\0".repeat(32)],
    ["gzip", "\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\x03" + "\0".repeat(24)],
    ["pdf", "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"],
  ];
  for (const [label, buf] of samples) {
    const bytes = Buffer.from(buf, "latin1");
    const p = Module._malloc(bytes.length);
    Module.HEAPU8.set(bytes, p);
    const r = Module.UTF8ToString(Module._mg_check(p, bytes.length));
    Module._free(p);
    console.log("  " + label.padEnd(12) + " -> " + r);
  }

  emit(mgc, "raw", label + " (" + fragCount + " fragments)");
}).catch((e) => { console.error(e); process.exit(1); });

function emit(bytes, encoding, what) {
  const b64 = Buffer.from(bytes).toString("base64");
  const js = `// GENERATED by tools/gen_magicmgc.js -- do not edit by hand.
//
// file(1)'s compiled magic database (${what}), carried as
// ${encoding === "gzip" ? "gzipped" : "raw"} base64 so the page still works
// straight from file://.  ${encoding === "gzip"
    ? "src/magic.js inflates it with DecompressionStream before handing it to\n// libmagic; the library itself is assets/libmagic.js, built by\n// tools/build_libmagic.sh."
    : "src/magic.js hands it straight to the library in assets/libmagic.js."}
(function (LW) {
  "use strict";
  LW.MAGIC_MGC = "${b64}";
  LW.MAGIC_MGC_ENCODING = "${encoding}";
})(window.LW = window.LW || {});
`;
  fs.writeFileSync(outJs, js);
  console.log("wrote", outJs, (b64.length / 1024 / 1024).toFixed(2) + " MB base64 (" +
              (bytes.length / 1024).toFixed(0) + " KB " + encoding + ")");
}

