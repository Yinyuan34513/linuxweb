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
  var usage = LW.core.usage;

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
    // Only the unfiltered, stdin-reading layout pads to seven columns.  With
    // real operands the numbers share one width -- the number of digits in the
    // largest byte count -- but a lone standard input has nothing to line up
    // with, so it is not padded at all: `seq 1 5 | wc -l` is "5".
    var plain = keys.length === 3 && keys[0] === "lines";
    var allStdin = rows.every(function (r) { return r.name === null || r.name === "-"; });
    var width = 1;
    if (sawStdin && plain) width = 7;
    else if (!allStdin) {
      width = String(Math.max.apply(null,
        rows.concat([totals]).map(function (r) { return r.bytes; }))).length;
    }
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
    // sort reports a bad operand with status 2, like a usage error
    code = inputs("sort", g._, stdin, sh, function (p, name, kind) {
      return "sort: cannot read: " + name + ": " +
        (kind === "dir" ? "Is a directory"
          : kind === "perm" ? "Permission denied" : "No such file or directory");
    }, function (t) { text += t; });
    if (code) code = 2;

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
      var va = keyText(a, key), vb = keyText(b, key);
      if (key.ignoreBlanks) {
        va = va.replace(/^[ \t]+/, ""); vb = vb.replace(/^[ \t]+/, "");
      }
      var r;
      switch (key.type) {
        case "n": r = numCompare(va, vb); break;
        case "g": r = floatCompare(va, vb); break;
        case "h": r = humanCompare(va, vb); break;
        case "V": r = versionCompare(va, vb); break;
        case "b": r = foldCompare(va, vb); break;
        default: r = strCompare(va, vb);
      }
      return key.reverse ? -r : r;
    }

    // The field spans of a line as [start, end) offsets.  With no -t the
    // fields are runs of non-blanks and the blanks between them trail the
    // field before, which is what makes `sort -k2` start at the first letter
    // rather than at the blank in front of it.
    function fieldSpans(line) {
      var out = [], i = 0;
      if (sep) {
        var start = 0;
        for (;;) {
          var at = line.indexOf(sep, i);
          if (at < 0) { out.push([start, line.length]); break; }
          out.push([start, at]);
          start = at + sep.length;
          i = start;
        }
        return out;
      }
      while (i < line.length) {
        while (i < line.length && /\s/.test(line.charAt(i))) i++;
        if (i >= line.length) break;
        var s0 = i;
        while (i < line.length && !/\s/.test(line.charAt(i))) i++;
        out.push([s0, i]);
        while (i < line.length && /\s/.test(line.charAt(i))) i++;   // blanks trail
      }
      return out;
    }

    // -k names a *span*: from the start of the first field (plus any .CHAR
    // offset) to the end of the last one, which is not the same as either
    // field on its own.
    function keyText(line, key) {
      var f = fieldSpans(line);
      var from = key.from - 1;
      if (from < 0) from = 0;
      if (from >= f.length) return "";
      var start = f[from][0] + key.fromChar;
      var end;
      if (key.to === undefined) end = line.length;
      else {
        var to = Math.min(key.to - 1, f.length - 1);
        end = key.toChar ? f[to][0] + key.toChar : f[to][1];
      }
      return line.slice(start, Math.max(start, end));
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

    // -k takes FIELD[.CHAR][OPTS][, FIELD[.CHAR][OPTS]]; several keys may be
    // given as one newline-separated string.
    function parseKeys(spec) {
      if (spec === undefined) return [];
      return String(spec).split("\n").filter(Boolean).map(function (one) {
        var key = { from: 1, fromChar: 0, to: undefined, toChar: 0, type: "s", ignoreBlanks: !!o.b };
        String(one).split(",").forEach(function (piece, i) {
          piece = piece.trim();
          if (!piece) return;
          var m = /^(\d+)(?:\.(\d+))?(.*)$/.exec(piece);
          if (!m) return;
          var num = parseInt(m[1], 10), ch = m[2] ? parseInt(m[2], 10) : 0;
          if (i === 0) { key.from = num; key.fromChar = ch; }
          else { key.to = num; key.toChar = ch; }
          var opts = m[3] || "";
          if (opts.indexOf("b") >= 0) key.ignoreBlanks = true;
          if (opts.indexOf("n") >= 0) key.type = "n";
          else if (opts.indexOf("g") >= 0) key.type = "g";
          else if (opts.indexOf("h") >= 0) key.type = "h";
          else if (opts.indexOf("V") >= 0) key.type = "V";
          else if (opts.indexOf("r") >= 0) key.reverse = true;
          else if (opts.indexOf("f") >= 0) { key.to = key.from; key.toChar = ch; }
        });
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
      return usage(sh, "tr", sets.length ? "extra operand '" + sets[2] + "'"
        : "missing operand");
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
      return usage(sh, "cut", "you must specify a list of bytes, characters, or fields");
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
    // --complement prints everything the list leaves out.  An open-ended
    // range reaches the end of the line, so the upper bound stays huge.
    function ranges(l, comp) {
      if (!comp) return l;
      var keep = [], next = 1;
      l.slice().sort(function (a, b) { return a[0] - b[0]; }).forEach(function (r) {
        if (r[0] > next) keep.push([next, r[0] - 1]);
        next = Math.max(next, r[1] === 1e9 ? 1e9 : r[1] + 1);
      });
      if (next <= 1e9) keep.push([next, 1e9]);          // everything after the last
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
        if (body === "n") { if (line !== "") number = String(start++); }
        else number = String(start++);
        // an unnumbered line still occupies the number field, in blanks
        out += number
          ? number.padStart(width) + sep + line + "\n"
          : " ".repeat(width + 1) + line + "\n";
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
        line.trim().split(/\s+/).forEach(function (word) {
          if (word) para.push(word);
        });
      });
      flush();
    });
    return { out: out, code: code };

    // Fill to the width, then pull words back if that left the last line
    // shorter than a quarter of it: `fmt -w 20` of five words gives
    // "aaaa bbbb cccc" / "dddd eeee" rather than leaving "eeee" alone.
    function wrap(words, w) {
      var lines2 = [], line = "";
      words.forEach(function (word) {
        if (!line.length) { line = word; return; }
        if (line.length + 1 + word.length <= w) { line += " " + word; return; }
        lines2.push(line);
        line = word;
      });
      if (line.length) lines2.push(line);
      while (lines2.length > 1) {
        var last = lines2[lines2.length - 1];
        if (last.length >= Math.floor(w / 4)) break;
        var prev = lines2[lines2.length - 2];
        var cut = prev.lastIndexOf(" ");
        if (cut < 0) break;
        lines2[lines2.length - 2] = prev.slice(0, cut);
        lines2[lines2.length - 1] = prev.slice(cut + 1) + " " + last;
      }
      return lines2.join("\n");
    }
  }, "reformat paragraph text");

  // ---- join ----------------------------------------------------------------
  //
  // Joins two files on a field: -j FIELD for both, -1/-2 to choose separately.
  // The default output is the join field, then the rest of file 1, then all of
  // file 2 -- and -o FILE.FIELD picks the fields explicitly.  -a prints the
  // unpaired lines too, -v only those.
  def("join", function (args, stdin, sh) {
    var g = getopt("join", args, {
      short: { a: "bool", e: "arg", j: "arg", o: "arg", t: "arg", i: "arg",
               "1": "arg", "2": "arg", v: "bool", z: "bool", "0": "bool" },
      long: { "ignore-case": "bool", unpaired: ["bool", "a"], check: "bool",
              format: ["arg", "o"], empty: "bool", separator: ["arg", "t"],
              "no-split-lines": "bool", verbose: "bool",
              "zero-terminated": ["bool", "z"] },
    });
    var done = finish(sh, "join", g);
    if (done) return done;
    var o = g.o;
    if (g._.length < 2) {
      return usage(sh, "join", g._.length
        ? "missing operand after '" + g._[0] + "'"
        : "missing operand");
    }
    if (g._.length > 2) return usage(sh, "join", "extra operand '" + g._[2] + "'");

    var sep = o.t === undefined ? " " : unescapeSep(o.t);
    var j1 = parseInt(o["1"] === undefined ? (o.j === undefined ? 1 : o.j) : o["1"], 10);
    var j2 = parseInt(o["2"] === undefined ? (o.j === undefined ? 1 : o.j) : o["2"], 10);
    var t1 = "", t2 = "", code = 0;
    code = inputs("join", g._.slice(0, 1), stdin, sh, gnuErr, function (t) { t1 = t; });
    code |= inputs("join", g._.slice(1), stdin, sh, gnuErr, function (t) { t2 = t; });
    var rows1 = splitFields(t1), rows2 = splitFields(t2);
    var format = parseFormat(o.o, j1);

    var out = "", used2 = {}, i, k;
    for (i = 0; i < rows1.length; i++) {
      var line1 = rows1[i], match = -1;
      for (k = 0; k < rows2.length; k++) {
        if (keyEq(line1, rows2[k], j1, j2)) { match = k; break; }
      }
      if (match < 0) {
        if (o.a) out += line1.join(sep) + "\n";
        else if (o.v) out += line1.join(sep) + "\n";
        if (o.v) sh._error("join: " + line1.join(sep));
        continue;
      }
      used2[match] = true;
      if (!o.v) out += emit(format, line1, rows2[match], sep) + "\n";
    }
    if (o.v || o.a2) {
      for (k = 0; k < rows2.length; k++) {
        if (used2[k]) continue;
        if (o.a) out += rows2[k].join(sep) + "\n";
        if (o.v) {
          out += rows2[k].join(sep) + "\n";
          sh._error("join: " + rows2[k].join(sep));
        }
      }
    }
    return { out: out, code: code };

    function splitFields(text) {
      return lines(text).a.map(function (line) {
        if (sep === " ") return line.split(/[ \t]+/).filter(function (x) { return x !== ""; });
        return line.split(sep);
      });
    }
    function keyEq(a, b, k1, k2) {
      var x = a[k1 - 1], y = b[k2 - 1];
      if (x === undefined || y === undefined) return false;
      if (o.i) { x = x.toLowerCase(); y = y.toLowerCase(); }
      return x === y;
    }
    // Without -o the layout is: the join field, the rest of file 1, all of
    // file 2.  With it, every field is named FILE.FIELD.
    function parseFormat(spec, joinField) {
      if (spec === undefined) return null;
      return String(spec).split(/[ ,]+/).filter(Boolean).map(function (piece) {
        var m = /^(\d+)\.(\d+)$/.exec(piece);
        if (m) return [parseInt(m[1], 10) - 1, parseInt(m[2], 10) - 1];
        var f = /^(\d+)$/.exec(piece);
        if (f) return [0, parseInt(f[1], 10) - 1];      // 0 means "file 1"
        return [0, 0];
      });
    }
    function emit(format, line1, line2, separator) {
      if (!format) {
        // the join field, then the rest of file 1, then all of file 2 that
        // is not its own join field
        var cells = [line1[j1 - 1]];
        for (var a = 0; a < line1.length; a++) if (a !== j1 - 1) cells.push(line1[a]);
        for (var b = 0; b < line2.length; b++) if (b !== j2 - 1) cells.push(line2[b]);
        return cells.join(separator);
      }
      return format.map(function (spec) {
        var row = spec[0] === 0 ? line1 : line2;
        return row[spec[1]] === undefined ? "" : row[spec[1]];
      }).join(separator);
    }
  }, "relational database join");

  // ---- sed -----------------------------------------------------------------
  //
  // A real stream editor: line addresses (N, N,M, $, /re/, $~N, first~step), the
  // commands that actually get used (s///, p, d, q, =, a/i/c with a backslash,
  // y///, n, N, h/H/g/G/x, b/t with labels, { }, :, ; and comments), and -n to
  // stop printing what is not asked for.  Only the selected lines are printed,
  // which is what makes `sed -n 9p` work.
  def("sed", function (args, stdin, sh) {
    // -e may be given more than once, so every one of them is picked out first
    // and the rest goes through getopt
    var expressions = [];
    var rest = [];
    for (var ai = 0; ai < args.length; ai++) {
      var a = args[ai];
      if (a === "-e" || a === "--expression") { expressions.push(args[++ai]); continue; }
      if (a.slice(0, 2) === "--" && a.indexOf("=") > 3 &&
          a.slice(2, a.indexOf("=")) === "expression") {
        expressions.push(a.slice(a.indexOf("=") + 1));
        continue;
      }
      if (a.slice(0, 2) === "-e" && a.length > 2) { expressions.push(a.slice(2)); continue; }
      rest.push(a);
    }

    var g = getopt("sed", rest, {
      short: { n: "bool", e: "arg", f: "arg", i: "bool", s: "bool", z: "bool", E: "bool", r: "bool", "0": "bool" },
      long: { quiet: ["bool", "n"], silent: ["bool", "n"], expression: ["arg", "e"],
              file: ["arg", "f"], inplace: ["bool", "i"], "in-place": ["bool", "i"],
              separate: ["bool", "s"], "null-data": ["bool", "z"], "no-extended": ["bool", "r"],
              posix: ["bool", "E"] },
    });
    var done = finish(sh, "sed", g);
    if (done) return done;
    var o = g.o;

    var scripts = expressions.slice();
    if (o.e !== undefined) scripts.push(String(o.e));
    if (o.f !== undefined) {
      var ftext = V.readFile(sh.path(String(o.f)));
      if (ftext === null) {
        sh._error("sed: can't read " + o.f + ": No such file or directory");
        return { out: "", code: 2 };
      }
      scripts.push(ftext.replace(/\\n$/, ""));
    }
    if (g._.length && scripts.length === 0) scripts.push(g._.shift());
    if (!scripts.length) {
      for (var ui = 0; ui < sedUsage.length; ui++) sh._error(ui ? sedUsage[ui] : sedUsage[ui]);
      return { out: "", code: 1 };
    }
    var program = scripts.join(";\n");
    // -s treats the files separately; with one stream this only matters for
    // $ (the last line of the input rather than of each file)
    var separate = !!o.s;

    var text = "", code = 0;
    if (g._.length) {
      var unreadable = eachInput("sed", g._, stdin, sh, function (prog, name, kind) {
        return "sed: can't read " + name + ": " +
          (kind === "dir" ? "Is a directory" : "No such file or directory");
      }, function (t) { text += t; });
      if (unreadable) code = 2;
    } else text = stdin || "";

    var lines = linesOf(text);
    try {
      var machine = new SedMachine(program, lines, sh);
      machine.extended = !!(o.E || o.r);
      var result = machine.run(o);
      return { out: result.out, code: code || result.code };
    } catch (err) {
      if (err && err.sedVerb !== undefined) return { out: "", code: 2 };
      throw err;
    }
  }, "GNU sed - stream editor");

  var sedUsage = [
    "Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...",
    "",
    "  -n, --quiet, --silent",
    "                 suppress automatic printing of pattern space",
    "      --debug",
    "                 annotate program execution",
    "  -e script, --expression=script",
    "                 add the script to the commands to be executed",
    "  -f script-file, --file=script-file",
    "                 add the contents of script-file to the commands to be executed",
    "  --follow-symlinks",
    "                 follow symlinks when processing in place",
    "  -i[SUFFIX], --in-place[=SUFFIX]",
    "                 edit files in place (makes backup if SUFFIX supplied)",
    "  -l N, --line-length=N",
    "                 specify the desired line-wrap length for the `l' command",
    "  --posix",
    "                 disable all GNU extensions.",
    "  -E, -r, --regexp-extended",
    "                 use extended regular expressions in the script",
    "                 (for portability use POSIX -E).",
    "  -s, --separate",
    "                 consider files as separate rather than as a single,",
    "                 continuous long stream.",
    "      --sandbox",
    "                 operate in sandbox mode (disable e/r/w commands).",
    "  -u, --unbuffered",
    "                 load minimal amounts of data from the input files and flush",
    "                 the output buffers more often",
    "  -z, --null-data",
    "                 separate lines by NUL characters",
    "      --help     display this help and exit",
    "      --version  output version information and exit",
    "",
    "If no -e, --expression, -f, or --file option is given, then the first",
    "non-option argument is taken as the sed script to interpret.  All",
    "remaining arguments are names of input files; if no input files are",
    "specified, then the standard input is read.",
    "",
    "GNU sed home page: <https://www.gnu.org/software/sed/>.",
    "General help using GNU software: <https://www.gnu.org/gethelp/>.",
  ];

  // The line list, without the empty tail an ending newline leaves behind.
  function linesOf(text) {
    if (text === "") return [];
    var a = text.split("\n");
    if (a[a.length - 1] === "") a.pop();
    return a;
  }

  // sed's own state machine, kept out of the command so the command stays a
  // description of the interface.
  function SedMachine(program, input, sh) {
    this.in = input.slice();
    this.sh = sh;
    this.out = "";
    this.spaces = "";                        // lines queued by a
    this.pending = null;                     // the line queued by i or c
    this.hold = "";
    this.line = "";
    this.lineNo = 0;
    this.substituted = false;
    this.suppress = false;
    this.quit = false;
    this.rangeState = [];                    // where each range is open, by command
    this.broken = false;                    // an unknown command was reached
    this.extended = false;                  // -E: the pattern is extended
    this.cmds = parseSed(program, this.sh);
  }

  // ---- the program ----------------------------------------------------------
  // Split into commands, each an address pair plus a verb, with the `p` after
  // `s///` carried along.  Line numbers and $ are resolved at run time.
  var KNOWN_VERBS = {};
  "s y p d D q Q = a i c n N P h H g G x b t T : { } l r w R W z".split(" ")
    .forEach(function (v) { KNOWN_VERBS[v] = true; });

  function parseSed(program, sh) {
    var cmds = [];
    var unknown = null;
    var i = 0, n = program.length;
    function skipSpace() { while (i < n && /[\s;]/.test(program.charAt(i))) i++; }

    function readAddress() {
      skipSpace();
      if (i >= n) return null;
      var ch = program.charAt(i);
      if (ch === "$") { i++; return { kind: "last" }; }
      // no flags after an address: a letter there is the command, as in
      // `/x/p`, and only an s/// command carries flags of its own
      if (ch === "/") { i++; return { kind: "re", re: readUntil("/") }; }
      if (ch === "\\") { i++; var c2 = program.charAt(i++); return readAddressFor(c2); }
      var m = /^(\d+)/.exec(program.slice(i));
      if (m) {
        i += m[1].length;
        var addr = { kind: "num", num: parseInt(m[1], 10) };
        if (program.charAt(i) === "~") { i++; var step = /^(\d+)/.exec(program.slice(i)); addr.step = step ? (i += step[1].length, parseInt(step[1], 10)) : 1; addr.first = true; }
        else if (program.charAt(i) === "+") { i++; var plus = /^(\d+)/.exec(program.slice(i)); addr.plus = plus ? (i += plus[1].length, parseInt(plus[1], 10)) : 1; }
        return addr;
      }
      return null;
    }
    function readAddressFor(letter) {
      switch (letter) {
        case "n": { var m = /^(\d+)/.exec(program.slice(i)); if (m) { i += m[1].length; return { kind: "num", num: parseInt(m[1], 10) }; } return null; }
        default: return null;
      }
    }
    // Read up to an unescaped copy of `stop`, which may be any character:
    // s/\(a\)/x/ delimits on "(" and not on a slash at all.
    function readUntil(stop) {
      var out = "";
      while (i < n) {
        var ch = program.charAt(i);
        if (ch === "\\" && program.charAt(i + 1) === stop) { out += stop; i += 2; continue; }
        if (ch === "\\" && program.charAt(i + 1) === "\\") { out += "\\\\"; i += 2; continue; }
        if (ch === stop) break;
        if (ch === "\n" && stop !== "\n") break;
        out += ch;
        i++;
      }
      if (i < n && program.charAt(i) === stop) i++;      // the closing delimiter
      return out;
    }
    // s/// may be followed by flags: g for every match, i to ignore case, p to
    // print as well, q to stop
    function skipRegexFlags() {
      while (i < n && /[gpiqIW]/.test(program.charAt(i))) i++;
    }

    while (true) {
      skipSpace();
      if (i >= n) break;
      if (program.charAt(i) === "#") { while (i < n && program.charAt(i) !== "\n") i++; continue; }
      var start = i;
      var a1 = readAddress();
      skipSpace();
      var a2 = null;
      if (program.charAt(i) === ",") {
        i++;
        skipSpace();
        var rel = program.charAt(i);
        if (rel === "+" || rel === "~") {
          i++;
          var m2 = /^(\d+)/.exec(program.slice(i));
          var amount = m2 ? (i += m2[1].length, parseInt(m2[1], 10)) : 1;
          a2 = rel === "+" ? { kind: "plus", num: amount } : { kind: "every", num: amount };
        } else {
          a2 = readAddress();
        }
        skipSpace();
      }
      var negate = false;
      if (program.charAt(i) === "!") { negate = true; i++; skipSpace(); }
      var ch = program.charAt(i);
      if (!ch) { unknown = " "; break; }
      if (ch === "{") {
        i++;
        var body = [];
        var depth = 1;
        while (i < n && depth > 0) {
          if (program.charAt(i) === "{") depth++;
          else if (program.charAt(i) === "}") { depth--; if (depth === 0) { i++; break; } }
          else if (program.charAt(i) === ";") { i++; continue; }
          else if (program.charAt(i) === "#") { while (i < n && program.charAt(i) !== "\n") i++; continue; }
          body.push(program.charAt(i));
          i++;
        }
        cmds.push({ addr1: a1, addr2: a2, negate: negate, verb: "{",
          body: body.join(""), at: start });
        continue;
      }
      var cmd = { addr1: a1, addr2: a2, negate: negate, at: start };
      switch (ch) {
        case "s": case "y": {
          var kind = ch;
          i++;
          var delim = program.charAt(i++);
          var re = readUntil(delim);
          var rep = readUntil(delim);
          var flags = "";
          if (kind === "s") { while (i < n && /[gipqIW0-9eM]/.test(program.charAt(i))) flags += program.charAt(i++); }
          cmd.verb = kind;
          cmd.delim = delim;
          cmd.re = re;
          cmd.rep = rep;
          cmd.flags = flags;
          break;
        }
        case "a": case "i": case "c": {
          i++;
          // GNU sed takes the text on the same line after a backslash, or on
          // the following lines; whatever follows the backslash is the text,
          // spaces and all
          var textOut = "";
          if (program.charAt(i) === "\\") i++;
          while (i < n && program.charAt(i) !== "\n" && program.charAt(i) !== ";") { textOut += program.charAt(i++); }
          while (i < n && program.charAt(i) !== ";") {
            if (program.charAt(i) === "\\" && program.charAt(i + 1) === "\n") { i += 2; textOut += "\n"; continue; }
            if (program.charAt(i) === "\n") { i++; textOut += "\n"; continue; }
            textOut += program.charAt(i++);
          }
          cmd.verb = ch;
          cmd.text = textOut.replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
          break;
        }
        case "w": case "r": case "W": case "R": {
          i++;
          var fname = "";
          while (i < n && program.charAt(i) !== "\n" && program.charAt(i) !== ";") {
            fname += program.charAt(i++);
          }
          cmd.verb = ch;
          cmd.file = fname.trim();
          break;
        }
        case "b": case "t": case "T": case ":": {
          i++;
          while (i < n && /[ \t]/.test(program.charAt(i))) i++;
          var label = "";
          while (i < n && /[A-Za-z0-9_]/.test(program.charAt(i))) label += program.charAt(i++);
          cmd.verb = ch;
          cmd.label = label;
          break;
        }
        case "P": case "D": case "N": case "s":
          i++;
          cmd.verb = ch;
          break;
        default:
          i++;
          cmd.verb = ch;
          while (i < n && /[ \t]/.test(program.charAt(i))) i++;
          if (!KNOWN_VERBS[cmd.verb]) unknown = cmd.verb;
      }
      cmds.push(cmd);
      if (program.charAt(i) === ";") i++;
    }
    if (unknown) {
      // sed reads the whole program before it runs any of it, so a command it
      // does not know stops it even if an earlier one would have quit
      var err = new Error("unknown command");
      err.sedVerb = unknown;
      err.sedAt = i;
      throw err;
    }
    return cmds;
  }

  // ---- running it -----------------------------------------------------------
  SedMachine.prototype.run = function (o) {
    var quiet = !!o.n;

    for (var idx = 0; idx < this.in.length && !this.quit; idx++) {
      this.line = this.in[idx];
      this.lineNo = idx + 1;
      this.substituted = false;
      this.startedAt = 0;
      if (this.spaces.length) { this.print(this.spaces); this.spaces = ""; }
      var c = 0;                             // the program starts again each line

      while (c < this.cmds.length) {
        var cmd = this.cmds[c];
        c++;
        if (this.matches(cmd, idx, c - 1) === !!cmd.negate) continue;
        var next = this.execute(cmd, idx, quiet);
        if (next === "quit") { c = this.cmds.length; break; }
        if (next && next.indexOf("jump:") === 0) {
          var at = this.findLabel(next.slice(5));
          c = at >= 0 ? at : this.cmds.length;
          break;
        }
        // n and N consume the following line, which the outer loop must not
        // print again
        if (next === "next-line") { idx++; c = 0; break; }
        if (next === "restart") { c = 0; break; }
        if (this.quit) { c = this.cmds.length; break; }
      }
      if (this.quit) break;
      if (this.pending) { this.print(this.pending); this.pending = null; }
      if (!quiet && !this.suppress) this.print(this.line);
      if (this.suppress) this.suppress = false;
      if (this.spaces.length) { this.print(this.spaces); this.spaces = ""; }
    }
    if (this.out.length && !/\n$/.test(this.out)) this.out += "\n";
    return { out: this.out, code: this.broken ? 2 : 0 };
  };

  SedMachine.prototype.print = function (text) {
    this.out += /\n$/.test(text) ? text : text + "\n";
  };

  // Which lines a command applies to: N, N,M, $, /re/, first~step, N+N, and a
  // second address that is relative.  A *range* is not a test per line: it opens
  // where the first address matches and stays open until the second one matches,
  // which is why the state lives on the machine between lines.
  SedMachine.prototype.matches = function (cmd, idx, ci) {
    var self = this;
    function single(addr) {
      if (!addr) return false;
      if (addr.kind === "num") return self.lineNo === addr.num;
      if (addr.kind === "last") return self.lineNo === self.in.length;
      if (addr.kind === "plus") return self.lineNo <= self.openedAt + addr.num;
      if (addr.kind === "every") return (self.lineNo - self.openedAt) % addr.num === 0;
      if (addr.kind === "re") return sedRegExp(addr.re, "", self.extended).test(self.line);
      return false;
    }
    if (!cmd.addr1 && !cmd.addr2) return true;

    if (cmd.addr1 && cmd.addr2) {
      if (this.rangeState[ci]) {
        var openedAt = this.rangeState[ci];
        if (cmd.addr2.kind === "re") {
          // the closing pattern is searched for from the line the range opened
          // on, so the range may span lines that do not match it
          var target = 0;
          for (var j = openedAt - 1; j < self.in.length; j++) {
            if (sedRegExp(cmd.addr2.re, "", self.extended).test(self.in[j])) { target = j + 1; break; }
          }
          if (!target) return true;                 // never closes: to the end
          if (self.lineNo <= target) return true;   // still inside the range
          this.rangeState[ci] = 0;
          return false;                              // and past its end
        }
        var closes = cmd.addr2.kind === "last"
          ? self.lineNo === self.in.length
          : self.lineNo >= cmd.addr2.num;
        if (closes) this.rangeState[ci] = 0;
        return true;
      }
      if (!single(cmd.addr1)) return false;
      this.rangeState[ci] = self.lineNo;
      this.openedAt = self.lineNo;
      // a range that closes on its own first line is over immediately
      if (cmd.addr2.kind === "re") {
        if (sedRegExp(cmd.addr2.re, "", self.extended).test(self.line)) this.rangeState[ci] = 0;
      } else if (cmd.addr2.kind === "last") {
        if (self.lineNo === self.in.length) this.rangeState[ci] = 0;
      } else if (cmd.addr2.num <= self.lineNo) {
        this.rangeState[ci] = 0;
      }
      return true;
    }

    if (cmd.addr1 && !cmd.addr2) {
      if (cmd.addr1.first) {
        // first~step: this line and every step-th one after it
        if (self.lineNo < cmd.addr1.num) return false;
        return (self.lineNo - cmd.addr1.num) % (cmd.addr1.step || 1) === 0;
      }
      if (cmd.addr1.plus !== undefined) {
        return self.lineNo >= cmd.addr1.num && self.lineNo < cmd.addr1.num + cmd.addr1.plus;
      }
      return single(cmd.addr1);
    }
    return single(cmd.addr2);
  };

  SedMachine.prototype.execute = function (cmd, idx, quiet) {
    var line = this.line;
    switch (cmd.verb) {
      case "s": {
        var flags = cmd.flags || "";
        var re = sedRegExp(cmd.re, (flags.indexOf("g") >= 0 ? "g" : "") +
          (flags.indexOf("i") >= 0 || flags.indexOf("I") >= 0 ? "i" : ""), this.extended);
        if (!re.test(line)) return "";
        if (flags.indexOf("p") >= 0) this.print(substitute(line, cmd, flags, this.extended));
        this.line = substitute(line, cmd, flags, this.extended);
        this.substituted = true;
        if (flags.indexOf("q") >= 0) this.quit = true;
        if (flags.indexOf("Q") >= 0) { this.quit = true; this.suppress = true; }
        return "";
      }
      case "y": {
        var from = cmd.re.split(""), to = cmd.rep.split("");
        var out = "";
        for (var i = 0; i < line.length; i++) {
          var at = from.indexOf(line.charAt(i));
          out += at >= 0 && at < to.length ? to[at] : line.charAt(i);
        }
        this.line = out;
        return "";
      }
      case "p": this.print(this.line); return "";
      case "d": this.suppress = true; return "";
      case "D": {
        var nl = this.line.indexOf("\n");
        if (nl < 0) { this.suppress = true; return ""; }
        this.line = this.line.slice(nl + 1);
        return "restart";
      }
      case "q": if (!quiet) this.print(this.line); this.suppress = true; this.quit = true; return "";
      case "Q": this.quit = true; this.suppress = true; return "";
      case "=": this.print(String(this.lineNo)); return "";
      case "a": this.spaces += cmd.text + "\n"; return "";
      case "i": this.pending = cmd.text; return "";
      case "c": this.pending = cmd.text; this.suppress = true; return "";
      case "n": {
        if (idx + 1 < this.in.length) {
          this.line = this.in[idx + 1];
          this.lineNo = idx + 2;
          this.in.splice(idx + 1, 1);
          return "next-line";
        }
        this.suppress = true;
        return "";
      }
      case "N": {
        // with no line left to append there is nothing to do, and GNU sed stops
        if (idx + 1 < this.in.length) {
          this.line = this.line + "\n" + this.in[idx + 1];
          this.in.splice(idx + 1, 1);
        }
        return "";
      }
      case "P": {
        var cut = this.line.indexOf("\n");
        if (cut >= 0) this.print(this.line.slice(0, cut));
        return "";
      }
      case "h": this.hold = this.line; return "";
      case "H": this.hold += "\n" + this.line; return "";
      case "g": this.line = this.hold; return "";
      case "G": this.line = this.hold + "\n" + this.line; return "";
      case "x": { var t = this.line; this.line = this.hold; this.hold = t; return ""; }
      case "b": return this.findLabel(cmd.label) >= 0 ? "jump:" + cmd.label : "";
      case "t": {
        if (!this.substituted) return "";
        this.substituted = false;
        return this.findLabel(cmd.label) >= 0 ? "jump:" + cmd.label : "";
      }
      case "T": return this.substituted ? "" : (this.findLabel(cmd.label) >= 0 ? "jump:" + cmd.label : "");
      case ":": return "";
      case "{": {
        // a block is a program of its own, run over the line as it stands
        var inner = new SedMachine(cmd.body, [this.line], this.sh);
        inner.extended = this.extended;
        inner.lineNo = this.lineNo;
        inner.hold = this.hold;
        var res = inner.run({ n: true });
        this.line = inner.in[0] === undefined ? this.line : inner.in[0];
        this.hold = inner.hold;
        this.out += res.out;
        this.pending = (inner.pending || this.pending);
        if (this.pending) this.pending += "\n";
        this.spaces += inner.spaces;
        if (inner.substituted) this.substituted = true;
        if (inner.quit) this.quit = true;
        return "";
      }
      case "}": return "";
      case "l": this.print(this.line + "$"); return "";
      // w and r would write and read files; the console has no use for either
      // from a one-line filter, so they are accepted and ignored
      case "r": case "w": case "R": case "W": case "z": case "#": return "";
      default:
        // sed rejects a command it does not know, and says nothing
        this.broken = true;
        return "";
    }
  };

  // POSIX classes, spelled the way sed scripts spell them
  var POSIX_CLASS = {
    alpha: "A-Za-z", digit: "0-9", alnum: "A-Za-z0-9", upper: "A-Z", lower: "a-z",
    space: " \\t\\r\\n\\v\\f", blank: " \\t", punct: "!-\\/:-@\\[-`{-~",
    print: " -~", graph: "!-~", cntrl: "\\x00-\\x1f\\x7f", xdigit: "0-9A-Fa-f",
    word: "A-Za-z0-9_",
  };
  // A sed pattern is not a JavaScript one: a basic regular expression spells a
  // group \( \) and an alternation \|, and neither means anything to RegExp.
  // The escapes for literal characters are the same in both.
  function sedPattern(source, extended) {
    var out = "", i = 0, depth = 0;
    var plain = { "{": "}", "|": "|", "+": "+", "?": "?" };
    while (i < source.length) {
      var ch = source.charAt(i);
      if (ch !== "\\") { out += ch; i++; continue; }
      var next = source.charAt(i + 1);
      if (next === "\\") { out += "\\\\"; i += 2; continue; }
      if (extended) {
        // in an extended pattern the punctuation stands for itself, so only the
        // group escapes need changing
        out += (next === "(" || next === ")") ? next : "\\" + next;
        i += 2;
        continue;
      }
      // A basic regular expression spells a group \( ... \), and puts a
      // backslash in front of the punctuation operators: \| for alternation,
      // \+ for one or more, \? for optional, \{n,m\} for a count.
      if (next === "(" || next === ")") { out += next; i += 2; continue; }
      out += Object.prototype.hasOwnProperty.call(plain, next) ? next : "\\" + next;
      i += 2;
    }
    return out;
  }

  function sedRegExp(source, flags, extended) {
    return new RegExp(expandPosix(sedPattern(source, extended)), flags);
  }
  function expandPosix(source) {
    // A POSIX class is written [:name:] between the brackets of the class it
    // belongs to: [[:alpha:]] is one "a to z or A to Z".
    return String(source).replace(/\[:([a-z]+):\]/g, function (_, name) {
      // only the contents are replaced: the brackets around them belong to the
      // character class the script already wrote
      var set = POSIX_CLASS[name];
      return set === undefined ? _ : set;
    });
  }

  // The replacement: \1..\9 are the groups, & is the whole match, \n and \t are
  // written in the script.
  function substitute(line, cmd, flags, extended) {
    var re = sedRegExp(cmd.re, (flags.indexOf("g") >= 0 ? "g" : "") +
      (flags.indexOf("i") >= 0 || flags.indexOf("I") >= 0 ? "i" : ""), extended);
    // A global substitution skips an empty match that begins exactly where the
    // previous one ended: that is why `sed 's/a*/X/g'` turns "aaa" into "X"
    // but "bbb" into "XbXbXbX".
    var global = flags.indexOf("g") >= 0;
    var scan = new RegExp(re.source, "g");
    var out = "", at = 0, lastEnd = -1, m;
    while ((m = scan.exec(line)) !== null) {
      if (m[0] === "" && m.index === lastEnd) { scan.lastIndex++; continue; }
      out += line.slice(at, m.index) + replacement(m, cmd.rep);
      at = m.index + m[0].length;
      lastEnd = at;
      if (m[0] === "") scan.lastIndex++;
      if (!global) break;
    }
    return out + line.slice(at);

    // m is the whole match array, so m[0] is the match and m[1].. its groups
    function replacement(m, rep) {
      return rep.replace(/\\([0-9&])|&|\\n|\\t/g, function (tok, d) {
        if (tok === "&") return m[0];
        if (tok === "\\n") return "\n";
        if (tok === "\\t") return "\t";
        if (d === "&") return "&";             // \& is an ampersand
        return m[parseInt(d, 10)] === undefined ? "" : m[parseInt(d, 10)];
      });
    }
  }

  SedMachine.prototype.findLabel = function (label) {
    for (var i = 0; i < this.cmds.length; i++) {
      if (this.cmds[i].verb === ":" && this.cmds[i].label === label) return i;
    }
    return -1;
  };

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
    // A column is indented by one tab per *printed* column before it, so -1
    // and -2 move the remaining columns left rather than leaving a gap.
    var indent = [0, 0, 0];
    var seen = 0;
    [1, 2, 3].forEach(function (col) {
      if (o[String(col)]) { indent[col - 1] = -1; return; }
      indent[col - 1] = seen++;
    });
    var pad = function (col) { return "\t".repeat(indent[col - 1]); };

    var out = "", n1 = 0, n2 = 0, nBoth = 0;
    var i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && (j >= b.length || a[i] < b[j])) {
        if (!o["1"]) out += pad(1) + a[i] + "\n";
        n1++; i++;
      } else if (j < b.length && (i >= a.length || b[j] < a[i])) {
        if (!o["2"]) out += pad(2) + b[j] + "\n";
        n2++; j++;
      } else {
        if (!o["3"]) out += pad(3) + a[i] + "\n";
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
        out += lines(t).a.join(delimList[0]) + "\n";
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
    // with no operand split reads standard input and writes x00, x01, ...
    var file = g._.length ? g._[0] : null;
    var text;
    if (file === null) {
      text = stdin || "";
    } else {
      text = V.readFile(sh.path(file));
      if (text === null) {
        sh._error(openErr("split", file, V.getNode(sh.path(file)) ? "dir" : "missing"));
        return { out: "", code: 1 };
      }
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
      // there is no -w in od; the page width is --width-bytes only
      short: { A: "arg", b: "bool", c: "bool", d: "bool", f: "bool", i: "arg",
               j: "arg", N: "arg", o: "bool", t: "arg", v: "bool", x: "bool",
               w: "optarg", "0": "bool" },
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
    var type = o.b ? "ob" : o.x ? "x" : o.c ? "c" : o.d ? "d" : null;
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
        case "ob":
          return cell.map(function (c) {
            return (c.charCodeAt(0) & 0xff).toString(8).padStart(3, "0");
          }).join("") + " ";
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
          // One little-endian octal word for the cell: `printf ab | od`
          // prints 061141, which is 0x6261.
          var word = 0;
          for (var q = cell.length - 1; q >= 0; q--) word = word * 256 + (cell[q].charCodeAt(0) & 0xff);
          // a lone trailing byte still fills a whole two-byte word: 000147
          return word.toString(8).padStart(Math.max(6, 3 * cell.length), "0") + " ";
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
    // 1048576 -> "1.0M": a scaled value always keeps one decimal
    return v.toFixed(1) + spec.units[i];
  }

  // ---- seq -----------------------------------------------------------------
  //
  // [FIRST [INCREMENT]] LAST, with -s SEPARATOR, -w WIDTH, -f FORMAT.
  def("seq", function (args, stdin, sh) {
    var g = getopt("seq", args, {
      short: { s: "arg", w: "bool", f: "arg", t: "bool", i: "arg", "0": "bool" },
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
      return usage(sh, "seq", "invalid Zero increment value: '" +
        (nums[1] === undefined ? "1" : nums[1]) + "'");
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
    // -w is a *minimum*: the numbers are padded to as many digits as the
    // largest one needs, so `seq -w 8 10` prints 08 09 10 and not eight digits
    var eol = o.s === undefined ? "\n" : unescapeSep(o.s);
    if (o.w !== undefined) {
      var width = 0;
      body.forEach(function (x) { width = Math.max(width, x.length); });
      body = body.map(function (x) { return x.padStart(width, "0"); });
    }
    return { out: body.join(eol) + (body.length ? "\n" : ""), code: 0 };
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
    // Each name is printed as it is first reached, so "a b" / "b c" gives
    // a, b, c -- a depth-first walk, not the reverse post-order.
    var ordered = [], visiting = {}, seen = {}, cycle = null, stack = [], loop = [];
    function visit(node) {
      if (seen[node]) return;
      if (visiting[node]) {                                  // back edge: a loop
        cycle = node;
        loop = stack.slice(stack.indexOf(node));
        return;
      }
      visiting[node] = 1;
      stack.push(node);
      ordered.push(node);
      edges.forEach(function (e) { if (e[0] === node) visit(e[1]); });
      visiting[node] = 0;
      stack.pop();
      seen[node] = 1;
    }
    for (var i = 0; i < names.length && !cycle; i++) visit(names[i]);
    if (cycle) {
      // report the members of the loop in the order they were reached
      sh._error("tsort: -: input contains a loop:");
      loop.forEach(function (n) { sh._error("tsort: " + n); });
      return { out: ordered.join("\n") + (ordered.length ? "\n" : ""), code: 1 };
    }
    return { out: ordered.join("\n") + (ordered.length ? "\n" : ""), code: code };
  }, "sort pairs of strings nontrivially");

  // grep/sed/pgrep all compile POSIX patterns; sharing the compiler keeps an
  // ERE meaning the same thing in every command.  extended=true is regcomp's
  // REG_EXTENDED (ERE), false is BRE.
  LW.ere = function (source, flags, extended) {
    return new RegExp(expandPosix(sedPattern(source, !!extended)), flags);
  };

})(window.LW);