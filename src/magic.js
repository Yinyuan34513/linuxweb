// The `file` command, backed by real libmagic.
//
// assets/libmagic.js is file(1)'s own library (src/apprentice.c, softmagic.c,
// ascmagic.c, readelf.c, ...) compiled to WebAssembly, and src/magicmgc.data.js
// is a magic.mgc compiled from data/magic *by that same build* -- the database
// format is versioned, so the two have to come from the same source tree.
//
// The module is instantiated once, in the background, while the boot log is
// still scrolling; `file` waits for it if it is asked before it is ready.
(function (LW) {
  "use strict";

  var V = LW.VFS;
  var def = LW.core.defCmd;
  var getopt = LW.core.getopt, finish = LW.core.finish;

  // The shell stores bytes as characters, so the first 256 code points are
  // taken one for one; anything above that is UTF-8, like the real thing.
  function bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x100) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return new Uint8Array(out);
  }

  // libmagic's readelf.c reads program headers and PT_NOTE sections with
  // pread(), so it needs a real file to describe an ELF completely -- that is
  // where "pie executable, dynamically linked, interpreter /lib64/ld-linux…"
  // comes from.  The bytes go into the module's own filesystem for that
  // reason, and the buffer API is only the fallback.
  var seq = 0;
  function checkIn(m, u8, mime, flags) {
    if (!m._mg_check_file) return null;
    var path = "/check" + (seq++) + ".bin";
    try {
      m.FS.writeFile(path, u8);
      if (mime) m._mg_setflags(flags);
      var r = m.ccall("mg_check_file", "number", ["string"], [path]);
      return m.UTF8ToString(r);
    } catch (e) {
      return null;
    }
  }

  var MAGIC_NONE = 0, MAGIC_MIME_TYPE = 0x00010, MAGIC_MIME = 0x00040;

  // LW.magic.ready settles with the module; LW.magic.failed explains why not.
  var state = { ready: null, failed: null, module: null };
  LW.magic = {
    ready: null,
    failed: null,
    // Identify a buffer of bytes; returns libmagic's answer verbatim.
    check: function (u8, mime) {
      var m = state.module;
      if (!m) return null;
      var flags = mime ? MAGIC_MIME : MAGIC_NONE;
      var r = checkIn(m, u8, mime, flags);
      if (r !== null) { m._mg_setflags(MAGIC_NONE); return r; }
      m._mg_setflags(flags);
      var ptr = m._malloc(u8.length || 1);
      m.HEAPU8.set(u8, ptr);
      var out = m.UTF8ToString(m._mg_check(ptr, u8.length));
      m._free(ptr);
      m._mg_setflags(MAGIC_NONE);
      return out;
    },
    mimeType: function (u8) {
      var m = state.module;
      if (!m) return null;
      var r = checkIn(m, u8, true, MAGIC_MIME_TYPE);
      if (r !== null) { m._mg_setflags(MAGIC_NONE); return r; }
      m._mg_setflags(MAGIC_MIME_TYPE);
      var ptr = m._malloc(u8.length || 1);
      m.HEAPU8.set(u8, ptr);
      var out = m.UTF8ToString(m._mg_check(ptr, u8.length));
      m._free(ptr);
      m._mg_setflags(MAGIC_NONE);
      return out;
    },
  };

  // The database ships as base64 (the page must work from file://) and, at
  // 8.1 MB raw, as gzip: DecompressionStream is in every browser that can
  // run wasm, so the 383 KB blob is inflated here rather than carrying an
  // inflate implementation.
  function database() {
    var raw = atob(LW.MAGIC_MGC);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    if (LW.MAGIC_MGC_ENCODING !== "gzip") return Promise.resolve(bytes);
    if (typeof DecompressionStream !== "function") {
      return Promise.reject(new Error("this browser has no DecompressionStream"));
    }
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  state.ready = new Promise(function (resolve, reject) {
    if (typeof createLibmagic !== "function") {
      reject(new Error("assets/libmagic.js did not load"));
      return;
    }
    createLibmagic({}).then(function (Module) {
      database().then(function (mgc) {
        try {
          Module.FS.writeFile("/magic.mgc", mgc);
          var err = Module._mg_open(MAGIC_NONE);
          if (err) throw new Error(Module.UTF8ToString(err));
          err = Module.ccall("mg_load", "number", ["string"], ["/magic.mgc"]);
          if (err) throw new Error(Module.UTF8ToString(err));
          state.module = Module;
          resolve(Module);
        } catch (e) {
          reject(e);
        }
      }, reject);
    }, reject);
  });
  LW.magic.ready = state.ready;
  state.ready["catch"](function (e) { LW.magic.failed = e; });
  LW.magic.ready.then(function (m) { LW.magic.module = m; });

  // file(1)'s own usage block, printed when it is given nothing to do.
  var USAGE = [
    "Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]",
    "            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]",
    "            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]",
    "            <file> ...",
    "       file -C [-m <magicfiles>]",
    "       file [--help]",
  ].join("\n") + "\n";

  // ---- the command ---------------------------------------------------------
  //
  // file(1) wording, straight from file 5.45:
  //   /nope: cannot open `/nope' (No such file or directory)
  //   /dev/null: character special (1/3)
  //   /tmp/x:    ELF 64-bit LSB executable, x86-64, ...
  //   empty:     empty
  //   lnk:       symbolic link to hello.txt
  // file pads the name column to the widest operand and separates it with
  // -F (default ": "), and it exits 0 even when a file cannot be opened.
  def("file", function (args, stdin, sh) {
    var g = getopt("file", args, {
      short: { b: "bool", L: "bool", h: "bool", i: "bool", I: "bool",
               k: "bool", F: "arg", m: "arg" },
      long: { brief: ["bool", "b"], dereference: ["bool", "L"],
              "no-dereference": ["bool", "h"], mime: ["bool", "i"],
              "mime-type": ["bool", "I"], "mime-encoding": "bool",
              "keep-going": ["bool", "k"], separator: ["arg", "F"],
              "magic-file": ["arg", "m"], uncompress: ["bool", "z"],
              raw: ["bool", "r"], preserve_date: "bool" },
    });
    var done = finish(sh, "file", g);
    if (done) return done;
    var o = g.o;
    if (!g._.length) {
      sh._error(USAGE.trim().split("\n").map(function (l) { return l; }).join("\n"));
      return { out: "", code: 1 };
    }

    var sep = o.F === undefined ? ": " : o.F;
    var width = 0;
    g._.forEach(function (n) { width = Math.max(width, n.length); });
    var brief = !!o.b, mime = !!o.i, mimeType = !!o.I, lines = [];

    // The raw node (V.getNode follows symlinks) so `file` can report the link
    // itself the way it does without -L.
    function rawNode(p) {
      var par = V.getNode(V.parentOf(p));
      if (!par || !par.c) return null;
      return par.c[V.baseName(p)] || null;
    }

    g._.forEach(function (name) {
      var p = sh.path(name), node = rawNode(p);
      var pad = brief ? "" : sep + new Array(Math.max(1, width - name.length + 1)).join(" ");
      var label0 = brief ? "" : name + pad;
      if (!node) {
        sh._error(label0 + "cannot open `" + name + "' (No such file or directory)");
        return;
      }
      var label = label0;

      if (node.t === "l") {
        var target = V.getNode(p);                  // resolved
        if (o.L && target && target.t !== "d" && target.t !== "l") {
          lines.push({ label: label, bytes: bytes(V.readFile(p) || "") });
          return;
        }
        if (o.L && target && target.t === "d") { lines.push(label + "directory"); return; }
        lines.push(label + "symbolic link to " + node.to);
        return;
      }
      var n = V.getNode(p);
      if (n.t === "d") { lines.push(label + "directory"); return; }
      if (n.dev && LW.DEV) {
        lines.push(label + (n.devType === "b" ? "block special" : "character special") +
                   " (" + n.major + "/" + n.minor + ")");
        return;
      }
      var data = V.readFile(p);
      if (data === null) {
        sh._error(label0 + sep + "cannot open `" + name + "' (No such file or directory)");
        return;
      }
      if (data === "") { lines.push(label + "empty"); return; }
      lines.push({ label: label, bytes: bytes(data), name: name });
    });

    return {
      async: true,
      start: function (io) {
        function finishWith(out) { io.write(out); io.done(0); }
        state.ready.then(function () {
          var out = "";
          lines.forEach(function (l) {
            if (typeof l === "string") { out += l + "\n"; return; }
            var desc = mimeType ? LW.magic.mimeType(l.bytes) : "";
            if (mime || !mimeType) desc = LW.magic.check(l.bytes, !!mime) || desc;
            out += l.label + desc + "\n";
          });
          finishWith(out);
        }, function () {
          // No libmagic (module blocked, wasm unsupported): fall back to the
          // one thing the shell can tell on its own.
          var out = "";
          lines.forEach(function (l) {
            if (typeof l === "string") { out += l + "\n"; return; }
            var text = "";
            for (var i = 0; i < Math.min(l.bytes.length, 1024); i++) text += String.fromCharCode(l.bytes[i]);
            out += l.label + (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text) ? "ASCII text" : "data") + "\n";
          });
          finishWith(out);
        });
      },
    };
  }, "determine file type");
})(window.LW);