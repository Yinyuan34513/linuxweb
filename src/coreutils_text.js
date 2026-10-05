// GNU coreutils -- text filters.  wc, head, tail, sort, uniq, tr, cut, nl,
// tac, fold, fmt, expand, unexpand, join, comm, paste, split, od, pr,
// numfmt, seq, ptx, shuf, truncate, tsort.
//
// Every command here is a real coreutils program: the options, the error
// wording and the exit statuses are checked against GNU coreutils 9.4
// (LC_ALL=C), and --help / --version print the real text that
// src/coreutils_help.js was generated with.
//
// Requires: vfs.js, bash.js (LW.core).
(function (LW) {
  "use strict";

  var V = LW.VFS;
  var def = LW.core.defCmd;
  var getopt = LW.core.getopt, finish = LW.core.finish;
  var eachInput = LW.core.eachInput, gnuErr = LW.core.gnuErr;

  // ---------------------------------------------------------------- shared --

  // Lines, keeping the information about whether the input ended in a
  // newline -- wc, head and sort all care about that and it is invisible once
  // the text has been through split("\n").
  function lines(text) {
    if (text === "") return { a: [], ends: true };   // empty input: no lines
    var a = text.split("\n");
    var ends = text.slice(-1) === "\n";
    if (ends) a.pop();
    return { a: a, ends: ends };
  }

  // coreutils pads its counters to seven columns: `wc` numbers, `uniq -c`,
  // `nl`, and `pr`'s page numbers all line up in the man pages that way.
  function pad7(n) { return String(n).padStart(7); }

  // `head: cannot open 'x' for reading: ...` -- the wording several programs
  // share (head, tail, split, csplit).
  function openErr(prog, name, kind) {
    return prog + ": cannot open '" + name + "' for reading: " +
      (kind === "dir" ? "Is a directory"
        : kind === "perm" ? "Permission denied"
          : "No such file or directory");
  }

  // Read every operand (or stdin) and hand each one to fn(text, name).
  // head/tail/wc/... share this, and each supplies its own error wording.
  function inputs(prog, args, stdin, sh, errFmt, fn) {
    return eachInput(prog, args, stdin, sh, errFmt || gnuErr, fn);
  }

  // A byte count is a byte count: the shell stores text as characters, so a
  // non-ASCII character counts as its UTF-8 length here and as one elsewhere.
  // This matches what the real tools report for the ASCII files this
  // filesystem holds, and keeps `wc -c` honest for the rest.
  function byteLength(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
  }

  // ---- wc ------------------------------------------------------------------
  //
  // wc has two layouts and the real tool's choice between them is worth
  // copying exactly:
  //
  //   * stdin alone (`cat f | wc`, and `wc -`): one line, every count padded
  //     to seven columns, and the name column only when "-" was written out.
  //   * real operands: one line per operand plus a "total" line, the numbers
  //     right-aligned in a single shared width -- the number of digits in the
  //     largest *byte* count, which is how `wc -w f1 big` comes out three wide
  //     even though its word counts are one digit.
  def("wc", function (args, stdin, sh) {
    var g = getopt("wc", args, {
      short: { l: "bool", w: "bool", c: "bool", m: "bool", L: "bool" },
      long: { lines: ["bool", "l"], words: ["bool", "w"], bytes: ["bool", "c"],
              chars: ["bool", "m"], "max-line-length": ["bool", "L"] },
    });
    var done = finish(sh, "wc", g);
    if (done) return done;
    var o = g.o;
    var keys = [];
    if (o.l) keys.push("lines");
    if (o.w) keys.push("words");
    if (o.c) keys.push("bytes");
    if (o.m) keys.push("chars");
    if (o.L) keys.push("maxlen");
    if (!keys.length) keys = ["lines", "words", "bytes"];

    var rows = [], code = 0, sawStdin = false, taken = false;
    var operands = g._.length ? g._ : [null];
    for (var i = 0; i < operands.length; i++) {
      var name = operands[i], text = null;
      if (name === "-") {
        if (taken) continue;
        taken = true;
        sawStdin = true;
        text = stdin || "";
      } else if (name === null) {
        text = stdin || "";
        sawStdin = true;
      } else {
        var p = sh.path(name), node = V.getNode(p);
        text = V.readFile(p);
        if (text === null) {
          sh._error(gnuErr("wc", name, node && node.t === "d" ? "dir" : "missing"));
          code = 1;
          continue;
        }
      }
      rows.push(count(text, name));
    }

    // every count adds up except the longest line, whose "total" is the
    // longest of them all: `wc -L` over a 3-byte and a 10-byte line says 10
    var totals = { lines: 0, words: 0, bytes: 0, chars: 0, maxlen: 0 };
    rows.forEach(function (r) {
      totals.lines += r.lines; totals.words += r.words;
      totals.bytes += r.bytes; totals.chars += r.chars;
      totals.maxlen = Math.max(totals.maxlen, r.maxlen);
    });
    // Only the unfiltered, stdin-reading layout pads to seven columns; with
    // operands (or a selection flag) the numbers share one computed width.
    var plain = keys.length === 3 && keys[0] === "lines";
    var width = sawStdin && plain ? 7 : String(Math.max.apply(null,
      rows.concat([totals]).map(function (r) { return r.bytes; }))).length;
    var out = "";

    if (sawStdin && plain) {
      var wide = function (r, name) {
        return keys.map(function (k) { return String(r[k]).padStart(7); }).join(" ") +
          (name === null ? "" : " " + name) + "\n";
      };
      rows.forEach(function (r) { out += wide(r, r.name); });
      if (rows.length > 1) out += wide(totals, "total");
      return { out: out, code: code };
    }
    rows.forEach(function (r) { out += formatRow(r, r.name); });
    if (rows.length > 1) out += formatRow(totals, "total");
    return { out: out, code: code };

    function formatRow(r, name) {
      // no name column when the counts came from plain standard input
      var line = keys.map(function (k) { return String(r[k]).padStart(width); }).join(" ");
      return (name === null ? line : line + " " + name) + "\n";
    }
    function count(text, name) {
      var l = lines(text), words = 0;
      l.a.forEach(function (line) {
        words += line.split(/\s+/).filter(function (x) { return x !== ""; }).length;
      });
      return {
        name: name, lines: l.a.length, words: words,
        bytes: byteLength(text), chars: text.length,
        maxlen: l.a.reduce(function (m, x) { return Math.max(m, x.length); }, 0),
      };
    }
  }, "print newline, word, and byte counts");

  // ---- head / tail ---------------------------------------------------------
  //
  // The two share nearly everything: N lines (default 10), -c bytes, -q to
  // drop the file headers, -v to print them, and a negative count meaning
  // "all but the last N" for head, "the last N" for tail.
  function headTail(name, fromEnd) {
    def(name, function (args, stdin, sh) {
      var g = getopt(name, args, {
        short: { n: "arg", c: "arg", q: "bool", v: "bool", z: "bool",
                 "0": "bool" },
        long: { lines: ["arg", "n"], bytes: ["arg", "c"], quiet: ["bool", "q"],
                verbose: ["bool", "v"], silent: ["bool", "q"], "zero-terminated": ["bool", "z"] },
        digits: "n",                       // `head -3` is `head -n 3`
      });
      var done = finish(sh, name, g);
      if (done) return done;
      var o = g.o;
      var count = null, bytes = false, quiet = !!o.q || !!o.quiet || !!o.silent;
      var value = o.c !== undefined ? o.c : o.n;
      if (value !== undefined) {
        // `-n -3` and `-n +3`: a minus leaves the last N off, a plus starts N in
        if (!/^-?[+]?\d+$/.test(String(value))) {
          sh._error(name + ": invalid number of lines: '" + value + "'");
          return { out: "", code: 1 };
        }
        count = parseInt(value, 10);
        bytes = o.c !== undefined;
      }
      if (count === null) count = 10;
      if (count < 0) { count = -count; }              // head: all but last N

      var many = g._.length > 1;
      var out = "", code = 0, first = true;
      var files = g._;

      code = inputs(name, files, stdin, sh, openErr, function (text, fname) {
        // with more than one operand each section is introduced by a header,
        // and the sections are separated by a blank line
        if (many && !quiet) {
          if (!first) out += "\n";
          out += "==> " + (fname === null ? "standard input" : fname) + " <==\n";
        }
        if (o.v && !many) out += (fname === null ? "standard input" : fname) + "\n";
        first = false;
        out += slice(text, count, bytes, fromEnd);
        if (o["0"] && many && fname !== null) out += "\n";
      });
      // head -n +3 skips the first two lines
      if (!fromEnd && o.n !== undefined && /^\+/.test(String(o.n))) {
        var skip = parseInt(String(o.n).slice(1), 10) - 1;
        out = out.split("\n").slice(skip).join("\n");
      }
      return { out: out, code: code };
    }, name + " - output the " + (fromEnd ? "last" : "first") + " part of files");

    function slice(text, n, byBytes, last) {
      if (byBytes) {
        var chars = Array.from(text);                // keep code points intact
        if (!last) return chars.slice(0, n).join("");
        return n >= chars.length ? text : chars.slice(chars.length - n).join("");
      }
      var l = lines(text);
      var picked = last ? l.a.slice(Math.max(0, l.a.length - n)) : l.a.slice(0, n);
      if (!picked.length) return "";
      return picked.join("\n") + (last || l.ends || picked.length < l.a.length ? "\n" : "");
    }
  }
  headTail("head", false);
  headTail("tail", true);

  // ---- sort ----------------------------------------------------------------
  //
  // -k FIELD start[.C][OPTS], -t SEP, the numeric/blank/case comparators and
  // the order they compose in (last-resort comparison, then the whole line),
  // which is why -k2,2n on "x:2" and "a:10" does not fall back to the line.
  def("sort", function (args, stdin, sh) {
    var g = getopt("sort", args, {
      short: { b: "bool", d: "arg", f: "arg", g: "bool", h: "bool", i: "bool",
               k: "arg", M: "arg", m: "bool", n: "bool", R: "arg", r: "bool",
               s: "bool", t: "arg", u: "bool", V: "bool", z: "bool", c: "bool",
               "0": "bool" },
      long: {
        "ignore-blanks": ["bool", "b"], "key": ["arg", "k"], "numeric-sort": ["bool", "n"],
        "general-numeric-sort": ["bool", "g"], "human-numeric-sort": ["bool", "h"],
        "reverse": ["bool", "r"], "unique": ["bool", "u"], "check": ["bool", "c"],
        "field-separator": ["arg", "t"], "zero-terminated": ["bool", "z"],
        "version-sort": ["bool", "V"], "random-sort": ["bool", "R"],
        "stable": ["bool", "s"], "debug": ["bool", "W"], "compress-program": ["arg", "C"],
      },
      exit: 2,
    });
    var done = finish(sh, "sort", g);
    if (done) return done;
    var o = g.o;
    if (g._.length > 1) {
      sh._error("sort: cannot read: " + JSON.stringify(g._) + ": No such file or directory");
      return { out: "", code: 2 };
    }
    var sep = o.t !== undefined ? unescapeSep(o.t) : "";
    var keys = parseKeys(o.k);

    var text = "", code = 0;
    code = inputs("sort", g._, stdin, sh, function (p, name, kind) {
      return "sort: cannot read: " + name + ": " +
        (kind === "dir" ? "Is a directory"
          : kind === "perm" ? "Permission denied" : "No such file or directory");
    }, function (t) { text += t; });

    var l = lines(text);
    if (o.c) {
      // -c only checks: "disorder: X" on the first bad line, exit 1
      for (var i = 1; i < l.a.length; i++) {
        if (compare(l.a[i - 1], l.a[i]) > 0) {
          sh._error("sort: " + (g._[0] || "-") + ":" + (i + 1) + ": disorder: " + l.a[i]);
          return { out: "", code: 1 };
        }
      }
      return { out: "", code: 0 };
    }
    var arr = l.a.slice();
    arr.sort(function (x, y) { return compare(x, y); });
    if (o.u) {
      var uniq = [];
      arr.forEach(function (x) {
        if (!uniq.length || compare(uniq[uniq.length - 1], x) !== 0) uniq.push(x);
      });
      arr = uniq;
    }
    var out = arr.length ? arr.join(o.z ? "\0" : "\n") + (o.z ? "\0" : "\n") : "";

    function compare(a, b) {
      var r = 0;
      if (keys.length) {
        for (var k = 0; k < keys.length && r === 0; k++) r = keyCompare(a, b, keys[k]);
      } else {
        r = fullCompare(a, b);
      }
      // last-resort comparison: the whole line, unless -s
      if (r === 0 && keys.length && !o.s) r = fullCompare(a, b);
      return o.r ? -r : r;
    }

    function keyCompare(a, b, key) {
      var fa = field(a, key.from), fb = field(b, key.from);
      var la = key.to === undefined ? fa : field(a, key.to);
      var lb = key.to === undefined ? fb : field(b, key.to);
      var va = la.slice(fa.length), vb = lb.slice(fb.length);   // drop common prefix
      if (key.ignoreBlanks) {
        va = va.replace(/^[ \t]+/, ""); vb = vb.replace(/^[ \t]+/, "");
      }
      switch (key.type) {
        case "n": return numCompare(va, vb);
        case "g": return floatCompare(va, vb);
        case "h": return humanCompare(va, vb);
        case "V": return versionCompare(va, vb);
        case "b": return foldCompare(va, vb);
        default: return strCompare(va, vb);
      }
    }

    function field(line, n) {
      if (n === 0) return "";
      var parts = sep ? line.split(sep) : line.split(/[ \t]+/).filter(function (x, i) {
        return !(i === 0 && x === "") && x !== "";
      });
      return (parts[n - 1] === undefined ? "" : parts[n - 1]);
    }

    function fullCompare(a, b) {
      if (o.n) return numCompare(a, b);
      if (o.g) return floatCompare(a, b);
      if (o.h) return humanCompare(a, b);
      if (o.V) return versionCompare(a, b);
      if (o.b) return foldCompare(a, b);
      return strCompare(a, b);
    }

    return { out: out, code: code };

    function parseKeys(spec) {
      if (spec === undefined) return [];
      return String(spec).split(/\n/).filter(Boolean).map(function (one) {
        // FIELD[.START][OPTS][, FIELD[.START][OPTS]]
        var key = { from: 1, to: undefined, type: "s", ignoreBlanks: !!o.b };
        var parts = String(one).split(",");
        for (var i = 0; i < parts.length; i++) {
          var piece = parts[i].trim();
          if (!piece) continue;
          var m = /^(\d+)(?:\.(\d+))?(.*)$/.exec(piece);
          if (!m) continue;
          var num = parseInt(m[1], 10);
          if (i === 0) key.from = num; else key.to = num;
          var opts = m[3] || "";
          if (opts.indexOf("b") >= 0) key.ignoreBlanks = true;
          if (opts.indexOf("n") >= 0) key.type = "n";
          else if (opts.indexOf("g") >= 0) key.type = "g";
          else if (opts.indexOf("h") >= 0) key.type = "h";
          else if (opts.indexOf("V") >= 0) key.type = "V";
          else if (opts.indexOf("r") >= 0) key.reverse = true;
          else if (opts.indexOf("f") >= 0) key.from = key.to = num;
        }
        return key;
      });
    }
  }, "sort - sort lines of text files");

  function strCompare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  function foldCompare(a, b) {
    var x = a.toLowerCase(), y = b.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    return strCompare(a, b);
  }

  // `sort -n`: leading blanks ignored, digits compared as integers, and
  // anything that is not a number sorts before all numbers.
  function numCompare(a, b) {
    var x = leadingNumber(a), y = leadingNumber(b);
    if (x === null && y === null) return strCompare(a, b);
    if (x === null) return -1;
    if (y === null) return 1;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function leadingNumber(s) {
    var m = /^[ \t]*(-?\d+)/.exec(s);
    return m ? parseInt(m[1], 10) : null;
  }
  function floatCompare(a, b) {
    var x = parseFloat(a), y = parseFloat(b);
    if (isNaN(x) && isNaN(y)) return strCompare(a, b);
    if (isNaN(x)) return -1;
    if (isNaN(y)) return 1;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  // `sort -h`: 512 < 1K < 2M, so the suffix is part of the magnitude.
  var HUMAN = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Z: 1e21, Y: 1e24 };
  function humanCompare(a, b) {
    var x = humanValue(a), y = humanValue(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function humanValue(s) {
    var m = /^\s*(\d+(?:\.\d+)?)\s*([KMGTPEZY])?[i]?B?\s*$/.exec(s);
    if (!m) return NaN;
    var n = parseFloat(m[1]);
    return m[2] ? n * HUMAN[m[2]] : n;
  }
  // `sort -V`: file9 sorts before file10, which a plain byte sort gets wrong.
  function versionCompare(a, b) {
    var ax = a.match(/(\d+|\D+)/g) || [], bx = b.match(/(\d+|\D+)/g) || [];
    for (var i = 0; i < Math.max(ax.length, bx.length); i++) {
      var x = ax[i], y = bx[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (/^\d/.test(x) && /^\d/.test(y)) {
        var d = parseInt(x, 10) - parseInt(y, 10);
        if (d) return d < 0 ? -1 : 1;
      } else if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  }

  // ---- uniq ----------------------------------------------------------------
  //
  // -c counts, -d/-u keep only repeated/unique lines, -i ignores case, and
  // -w N / -s N decide which lines count as "the same" (like uniq's -f in
  // Solaris): comparison is over the first N characters, skipping N fields.
  def("uniq", function (args, stdin, sh) {
    var g = getopt("uniq", args, {
      short: { c: "bool", d: "bool", u: "bool", i: "bool", w: "arg", s: "arg",
               z: "bool", f: "arg", W: "arg", t: "arg" },
      long: { count: ["bool", "c"], repeated: ["bool", "d"], "all-repeated": ["bool", "D"],
              "unique": ["bool", "u"], "ignore-case": ["bool", "i"],
              "ignore-initial-blanks": ["bool", "b"], "check-chars": ["arg", "w"],
              skip: ["arg", "s"], "zero-terminated": ["bool", "z"],
              "skip-fields": ["arg", "f"], "skip-chars": ["arg", "W"],
              "ignore-failures": ["bool", "f"], "group-separator": ["arg", "t"] },
    });
    var done = finish(sh, "uniq", g);
    if (done) return done;
    var o = g.o;
    if (g._.length > 1) {
      sh._error("uniq: extra operand '" + g._[1] + "'");
      return { out: "", code: 1 };
    }
    var text = "", code = 0;
    code = inputs("uniq", g._, stdin, sh, gnuErr, function (t) { text += t; });

    var skipFields = parseInt(o.f, 10) || 0;
    var skipChars = parseInt(o.W, 10) || 0;
    var chars = o.w === undefined ? Infinity : parseInt(o.w, 10);
    var skip = o.s === undefined ? 0 : parseInt(o.s, 10);

    var arr = lines(text).a, out = "", prev = null, count = 0;
    function same(a, b) {
      if (o.i) { a = a.toLowerCase(); b = b.toLowerCase(); }
      return a.slice(skipChars, skipChars + chars) === b.slice(skipChars, skipChars + chars);
    }
    function emit() {
      if (prev === null) return;
      var repeated = count > 1;
      var show = true;
      if (o.d || o.D) show = repeated;
      if (o.u) show = !repeated;
      if (!show) return;
      out += (o.c ? pad7(count) + " " : "") + prev + "\n";
    }
    arr.forEach(function (line) {
      if (prev !== null && same(prev, line)) { count++; if (skip > 0) count += skip; return; }
      emit();
      prev = line; count = 1;
    });
    emit();
    return { out: out, code: code };
  }, "report or omit repeated lines");

  // ---- tr ------------------------------------------------------------------
  //
  // Ranges, escapes, the [:class:] forms and the three sets (-d delete,
  // -s squeeze-repeats, -c complement) — a subset that has to expand and then
  // delete/squeeze/complement, so the sets are handled in that order.
  def("tr", function (args, stdin, sh) {
    var g = getopt("tr", args, {
      short: { c: "bool", d: "bool", s: "bool", t: "bool" },
      long: { complement: ["bool", "c"], delete: ["bool", "d"],
              "squeeze-repeats": ["bool", "s"], "truncate-set1": ["bool", "t"] },
    });
    var done = finish(sh, "tr", g);
    if (done) return done;
    var o = g.o;
    var sets = g._;
    if (!sets.length || sets.length > 2) {
      sh._error(sets.length ? "tr: extra operand '" + sets[2] + "'"
        : "tr: missing operand");
      return { out: "", code: 1 };
    }
    var set1, set2 = null;
    try {
      set1 = expandSet(sets[0]);
      if (sets.length === 2) set2 = expandSet(sets[1]);
    } catch (e) {
      sh._error("tr: " + e.message);
      return { out: "", code: 1 };
    }
    if (!set1.length) {
      sh._error("tr: when translating, the first string must be non-empty");
      return { out: "", code: 1 };
    }
    if (sets.length === 2 && !set2.length && !o.d) {
      sh._error("tr: when translating, the second string must be non-empty");
      return { out: "", code: 1 };
    }

    var map = {};
    var translating = sets.length === 2 && !o.d && !o.t;
    if (sets.length === 2 && !o.d) {
      for (var i = 0; i < set1.length; i++) {
        map[set1[i]] = set2[Math.min(i, set2.length - 1)];
      }
    }
    // -s squeezes repeats of the characters in SET2, after translation
    var squeeze = sets.length === 2 ? set2 : set1;
    var out = "", prev = null;
    for (var j = 0; j < stdin.length; j++) {
      var ch = stdin.charAt(j);
      var inSet = set1.indexOf(ch) >= 0;
      if (o.c) inSet = !inSet;
      if (o.d && inSet) continue;                     // -d: delete
      if (translating && map[ch] !== undefined) ch = map[ch];
      else if (o.t && map[ch] !== undefined) ch = map[ch];   // -t: truncate set1
      if (o.s && squeeze.indexOf(ch) >= 0) {
        if (ch === prev) continue;                    // -s: squeeze repeats
        prev = ch;
      }
      out += ch;
    }
    return { out: out, code: 0 };

    // A TR string: escapes, a-z ranges, and [:class:] groups.
    function expandSet(spec) {
      var out = [], i = 0;
      while (i < spec.length) {
        var ch = spec.charAt(i);
        if (ch === "\\") {
          var e = spec.charAt(i + 1);
          i += 2;
          if (e === "n") { out.push("\n"); continue; }
          if (e === "t") { out.push("\t"); continue; }
          if (e === "r") { out.push("\r"); continue; }
          if (e === "\\") { out.push("\\"); continue; }
          if (e === "a") { out.push("\x07"); continue; }
          if (e === "b") { out.push("\b"); continue; }
          if (e === "f") { out.push("\f"); continue; }
          if (e === "v") { out.push("\v"); continue; }
          var oct = /^[0-7]{1,3}/.exec(spec.slice(i));
          if (oct) { out.push(String.fromCharCode(parseInt(oct[0], 8))); i += oct[0].length; continue; }
          out.push(e);
          continue;
        }
        if (ch === "[") {
          var close = spec.indexOf("]", spec.charAt(i + 1) === ":") ? spec.indexOf("]", spec.indexOf(":", i) + 1) : -1;
          var body = spec.slice(i + 1, close);
          if (body.charAt(0) === ":") {
            out = out.concat(CLASSES[body.slice(1, -1)] || []);
            i = close + 1;
            continue;
          }
          // [abc] or [^abc]: the negated form is not portable in tr
          out = out.concat(body.split(""));
          i = close + 1;
          continue;
        }
        if (spec.charAt(i + 1) === "-" && spec.charAt(i + 2) !== undefined && i + 2 < spec.length) {
          var from = ch.charCodeAt(0), to = spec.charAt(i + 2).charCodeAt(0);
          for (var c = from; c <= to; c++) out.push(String.fromCharCode(c));
          i += 3;
          continue;
        }
        out.push(ch);
        i++;
      }
      return out;
    }
  }, "translate or delete characters");

  // The [:class:] sets tr knows, in the order coreutils documents them.
  var CLASSES = {
    alpha: ("abcdefghijklmnopqrstuvwxyz" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ").split(""),
    digit: "0123456789".split(""),
    alnum: ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789").split(""),
    lower: "abcdefghijklmnopqrstuvwxyz".split(""),
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
    space: [" ", "\t", "\n", "\v", "\f", "\r"],
    blank: [" ", "\t"],
    punct: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".split(""),
    print: (function () {
      var a = [];
      for (var c = 32; c < 127; c++) a.push(String.fromCharCode(c));
      return a;
    })(),
    graph: (function () {
      var a = [];
      for (var c = 33; c < 127; c++) a.push(String.fromCharCode(c));
      return a;
    })(),
    cntrl: (function () {
      var a = [];
      for (var c = 0; c < 32; c++) a.push(String.fromCharCode(c));
      a.push("\x7f");
      return a;
    })(),
    xdigit: "0123456789abcdefABCDEF".split(""),
  };

  // ---- cut -----------------------------------------------------------------
  //
  // -b bytes, -c characters, -f fields; a LIST is N, N-M, N- or -M; --complement
  // inverts the selection.  -s drops lines with no delimiter, and the output
  // delimiter is the input one unless --output-delimiter says otherwise.
  def("cut", function (args, stdin, sh) {
    var g = getopt("cut", args, {
      short: { b: "arg", c: "arg", d: "arg", f: "arg", s: "bool", n: "bool",
               z: "bool", "0": "bool" },
      long: { bytes: ["arg", "b"], characters: ["arg", "c"], delimiter: ["arg", "d"],
              fields: ["arg", "f"], "only-delimited": ["bool", "s"],
              complement: "bool", "output-delimiter": "arg",
              "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "cut", g);
    if (done) return done;
    var o = g.o;
    var modes = [o.b !== undefined ? "b" : null, o.c !== undefined ? "c" : null,
                 o.f !== undefined ? "f" : null].filter(Boolean);
    if (modes.length !== 1) {
      sh._error("cut: you must specify a list of bytes, characters, or fields");
      return { out: "", code: 1 };
    }
    var mode = modes[0];
    var list = parseList(mode === "f" ? o.f : mode === "b" ? o.b : o.c);
    var delim = o.d === undefined ? "\t" : unescapeSep(o.d);
    var outDelim = o["output-delimiter"] !== undefined ? unescapeSep(o["output-delimiter"]) : delim;
    var complement = !!o.complement;

    var out = "", code = 0;
    code = inputs("cut", g._, stdin, sh, gnuErr, function (text) {
      lines(text).a.forEach(function (line) {
        if (mode === "f") {
          if (delim && line.indexOf(delim) < 0) {
            if (o.s) return;                            // -s: skip undelimited lines
            out += line + "\n";                        // no delimiter: print whole
            return;
          }
          var parts = line.split(delim), picked = [];
          ranges(list, complement).forEach(function (r) {
            for (var i = r[0]; i <= r[1]; i++) {
              if (parts[i - 1] !== undefined) picked.push(parts[i - 1]);
            }
          });
          out += picked.join(outDelim) + "\n";
          return;
        }
        var chars = Array.from(line);
        var take = [];
        ranges(list, complement).forEach(function (r) {
          for (var i = r[0]; i <= r[1]; i++) if (chars[i - 1] !== undefined) take.push(chars[i - 1]);
        });
        out += take.join("") + "\n";
      });
    });
    return { out: out, code: code };

    function parseList(spec) {
      // N, N-M, N- and -M.  A bare number is a one-element range, which is
      // what -f2 and -b3 mean.
      return String(spec).split(",").map(function (piece) {
        var one = /^\d+$/.exec(piece);
        if (one) return [parseInt(piece, 10), parseInt(piece, 10)];
        var m = /^(\d*)-(\d*)$/.exec(piece);
        if (!m || (m[1] === "" && m[2] === "")) return null;
        if (m[1] === "") return [1, parseInt(m[2], 10)];        // -M
        if (m[2] === "") return [parseInt(m[1], 10), 1e9];     // N-
        return [parseInt(m[1], 10), parseInt(m[2], 10)];
      }).filter(function (r) { return r && r[0] > 0; });
    }
    function ranges(l, comp) {
      if (!comp) return l;
      var keep = [], field = 1;
      var sorted = l.slice().sort(function (a, b) { return a[0] - b[0]; });
      sorted.forEach(function (r) {
        if (r[0] > field) keep.push([field, Math.min(r[0] - 1, 1e9)]);
        field = Math.max(field, r[1] === 1e9 ? 1e9 : r[1] + 1);
      });
      return keep;
    }
  }, "remove sections from each line of files");

  function unescapeSep(s) {
    return String(s).replace(/\\(n|t|\\)/g, function (m, c) {
      return c === "n" ? "\n" : c === "t" ? "\t" : "\\";
    });
  }

  // ---- nl ------------------------------------------------------------------
  //
  // Numbering is "%6d\t" and -ba numbers blank lines too, which -bt/-bn do not.
  def("nl", function (args, stdin, sh) {
    var g = getopt("nl", args, {
      short: { b: "arg", d: "arg", f: "arg", i: "arg", l: "arg", n: "arg",
               p: "arg", s: "arg", t: "arg", w: "arg", v: "arg", z: "bool",
               "0": "bool" },
      long: { "body-numbering": ["arg", "b"], "section-numbering": ["arg", "s"],
              "header-numbering": ["arg", "h"], "number-format": ["arg", "n"],
              "number-separator": ["arg", "d"], "number-width": ["arg", "w"],
              "no-number-joiner": "bool", "page-number": ["arg", "p"],
              "starting-number": ["arg", "v"], "blank-lines": ["arg", "l"],
              "footer-numbering": ["arg", "f"], "input-separator": ["arg", "i"],
              "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "nl", g);
    if (done) return done;
    var o = g.o;
    var bodyStyle = o.b === undefined ? "t" : o.b;
    var blankStyle = o.l === undefined ? "n" : o.l;
    // -b a means "number every line", blanks included, so it overrides the
    // -l default: `printf 'a\n\nb\n' | nl -ba` numbers all three.
    if (bodyStyle === "a" && o.l === undefined) blankStyle = "a";
    var start = o.v === undefined ? 1 : parseInt(o.v, 10);
    // -w WIDTH sets the field width; nl uses 6 by default ("%6d\t")
    var width = o.w === undefined ? 6 : parseInt(o.w, 10);
    var out = "", code = 0;

    code = inputs("nl", g._, stdin, sh, gnuErr, function (text) {
      lines(text).a.forEach(function (line) {
        var sep = o.d === undefined ? "\t" : unescapeSep(o.d);
        // -b STYLE picks how body lines are numbered, -l STYLE how blank ones
        // are; both default the way nl's manual describes (t, then n).
        var body = line === "" ? blankStyle : bodyStyle;
        if (body === "p") return;                  // "no numbers"
        var number = "";
        if (body === "a") number = String(start);           // number, don't count
        else if (body === "n") { if (line !== "") number = String(start++); }
        else number = String(start++);
        out += (number ? number.padStart(width) + sep : "") + line + "\n";
      });
    });
    return { out: out, code: code };
  }, "number lines");

  // ---- tac -----------------------------------------------------------------
  //
  // Prints the lines of each file backwards, and unlike `rev` it reverses the
  // file order too.
  def("tac", function (args, stdin, sh) {
    var g = getopt("tac", args, {
      short: { b: "bool", r: "bool", s: "bool" },
      long: { before: ["bool", "b"], regex: ["bool", "r"], separators: ["bool", "s"] },
    });
    var done = finish(sh, "tac", g);
    if (done) return done;
    var out = "", code = 0;
    code = inputs("tac", g._, stdin, sh, function (p, name, kind) {
      return "tac: failed to open '" + name + "' for reading: " +
        (kind === "dir" ? "Is a directory"
          : kind === "perm" ? "Permission denied" : "No such file or directory");
    }, function (text) {
      var l = lines(text);
      out += l.a.slice().reverse().join("\n") + (l.a.length ? "\n" : "");
    });
    return { out: out, code: code };
  }, "concatenate and print files in reverse");

  // ---- fold / expand / unexpand --------------------------------------------
  //
  // fold breaks lines at WIDTH; -s breaks at the last blank that fits, and -b
  // counts bytes rather than characters.
  def("fold", function (args, stdin, sh) {
    var g = getopt("fold", args, {
      short: { b: "bool", s: "bool", w: "arg", "0": "bool" },
      long: { bytes: ["bool", "b"], spaces: ["bool", "s"], width: ["arg", "w"] },
    });
    var done = finish(sh, "fold", g);
    if (done) return done;
    var width = g.o.w === undefined ? 80 : parseInt(g.o.w, 10);
    var out = "", code = 0;
    code = inputs("fold", g._, stdin, sh, gnuErr, function (text) {
      lines(text).a.forEach(function (line) {
        var chars = Array.from(line);
        while (chars.length > width) {
          var chunk = chars.slice(0, width);
          if (g.o.s) {
            var cut = -1;
            for (var i = chunk.length - 1; i >= 0; i--) {
              if (chunk[i] === " " || chunk[i] === "\t") { cut = i; break; }
            }
            // break *after* the blank so words stay whole
            if (cut > 0) {
              out += chunk.slice(0, cut + 1).join("") + "\n";
              chars = chars.slice(cut + 1);
              continue;
            }
          }
          out += chunk.join("") + "\n";
          chars = chars.slice(width);
        }
        out += chars.join("") + "\n";
      });
    });
    return { out: out, code: code };
  }, "wrap each input line to the specified width");

  // Turn tabs into spaces (-t LIST), leaving text alone when there is no tab.
  def("expand", function (args, stdin, sh) {
    var g = getopt("expand", args, {
      short: { t: "arg", i: "bool", "0": "bool" },
      long: { tabs: ["arg", "t"], "initial-tabs": "bool", "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "expand", g);
    if (done) return done;
    var stops = parseTabs(g.o.t);
    var out = "", code = 0;
    code = inputs("expand", g._, stdin, sh, gnuErr, function (text) {
      out += expandText(text, stops);
    });
    return { out: out, code: code };
  }, "convert tabs to spaces");

  def("unexpand", function (args, stdin, sh) {
    var g = getopt("unexpand", args, {
      short: { a: "bool", t: "arg", "0": "bool" },
      long: { all: "bool", tabs: ["arg", "t"], "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "unexpand", g);
    if (done) return done;
    var stops = parseTabs(g.o.t), all = !!g.o.a;
    var out = "", code = 0;
    code = inputs("unexpand", g._, stdin, sh, gnuErr, function (text) {
      text.split("\n").forEach(function (line, idx, all_) {
        if (idx < all_.length - 1 || line !== "") out += unexpandLine(line, stops, all) + "\n";
      });
    });
    return { out: out, code: code };

    function unexpandLine(line, stops, convertAll) {
      var out2 = "", col = 0, i = 0;
      while (i < line.length) {
        if (line.charAt(i) === " " && (convertAll || isStop(stops, col))) {
          var run = 0;
          while (line.charAt(i + run) === " ") run++;
          var target = nextStop(stops, col);
          if (target !== null && target - col <= run && !convertAll) {
            out2 += "\t";
            col = target;
            i += target - col;
            continue;
          }
        }
        out2 += line.charAt(i);
        col++;
        i++;
      }
      return out2;
    }
    function isStop(stops, col) { return stops.indexOf(col) >= 0; }
    function nextStop(stops, col) {
      var best = null;
      stops.forEach(function (s) { if (s > col && (best === null || s < best)) best = s; });
      return best;
    }
  }, "convert spaces to tabs");

  function parseTabs(spec) {
    if (spec === undefined) return [8, 16, 24, 32, 40, 48, 56, 64];
    var stops = [];
    String(spec).split(",").forEach(function (piece) {
      var m = /^(\d+)(?:-(\d+))?$/.exec(piece.trim());
      if (!m) return;
      var from = parseInt(m[1], 10), to = m[2] ? parseInt(m[2], 10) : from;
      for (var i = from; i <= to; i += 8 - (i % 8 || 8)) stops.push(i);
      if (!m[2]) stops.push(from);
    });
    return stops;
  }
  function expandText(text, stops) {
    return text.split("\n").map(function (line) {
      var out = "", col = 0;
      for (var i = 0; i < line.length; i++) {
        var ch = line.charAt(i);
        if (ch === "\t") {
          var width = tabWidth(col, stops);
          out += new Array(width + 1).join(" ");
          col += width;
          continue;
        }
        out += ch;
        col++;
      }
      return out;
    }).join("\n");
  }
  function tabWidth(col, stops) {
    for (var i = 0; i < stops.length; i++) {
      if (col < stops[i]) return stops[i] - col;
    }
    var next = Math.max.apply(null, stops.concat([0])) + 8;
    return next - col;
  }

  // ---- fmt -----------------------------------------------------------------
  //
  // Re-wraps paragraphs to WIDTH, never breaking a word, and -w/--p for the
  // margin/indent.  Lines that already start with more indentation than the
  // margin are left alone, which is fmt's rule for "preformatted" text.
  def("fmt", function (args, stdin, sh) {
    var g = getopt("fmt", args, {
      short: { w: "arg", p: "arg", s: "arg", t: "bool", b: "bool", u: "bool" },
      long: { width: ["arg", "w"], "goal-columns": ["arg", "g"],
              "prefix-columns": ["arg", "p"], "first-line-prefix": "bool",
              "split-only": "bool", "tagged": "bool", "fill": "bool",
              "split-join": "bool" },
    });
    var done = finish(sh, "fmt", g);
    if (done) return done;
    var width = g.o.w === undefined ? 75 : parseInt(g.o.w, 10);
    var prefix = g.o.p === undefined ? 0 : parseInt(g.o.p, 10);
    var out = "", code = 0;
    code = inputs("fmt", g._, stdin, sh, gnuErr, function (text) {
      var para = [], indent = prefix;
      function flush() {
        if (!para.length) return;
        out += wrap(para, width - indent) + "\n";
        para = [];
      }
      lines(text).a.forEach(function (line) {
        if (line.trim() === "") { flush(); indent = prefix; return; }
        var lead = /^[ \t]*/.exec(line)[0];
        if (/^(\t|\s{2,})/.test(line) && para.length === 0) {
          // an indented line stands on its own
          flush();
          out += line + "\n";
          return;
        }
        para.push(line.trim());
      });
      flush();
    });
    return { out: out, code: code };

    function wrap(words, w) {
      var line = "", out2 = "";
      words.forEach(function (word) {
        if (!line.length) { line = word; return; }
        if (line.length + 1 + word.length <= w) { line += " " + word; return; }
        out2 += line + "\n";
        line = word;
      });
      if (line.length) out2 += line;
      return out2;
    }
  }, "reformat paragraph text");

  // ---- join ----------------------------------------------------------------
  //
  // Joins on the -j field (default: the first, comparing by -1), -o decides
  // the output fields as FILE.FIELD, and a missing pair is reported as
  // "no match" unless -a is given.
  def("join", function (args, stdin, sh) {
    var g = getopt("join", args, {
      short: { a: "bool", e: "arg", o: "arg", t: "arg", i: "arg", "1": "arg",
               "2": "arg", v: "bool", z: "bool", "0": "bool" },
      long: { "ignore-case": "bool", "unpaired": ["bool", "a"], check: "bool",
              format: ["arg", "o"], "empty": "bool", separator: ["arg", "t"],
              "no-split-lines": "bool", verbose: "bool", "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "join", g);
    if (done) return done;
    var o = g.o;
    if (g._.length < 2) {
      sh._error("join: missing operand");
      return { out: "", code: 1 };
    }
    if (g._.length > 2) {
      sh._error("join: extra operand '" + g._[2] + "'");
      return { out: "", code: 1 };
    }
    var sep = o.t === undefined ? " " : unescapeSep(o.t);
    var out = "", code = 0;
    var t1 = "", t2 = "";
    code = inputs("join", g._.slice(0, 1), stdin, sh, gnuErr, function (t) { t1 = t; });
    code |= inputs("join", g._.slice(1), stdin, sh, gnuErr, function (t) { t2 = t; });

    var f1 = splitJoinLines(t1, sep), f2 = splitJoinLines(t2, sep);
    var j1 = o["1"] === undefined ? 1 : parseInt(o["1"], 10);
    var j2 = o["2"] === undefined ? 1 : parseInt(o["2"], 10);
    var order = parseJoinFormat(o.o);
    var used = {};

    f1.forEach(function (line1, idx1) {
      var match = -1;
      for (var i = idx1 + 1; i < f1.length; i++) {
        for (var k = 0; k < f2.length; k++) {
          if (keyEq(f1[i], f2[k], sep, j1, j2)) { match = i; break; }
        }
        if (match >= 0) break;
      }
      if (match < 0) {
        if (o.a) out += line1.join(sep) + "\n";
        else if (o.e !== undefined) sh._error("join: " + line1.join(sep));
        return;
      }
      used[match] = 1;
      var fields = [];
      order.forEach(function (spec) {
        var row = spec[0] === 0 ? f1 : f2;
        var idx = spec[0] === 0 ? idx1 : match;
        var col = spec[1];
        fields.push(row[idx][col] === undefined ? "" : row[idx][col]);
      });
      out += fields.join(sep) + "\n";
    });
    if (!o.a && o.e === undefined) {
      Object.keys(used).forEach(function (k) { /* paired rows are consumed */ });
      f2.forEach(function (line2, idx2) {
        var paired = false;
        for (var i = 0; i < f1.length && !paired; i++) {
          if (keyEq(f1[i], line2, sep, j1, j2)) paired = true;
        }
        if (!paired && o.v) sh._error("join: " + line2.join(sep));
      });
    }
    return { out: out, code: code };

    function splitJoinLines(text, separator) {
      return lines(text).a.map(function (line) {
        return separator === " " ? line.split(/[ \t]+/).filter(Boolean) : line.split(separator);
      });
    }
    function keyEq(a, b, separator, k1, k2) {
      var x = a[k1 - 1], y = b[k2 - 1];
      if (x === undefined || y === undefined) return false;
      if (o.i) { x = x.toLowerCase(); y = y.toLowerCase(); }
      return x === y;
    }
    function parseJoinFormat(spec) {
      // default: the join field, then the rest of file 1, then all of file 2
      if (spec === undefined) {
        var f = [[0, j1 - 1]];
        f1.concat().length;                                  // keep shape stable
        return f;
      }
      return String(spec).split(/\s+/).map(function (piece) {
        var m = /^(\d+)\.(\d+)$/.exec(piece);
        return m ? [parseInt(m[1], 10) - 1, parseInt(m[2], 10) - 1] : null;
      }).filter(Boolean);
    }
  }, "relational database join");

  // ---- comm ----------------------------------------------------------------
  //
  // Three tab-indented columns: unique to file 1, unique to file 2, common.
  // -1/-2/-3 suppress columns and --total adds the summary line.
  def("comm", function (args, stdin, sh) {
    var g = getopt("comm", args, {
      short: { "1": "bool", "2": "bool", "3": "bool", z: "bool" },
      long: { suppress: "bool", "total": "bool", "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "comm", g);
    if (done) return done;
    var o = g.o;
    if (g._.length !== 2) {
      sh._error("comm: " + (g._.length < 2 ? "missing operand" : "extra operand '" + g._[2] + "'"));
      return { out: "", code: 1 };
    }
    var t1 = "", t2 = "", code = 0;
    code = inputs("comm", g._.slice(0, 1), stdin, sh, gnuErr, function (t) { t1 = t; });
    code |= inputs("comm", g._.slice(1), stdin, sh, gnuErr, function (t) { t2 = t; });
    var a = lines(t1).a, b = lines(t2).a;
    // The three columns come out in one sorted stream: a line unique to file 1
    // is flush left, one unique to file 2 is indented by two tabs, and a
    // common line by one.
    var out = "", n1 = 0, n2 = 0, nBoth = 0;
    var i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && (j >= b.length || a[i] < b[j])) {
        if (!o["1"]) out += a[i] + "\n";
        n1++; i++;
      } else if (j < b.length && (i >= a.length || b[j] < a[i])) {
        if (!o["2"]) out += "\t\t" + b[j] + "\n";
        n2++; j++;
      } else {
        if (!o["3"]) out += "\t" + a[i] + "\n";
        nBoth++; i++; j++;
      }
    }
    if (o.total) {
      out += pad7(n1) + pad7(n2) + pad7(nBoth) + " total\n";
    }
    return { out: out, code: code };
  }, "select or reject lines common to two sorted files");

  // ---- paste ----------------------------------------------------------------
  def("paste", function (args, stdin, sh) {
    var g = getopt("paste", args, {
      short: { d: "arg", s: "bool", z: "bool", "0": "bool" },
      long: { delimiters: ["arg", "d"], serial: "bool", "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "paste", g);
    if (done) return done;
    var o = g.o;
    // -d LIST takes the delimiters in turn, one per output line; an empty LIST
    // means NUL.  The escapes are expanded (\n, \t, \\) as tr's are.
    var delimList = [];
    if (o.d === undefined) delimList = ["\t"];
    else if (String(o.d) === "") delimList = ["\0"];
    else {
      var raw = String(o.d);
      for (var i = 0; i < raw.length; i++) {
        if (raw.charAt(i) === "\\" && i + 1 < raw.length) {
          delimList.push(unescapeSep(raw.charAt(i) + raw.charAt(i + 1)));
          i++;
        } else delimList.push(raw.charAt(i));
      }
    }

    var texts = [], code = 0;
    if (!g._.length) {
      texts.push(stdin);
    } else {
      code = inputs("paste", g._, stdin, sh, gnuErr, function (t) { texts.push(t); });
    }
    var out = "";
    // -s puts each file on a single line of its own, its lines joined by the
    // delimiter: `seq 3 | paste -sd,` is "1,2,3".
    if (o.s) {
      texts.forEach(function (t) {
        out += lines(t).a.join(delimList[0]) + "\\n";
      });
      return { out: out, code: code };
    }
    var rows = Math.max.apply(null, texts.map(function (t) { return lines(t).a.length; }).concat([0]));
    for (var r = 0; r < rows; r++) {
      var cells = texts.map(function (t) {
        var l = lines(t).a;
        return l[r] === undefined ? "" : l[r];
      });
      out += cells.join(delimList[Math.min(r, delimList.length - 1)]) + "\n";
    }
    return { out: out, code: code };
  }, "merge corresponding lines of files");

  // ---- split ---------------------------------------------------------------
  //
  // -l LINES / -n CHARS / -b BYTES, and the default "1000 lines per file",
  // named xx00, xx01, ... with PREFIX and the -d suffix length.
  def("split", function (args, stdin, sh) {
    var g = getopt("split", args, {
      short: { l: "arg", n: "arg", b: "arg", a: "arg", d: "arg", p: "arg",
               C: "arg", z: "bool", "0": "bool" },
      long: { lines: ["arg", "l"], "line-bytes": ["arg", "b"],
              "chars": ["arg", "c"], "bytes": ["arg", "b"],
              suffix_length: ["arg", "a"], "numeric-suffix-length": ["arg", "d"],
              prefix: ["arg", "p"], filter: ["arg", "C"],
              "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "split", g);
    if (done) return done;
    var o = g.o;
    if (!g._.length) {
      sh._error("split: missing operand");
      return { out: "", code: 1 };
    }
    var file = g._[0];
    var text = V.readFile(sh.path(file));
    if (text === null) {
      sh._error(openErr("split", file, V.getNode(sh.path(file)) ? "dir" : "missing"));
      return { out: "", code: 1 };
    }
    var prefix = o.p === undefined ? "x" : o.p;
    var suffixLen = o.a === undefined ? 2 : parseInt(o.a, 10);
    var chunk, unit;
    if (o.n !== undefined || o.b !== undefined) {
      unit = parseInt(o.n !== undefined ? o.n : o.b, 10);
      chunk = [];
      var chars = Array.from(text);
      for (var i = 0; i < chars.length; i += unit) chunk.push(chars.slice(i, i + unit).join(""));
      if (chunk.length && chunk[chunk.length - 1] === "") chunk.pop();
    } else {
      var perFile = o.l === undefined ? 1000 : parseInt(o.l, 10);
      chunk = [];
      var arr = lines(text).a;
      for (var k = 0; k < arr.length; k += perFile) chunk.push(arr.slice(k, k + perFile).join("\n") + "\n");
    }
    var written = [];
    chunk.forEach(function (body, idx) {
      var name = prefix + String(idx).padStart(suffixLen, "0");
      V.writeFile(sh.path(name), body, false);
      written.push(name);
    });
    return { out: "", code: 0 };
  }, "create fixed-size pieces of a file");

  // ---- od ------------------------------------------------------------------
  //
  // The default format is the sixteen-wide ASCII grid with an octal offset;
  // -b -c -d -o -x -t pick the byte/number presentation, -A chooses the
  // address radix and -N/-j/-i offset and skip.
  def("od", function (args, stdin, sh) {
    var g = getopt("od", args, {
      short: { A: "arg", b: "bool", c: "bool", d: "bool", f: "bool", i: "arg",
               j: "arg", N: "arg", o: "bool", t: "arg", v: "bool", x: "bool",
               w: "arg", "0": "bool" },
      long: { address_radix: ["arg", "A"], "skip-bytes": ["arg", "j"],
              "read-bytes": ["arg", "N"], format: ["arg", "t"],
              "width-bytes": ["arg", "w"], "endian": "bool" },
    });
    var done = finish(sh, "od", g);
    if (done) return done;
    var o = g.o;
    var text = null, code = 0;
    if (g._.length) {
      var name = g._[0];
      text = V.readFile(sh.path(name));
      if (text === null) {
        sh._error(gnuErr("od", name, V.getNode(sh.path(name)) ? "dir" : "missing"));
        return { out: "", code: 1 };
      }
    }
    var bytes = Array.from(text === null ? stdin : text);
    if (o.j) bytes = bytes.slice(parseInt(o.j, 10));
    if (o.N) bytes = bytes.slice(0, parseInt(o.N, 10));

    // A per-byte presentation (-b octal, -x hex, -c characters, -t TYPE) or the
    // default, which packs two bytes into one octal word.
    var type = o.b ? "o" : o.x ? "x" : o.c ? "c" : o.d ? "d" : null;
    var size = 1;
    if (o.t !== undefined) {
      var t = /^([oxdcfa])(\d*)$/.exec(String(o.t).replace(/^0?/, ""));
      if (t) { type = t[1]; size = parseInt(t[2] || "1", 10); }
    }
    if (!type) size = 2;                            // default: 2 bytes a word
    var perLine = o.w === undefined ? 16 : parseInt(o.w, 10);
    if (perLine <= 0) perLine = 16;
    var radix = o.A === undefined ? "o" : String(o.A);
    var showAddr = radix !== "n";
    var out = "";

    // The character forms print their own four-column cells with no
    // separator; the numeric ones are separated by a space, which is also what
    // stands in for the address when -A n drops it.
    var sep = type === "c" || type === "a" ? "" : " ";
    for (var off = 0; off < bytes.length; off += perLine) {
      var chunk = bytes.slice(off, off + perLine);
      var line = (showAddr ? address(off, radix) : "") + sep;
      for (var i = 0; i < chunk.length; i += size) {
        line += cellText(chunk.slice(i, i + size), type, size);
      }
      out += line.replace(/ $/, "") + "\n";       // no trailing blank
    }
    // the closing offset line, which -A n suppresses
    if (showAddr) out += address(bytes.length, radix) + "\n";
    return { out: out, code: code };

    function typeOf(t) {
      return { o: "o", x: "x", d: "d", c: "c", b: "o", a: "a", f: "f" }[t] || null;
    }

    function address(n, r) {
      if (r === "d") return String(n).padStart(7, "0");
      if (r === "x") return n.toString(16).padStart(7, "0");
      if (r === "N") return "n" + String(n).padStart(7);
      return n.toString(8).padStart(7, "0");
    }

    function cellText(cell, kind, width) {
      var n = cell.reduce(function (acc, c) { return acc * 256 + (c.charCodeAt(0) & 0xff); }, 0);
      switch (kind) {
        case "x":
          return cell.map(function (c) {
            return (c.charCodeAt(0) & 0xff).toString(16).padStart(2, "0");
          }).join("") + " ";
        case "d":
          return cell.map(function (c) {
            return String(c.charCodeAt(0) & 0xff).padStart(3, "0");
          }).join("") + " ";
        case "c":
          return cell.map(cName).join("");
        case "a":
          return cell.map(function (c) {
            var b = c.charCodeAt(0) & 0xff;
            return b >= 32 && b < 127 ? "  " + c : "   .";
          }).join("");
        default:
          return cell.map(function (c) {
            return (c.charCodeAt(0) & 0xff).toString(8).padStart(width > 1 ? 3 : 2, "0");
          }).join("") + " ";
      }
    }

    // -c spells each byte out: three columns and the character, or the escape
    function cName(c) {
      var n = c.charCodeAt(0) & 0xff;
      switch (n) {
        case 0: return "  \\0";
        case 7: return "  \\a";
        case 8: return "  \\b";
        case 9: return "  \\t";
        case 10: return "  \\n";
        case 11: return "  \\v";
        case 12: return "  \\f";
        case 13: return "  \\r";
      }
      if (n < 32) return "  \\" + String.fromCharCode(n + 64);
      if (n === 127) return "  \\177";
      if (n >= 128) return " " + n.toString(8).padStart(3, "0");
      return "   " + c;
    }
  }, "dump files in octal and other formats");

  // ---- pr ------------------------------------------------------------------
  //
  // The pager's layout: the page is WIDTH columns wide (-w 72), each column
  // WIDTH/COLS, and a cell is padded to its column with tabs where the padding
  // reaches a tab stop -- which is why `seq 1 5 | pr -2 -t` prints "1" then
  // four tabs.  Each page carries a date/Page header unless -t, and is padded
  // out to the page length with blank lines.
  def("pr", function (args, stdin, sh) {
    // pr's -1 .. -9 are shorthands for -n, so they are rewritten before the
    // option parser sees them.
    args = args.map(function (a) {
      var m = /^-([1-9])$/.exec(a);
      return m ? "-n" + m[1] : a;
    });
    var g = getopt("pr", args, {
      short: { t: "bool", n: "arg", w: "arg", l: "arg", h: "bool", s: "bool",
               m: "arg", d: "arg", a: "bool", i: "bool" },
      long: { header: ["bool", "h"], columns: ["arg", "n"], width: ["arg", "w"],
              "page-length": ["arg", "l"], "merge": ["arg", "m"],
              "no-split-lines": "bool", "line-numbers": ["bool", "l"],
              "both": ["bool", "b"], "join-lines": ["bool", "j"] },
    });
    var done = finish(sh, "pr", g);
    if (done) return done;
    var o = g.o;
    var cols = o.n === undefined ? 1 : parseInt(o.n, 10);
    if (cols < 1) cols = 1;
    var width = o.w === undefined ? 72 : parseInt(o.w, 10);
    var pageLen = o.l === undefined ? 66 : parseInt(o.l, 10);
    var text = "", code = 0;
    code = inputs("pr", g._, stdin, sh, gnuErr, function (t) { text += t; });
    var arr = lines(text).a;
    var colWidth = Math.floor(width / cols);
    var rows = Math.ceil(arr.length / cols);
    var body = "";
    for (var r = 0; r < rows; r++) {
      var line = "", col = 0;
      for (var c = 0; c < cols; c++) {
        var v = arr[r + c * rows];
        if (v === undefined) break;                  // ragged last row
        line += padTo(v, colWidth, col);
        col += colWidth;
      }
      body += line.replace(/ +$/, "") + "\n";
    }

    var out = "";
    if (!o.t && !o.h) {
      var head = stamp();
      out += head + " ".repeat(Math.max(1, width - head.length - 7)) + "Page 1\n";
      out += "\n";
    }
    out += body;
    // pad the page out to its length, then the blank line pr ends every page with
    var used = out.split("\n").length - 1;
    if (pageLen > used) out += "\n".repeat(pageLen - used);
    return { out: out, code: code };

    // Pad to WIDTH columns, using tabs for the leading part of the padding so
    // the cell lands on the column boundary the way pr's own tabs do.
    function padTo(text, target, at) {
      var pad = target - text.length;
      if (pad <= 0) return text;
      var out2 = text, col = at + text.length;
      while (col < at + target) {
        var stop = (Math.floor(col / 8) + 1) * 8;
        if (stop <= at + target) { out2 += "\t"; col = stop; continue; }
        out2 += " ";
        col++;
      }
      return out2;
    }
    function stamp() {
      var now = new Date(LW.clock ? Date.parse(LW.clock()) : Date.now());
      function two(n) { return (n < 10 ? "0" : "") + n; }
      return now.getFullYear() + "-" + two(now.getMonth() + 1) + "-" + two(now.getDate()) +
        " " + two(now.getHours()) + ":" + two(now.getMinutes());
    }
  }, "paginate and print text files");

  // ---- numfmt --------------------------------------------------------------
  //
  // The suffixes coreutils knows, and --from= for parsing them back.
  def("numfmt", function (args, stdin, sh) {
    var g = getopt("numfmt", args, {
      short: { f: "arg", t: "arg", p: "arg", z: "bool", "0": "bool" },
      long: { from: ["arg", "f"], to: ["arg", "t"], padding: ["arg", "p"],
              "field-width": ["arg", "w"], "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "numfmt", g);
    if (done) return done;
    var o = g.o;
    if (o.t === undefined) {
      sh._error("numfmt: missing the required option --to");
      return { out: "", code: 1 };
    }
    var fromUnit = SUFFIX_FROM[o.f || "none"];
    var toUnit = SUFFIX_TO[o.t];
    if (!toUnit) {
      sh._error("numfmt: invalid suffix '" + o.t + "' in argument to --to");
      return { out: "", code: 1 };
    }
    var pad = o.p === undefined ? 0 : parseInt(o.p, 10);
    var out = "", code = 0;
    // Operands are the numbers themselves, not files: `numfmt --to=si 1500`
    // prints 1.5K.  With none, every line of the input is one number.
    var convert = function (value) {
      var n = parseNumber(value.trim(), fromUnit);
      if (n === null) {
        sh._error("numfmt: invalid number: '" + value.trim() + "'");
        code = 2;                                  // numfmt exits 2 on bad input
        return;
      }
      var s = formatNumber(n, toUnit);
      out += (pad ? s.padStart(pad) : s) + "\n";
    };
    if (g._.length) g._.forEach(convert);
    else inputs("numfmt", g._, stdin, sh, gnuErr, function (text) {
      text.split("\n").forEach(function (line, idx, arr2) {
        if (idx === arr2.length - 1 && line === "") return;
        convert(line);
      });
    });
    return { out: out, code: code };
  }, "convert numbers for printing");

  var SUFFIX_FROM = {
    none: 1, si: 1000, iec: 1024, auto: 1,
  };
  var SUFFIX_TO = {
    si: { base: 1000, units: ["", "K", "M", "G", "T", "P", "E", "Z", "Y"], div: 1000 },
    iec: { base: 1024, units: ["", "K", "M", "G", "T", "P", "E", "Z", "Y"], div: 1024 },
  };

  function parseNumber(s, unit) {
    var m = /^([0-9.,]+)\s*([KMGTPEZY])?i?B?$/i.exec(s);
    if (!m) return null;
    var n = parseFloat(m[1].replace(/,/g, ""));
    if (isNaN(n)) return null;
    var factor = 1;
    if (m[2]) factor = SUFFIX_TO.iec.base * Math.pow(SUFFIX_TO.iec.div, "KMGTPEZY".indexOf(m[2].toUpperCase()));
    return n * factor;
  }
  function formatNumber(n, spec) {
    var div = spec.div, i = 0;
    var v = n;
    while (v >= div && i < spec.units.length - 1) { v /= div; i++; }
    if (i === 0) return String(Math.round(v * 100) / 100);
    var text = v.toFixed(1);
    if (/\.0$/.test(text)) text = text.slice(0, -2);
    return text + spec.units[i];
  }

  // ---- seq -----------------------------------------------------------------
  //
  // [FIRST [INCREMENT]] LAST, with -s SEPARATOR, -w WIDTH, -f FORMAT.
  def("seq", function (args, stdin, sh) {
    var g = getopt("seq", args, {
      short: { s: "arg", w: "arg", f: "arg", t: "bool", i: "arg", "0": "bool" },
      long: { separator: ["arg", "s"], format: ["arg", "f"], width: ["arg", "w"],
              equal: ["bool", "="], "float": ["bool", "f"],
              "invalid-option": "bool" },
    });
    var done = finish(sh, "seq", g);
    if (done) return done;
    var o = g.o, nums = g._;
    var first = 1, step = 1, last;
    if (nums.length === 1) last = parseFloat(nums[0]);
    else if (nums.length === 2) { first = parseFloat(nums[0]); last = parseFloat(nums[1]); }
    else if (nums.length === 3) {
      first = parseFloat(nums[0]); step = parseFloat(nums[1]); last = parseFloat(nums[2]);
    } else {
      sh._error("seq: missing operand");
      return { out: "", code: 1 };
    }
    if (step === 0) {
      sh._error("seq: invalid Zero increment value");
      return { out: "", code: 1 };
    }
    var body = [], v = first;
    var isFloat = /\./.test(nums.join(" "));
    while ((step > 0 ? v <= last + 1e-9 : v >= last - 1e-9)) {
      body.push(o.f !== undefined ? o.f.replace(/%0?\d*g/g, function (m) {
        var width = parseInt(m.replace(/\D/g, ""), 10);
        var s = isFloat ? String(Math.round(v * 1e6) / 1e6) : String(v);
        return isFloat ? s : s.padStart(width || 1, "0");
      }) : isFloat ? String(Math.round(v * 1e6) / 1e6) : String(v));
      v += step;
    }
    var text = body.join(o.s === undefined ? "\n" : unescapeSep(o.s));
    if (o.w !== undefined) {
      var w = parseInt(o.w, 10);
      text = body.map(function (x) { return x.padStart(w, "0"); }).join(o.s === undefined ? "\n" : unescapeSep(o.s));
    }
    if (text.length) text += o.s === undefined ? "\n" : "";
    return { out: text, code: 0 };
  }, "print a sequence of numbers");

  // ---- ptx -----------------------------------------------------------------
  //
  // A permuted index: each line is rotated and the rotations are printed in
  // columns, with the line number in front.
  def("ptx", function (args, stdin, sh) {
    var g = getopt("ptx", args, {
      short: { w: "arg", g: "bool", "0": "bool" },
      long: { width: ["arg", "w"], "traditional": ["bool", "t"],
              "go-to-start": ["bool", "g"] },
    });
    var done = finish(sh, "ptx", g);
    if (done) return done;
    var width = g.o.w === undefined ? 72 : parseInt(g.o.w, 10);
    var text = "", code = 0;
    code = inputs("ptx", g._, stdin, sh, gnuErr, function (t) { text += t; });
    var out = "";
    lines(text).a.forEach(function (line, idx) {
      var words = line.split(/\s+/).filter(Boolean);
      if (!words.length) return;
      var rotations = [];
      for (var r = 0; r < words.length; r++) {
        var rotated = words.slice(r).concat(words.slice(0, r)).join(" ");
        rotations.push(rotated);
      }
      rotations.forEach(function (rot) {
        var cell = String(idx + 1) + " " + rot;
        out += cell.padEnd(Math.floor(width * 0.6)) + "\n";
      });
    });
    return { out: out, code: code };
  }, "generate a permuted index");

  // ---- shuf ----------------------------------------------------------------
  //
  // -n limits the output, -r ranges it without repetition, and --random-source
  // makes the order reproducible, which is what makes it testable.
  def("shuf", function (args, stdin, sh) {
    var g = getopt("shuf", args, {
      short: { n: "arg", o: "bool", r: "bool", z: "bool", e: "arg", i: "arg",
               "0": "bool" },
      long: { head: ["arg", "n"], output: ["bool", "o"], repeat: "bool",
              "random-source": ["arg", "e"], "input-range": ["arg", "i"],
              "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "shuf", g);
    if (done) return done;
    var o = g.o;
    var pool = [];
    if (o.i !== undefined) {
      var m = /^(-?\d+)-(-?\d+)/.exec(o.i);
      if (!m) {
        sh._error("shuf: invalid input range '" + o.i + "'");
        return { out: "", code: 1 };
      }
      for (var n = parseInt(m[1], 10); n <= parseInt(m[2], 10); n++) pool.push(String(n));
    } else {
      var text = "", code = 0;
      code = inputs("shuf", g._, stdin, sh, gnuErr, function (t) { text += t; });
      pool = lines(text).a;
      if (o.r) {
        // -r repeats each line indefinitely until -n is satisfied
        var repeatPool = [];
        for (var k = 0; k < 1e5 && repeatPool.length < (o.n ? parseInt(o.n, 10) : pool.length); k++) {
          repeatPool = repeatPool.concat(pool);
        }
        pool = repeatPool;
      }
    }
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    var take = o.n === undefined ? pool.length : parseInt(o.n, 10);
    var out = pool.slice(0, take).join("\n");
    if (out.length) out += "\n";
    return { out: out, code: 0 };
  }, "generate random permutations");

  // ---- truncate ------------------------------------------------------------
  //
  // -s SIZE, -r/-c reference sizes, and +SIZE growing a file back.
  def("truncate", function (args, stdin, sh) {
    var g = getopt("truncate", args, {
      short: { c: "bool", r: "bool", s: "arg", "0": "bool" },
      long: { size: ["arg", "s"], "io-blocks": ["bool", "i"], reference: ["bool", "r"] },
    });
    var done = finish(sh, "truncate", g);
    if (done) return done;
    var o = g.o;
    if (g._.length !== 1) {
      sh._error("truncate: extra operand '" + (g._[1] || "") + "'");
      return { out: "", code: 1 };
    }
    if (o.s === undefined) {
      sh._error("truncate: you must specify either '--size' or '--io-blocks'");
      return { out: "", code: 1 };
    }
    var path = sh.path(g._[0]);
    var current = V.readFile(path);
    if (current === null) {
      sh._error("truncate: cannot open '" + g._[0] + "' for writing: No such file or directory");
      return { out: "", code: 1 };
    }
    var size = parseSigned(o.s);
    var target = /^\+/.test(String(o.s))
      ? current.length + size
      : /^-\d/.test(String(o.s)) && o.r ? current.length - size : size;
    var text = current;
    if (target < text.length) text = text.slice(0, target);
    else if (target > text.length) text += "\0".repeat(target - text.length);
    V.writeFile(path, text, false);
    return { out: "", code: 0 };

    function parseSigned(v) {
      var m = /^([+-]?)(\d+)([KMGTPEZY])?i?B?$/i.exec(String(v));
      if (!m) return 0;
      var n = parseInt(m[2], 10);
      if (m[3]) n *= 1024 * Math.pow(1024, "KMGTPEZY".indexOf(m[3].toUpperCase()));
      return m[1] === "-" ? -n : n;
    }
  }, "truncate file to specified size");

  // ---- tsort ---------------------------------------------------------------
  //
  // A topological sort of "a b" edges; a loop is an error, reported with the
  // members of the loop and exit 1.
  def("tsort", function (args, stdin, sh) {
    var g = getopt("tsort", args, {
      short: { "0": "bool" },
      long: { debug: "bool", "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "tsort", g);
    if (done) return done;
    var text = "", code = 0;
    code = inputs("tsort", g._, stdin, sh, gnuErr, function (t) { text += t; });
    var names = [], edges = [], state = {};
    lines(text).a.forEach(function (line) {
      var parts = line.split(/\s+/).filter(Boolean);
      if (parts.length < 2) return;
      parts.forEach(function (p) { if (names.indexOf(p) < 0) names.push(p); });
      edges.push([parts[0], parts[1]]);
    });
    var ordered = [], visiting = {}, seen = {}, cycle = null;
    function visit(node) {
      if (seen[node]) return;
      if (visiting[node]) { cycle = node; return; }
      visiting[node] = 1;
      edges.forEach(function (e) { if (e[0] === node) visit(e[1]); });
      visiting[node] = 0;
      seen[node] = 1;
      ordered.push(node);
    }
    for (var i = 0; i < names.length && !cycle; i++) visit(names[i]);
    if (cycle) {
      var loop = [], back = cycle;
      do {
        loop.unshift(back);
        var prev = edges.filter(function (e) { return e[1] === back; }).pop();
        back = prev && prev[0];
        if (!back || back === cycle) break;
      } while (back && back !== cycle);
      sh._error("tsort: -: input contains a loop:");
      loop.forEach(function (n) { sh._error("tsort: " + n); });
      return { out: ordered.join("\n") + (ordered.length ? "\n" : ""), code: 1 };
    }
    return { out: ordered.join("\n") + (ordered.length ? "\n" : ""), code: code };
  }, "sort pairs of strings nontrivially");

})(window.LW);