// A bash-style interactive shell for the web console.
//
// This is NOT GNU bash.  It is a small shell that speaks enough of bash's
// language to feel like one: quoting, $variables, ${...}, $(...) command
// substitution, globbing, pipelines, > >> < redirection, ; && || lists,
// if/for/while, plus coreutils over the (IndexedDB-backed) VFS in vfs.js.
//
// Requires vfs.js (window.LW.VFS), renderer.js and bash.data.js.
(function (LW) {
  "use strict";

  // ctrlChar is defined by renderer.js in the real page; give a minimal
  // equivalent so this shell still parses Ctrl chords headless.
  if (!LW.ctrlChar) {
    LW.ctrlChar = function (ev) {
      if (ev.key && ev.key.length === 1 && /^[a-zA-Z@\[\\\]^_?]$/.test(ev.key)) {
        return ev.key.toLowerCase();
      }
      return null;
    };
  }

  var V = LW.VFS;
  var USER = V.USER, HOST = V.HOST, HOME = V.HOME;
  var ESC = "\x1b[";
  function sgr(code) { return ESC + code + "m"; }

  // Backslash-escape expansion shared by `echo -e`, `printf` and `$'...'`
  // (ANSI-C quoting).  Returns {text, stop}: `stop` is set by \c, which ends
  // the output.  Covers the full bash set including the colour forms \e,
  // \033, \x1b and \u/\U.
  function expandEscapes(s) {
    var out = "", i = 0;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (ch !== "\\") { out += ch; i++; continue; }
      var n = s.charAt(i + 1);
      if (n === "") { out += "\\"; i++; continue; }
      switch (n) {
        case "a": out += "\x07"; i += 2; continue;
        case "b": out += "\x08"; i += 2; continue;
        case "e": case "E": out += "\x1b"; i += 2; continue;
        case "f": out += "\x0c"; i += 2; continue;
        case "n": out += "\n"; i += 2; continue;
        case "r": out += "\r"; i += 2; continue;
        case "t": out += "\t"; i += 2; continue;
        case "v": out += "\x0b"; i += 2; continue;
        case "\\": out += "\\"; i += 2; continue;
        case "'": out += "'"; i += 2; continue;
        case "\"": out += "\""; i += 2; continue;
        case "?": out += "?"; i += 2; continue;
        case "c": return { text: out, stop: true };
        case "x": {
          var hx = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 2));
          if (hx) { out += String.fromCharCode(parseInt(hx[0], 16)); i += 2 + hx[0].length; }
          else { out += "\\x"; i += 2; }
          continue;
        }
        case "u": case "U": {
          var w = n === "u" ? 4 : 8;
          var hu = new RegExp("^[0-9a-fA-F]{1," + w + "}").exec(s.slice(i + 2));
          if (hu) {
            try { out += String.fromCodePoint(parseInt(hu[0], 16)); }
            catch (err) { out += "\\" + n; }
            i += 2 + hu[0].length;
          } else { out += "\\" + n; i += 2; }
          continue;
        }
      }
      // octal: \0nnn (echo) or \nnn (printf)
      var oct = n === "0" ? /^0[0-7]{0,3}/.exec(s.slice(i + 1))
        : /^[0-7]{1,3}/.exec(s.slice(i + 1));
      if (oct) {
        out += String.fromCharCode(parseInt(oct[0], 8) & 0xff);
        i += 1 + oct[0].length;
        continue;
      }
      out += "\\" + n;   // unknown escape: bash keeps the backslash
      i += 2;
    }
    return { text: out, stop: false };
  }

  // ===================== lexer =====================

  var OPS = ["||", "&&", ">>", ";", "|", ">", "<", "&", "(", ")", "{", "}"];

  function Lexer(src, sh) { this.s = src; this.i = 0; this.sh = sh; }

  Lexer.prototype.run = function () {
    var out = [];
    for (;;) {
      var before = this.ws();                  // did whitespace separate it?
      if (this.i >= this.s.length) break;
      if (this.s.charAt(this.i) === "#") break;      // comment to end of line
      var op = this.opAt();
      if (op) {
        this.i += op.length;
        var t = { op: op, spaced: before };
        out.push(t);
        continue;
      }
      var w = this.word();
      w.spaced = before;
      out.push(w);
    }
    return out;
  };

  Lexer.prototype.ws = function () {
    var seen = false;
    while (this.i < this.s.length && " \t".indexOf(this.s.charAt(this.i)) >= 0) { this.i++; seen = true; }
    return seen;
  };

  Lexer.prototype.opAt = function () {
    for (var k = 0; k < OPS.length; k++) {
      if (this.s.substr(this.i, OPS[k].length) === OPS[k]) return OPS[k];
    }
    return null;
  };

  // A word is a list of segments; expansions stay unresolved until the command
  // actually runs, so `X=1; echo $X` and `for i in ...; do echo $i` work.
  function Word() { this.segs = []; this.lit = ""; this.raw = ""; this.quoted = false; }
  Word.prototype.text = function (s) { this.lit += s; this.raw += s; };
  Word.prototype.push = function (seg) {
    if (this.lit) { this.segs.push({ lit: this.lit }); this.lit = ""; }
    this.segs.push(seg);
  };
  Word.prototype.done = function () {
    if (this.lit) { this.segs.push({ lit: this.lit }); this.lit = ""; }
    if (!this.segs.length) this.segs.push({ lit: "" });
    return this.segs;
  };
  Word.prototype.isEmpty = function () {
    return this.segs.length === 1 && this.segs[0].lit === "";
  };

  Lexer.prototype.word = function () {
    var w = new Word();
    while (this.i < this.s.length) {
      if (this.opAt()) break;
      var ch = this.s.charAt(this.i);
      if (ch === " " || ch === "\t") break;
      if (ch === "\\") {
        this.i++;
        var nx = this.s.charAt(this.i);
        if (nx === "") break;
        if (nx === "\n") { this.i++; continue; }
        w.text(nx); w.quoted = true; this.i++;
      } else if (ch === "'") {
        w.quoted = true; this.i++;
        var e = this.s.indexOf("'", this.i);
        if (e < 0) { w.text(this.s.slice(this.i)); this.i = this.s.length; }
        else { w.text(this.s.slice(this.i, e)); this.i = e + 1; }
      } else if (ch === '"') {
        w.quoted = true; this.i++; this.dquote(w);
      } else if (ch === "$") {
        this.dollar(w);
      } else if (ch === "`") {
        this.i++;
        var e2 = this.s.indexOf("`", this.i);
        if (e2 < 0) e2 = this.s.length;
        w.push({ cmd: this.s.slice(this.i, e2) });
        this.i = e2 + 1;
      } else {
        w.text(ch); this.i++;
      }
    }
    return { segs: w.done(), quoted: w.quoted, raw: w.raw, empty: w.isEmpty() };
  };

  Lexer.prototype.dquote = function (w) {
    while (this.i < this.s.length) {
      var ch = this.s.charAt(this.i);
      if (ch === '"') { this.i++; break; }
      if (ch === "\\") {
        var nx = this.s.charAt(this.i + 1);
        if ('"\\$`'.indexOf(nx) >= 0) { w.text(nx); this.i += 2; continue; }
        w.text(ch); this.i++; continue;
      }
      if (ch === "$") { this.dollar(w); continue; }
      if (ch === "`") {
        this.i++;
        var e = this.s.indexOf("`", this.i); if (e < 0) e = this.s.length;
        w.push({ cmd: this.s.slice(this.i, e) }); this.i = e + 1; continue;
      }
      w.text(ch); this.i++;
    }
  };

  Lexer.prototype.dollar = function (w) {
    var rest = this.s.slice(this.i + 1);
    if (rest.charAt(0) === "'") {
      // ANSI-C quoting ($'...'): backslash escapes expand, nothing else does.
      var j = this.i + 2, raw = "";
      while (j < this.s.length) {
        var c = this.s.charAt(j);
        if (c === "\\") { raw += c + (this.s.charAt(j + 1) || ""); j += 2; continue; }
        if (c === "'") break;
        raw += c; j++;
      }
      this.i = j + 1;
      w.text(expandEscapes(raw).text);
      w.quoted = true;
      return;
    }
    if (rest.charAt(0) === "(" && rest.charAt(1) === "(") {
      var close = this.arithEnd(this.i + 1);
      w.push({ arith: this.s.slice(this.i + 3, close - 1) });
      this.i = close + 1;
      return;
    }
    if (rest.charAt(0) === "(") { w.push({ cmd: this.paren(this.i + 1) }); return; }
    if (rest.charAt(0) === "{") {
      var close2 = this.s.indexOf("}", this.i + 1);
      if (close2 < 0) { w.text("$"); this.i++; return; }
      w.push({ var: this.s.slice(this.i + 2, close2) });
      this.i = close2 + 1;
      return;
    }
    var m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (m) { w.push({ var: m[0] }); this.i += 1 + m[0].length; return; }
    if (/^[?$#0-9!*]/.test(rest)) { w.push({ var: rest.charAt(0) }); this.i += 2; return; }
    w.text("$"); this.i++;
  };

  // end index of the "))" that closes a `$((` starting at `open`
  Lexer.prototype.arithEnd = function (open) {
    var depth = 0;
    for (var j = open; j < this.s.length; j++) {
      var ch = this.s.charAt(j);
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) return j; }
    }
    return this.s.length - 1;
  };

  // capture a balanced ( ... ): this.i points at '('
  Lexer.prototype.paren = function (open) {
    var depth = 0, j = open, inS = false, inD = false;
    for (; j < this.s.length; j++) {
      var ch = this.s.charAt(j);
      if (inS) { if (ch === "'") inS = false; continue; }
      if (inD) { if (ch === "\\") { j++; continue; } if (ch === '"') inD = false; continue; }
      if (ch === "'") { inS = true; continue; }
      if (ch === '"') { inD = true; continue; }
      if (ch === "\\") { j++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
    }
    var inner = this.s.slice(open + 1, j);
    this.i = j + 1;
    return inner;
  };

  // ===================== parser =====================

  function Parser(tokens, sh) { this.t = tokens; this.i = 0; this.sh = sh; }
  Parser.prototype.peek = function () { return this.t[this.i]; };
  Parser.prototype.next = function () { return this.t[this.i++]; };
  Parser.prototype.op = function (v) { var t = this.peek(); return !!t && t.op === v; };
  Parser.prototype.parse = function () { return this.parseList([")"]); };

  Parser.prototype.parseList = function (stops) {
    var items = [];
    for (;;) {
      var t = this.peek();
      if (!t) break;
      if (t.op && stops.indexOf(t.op) >= 0) break;
      if (t.op === ";" || t.op === "&") { this.next(); continue; }
      if (t.raw && stops.indexOf(t.raw) >= 0) break;
      var before = this.i;
      items.push(this.parseAndOr(stops));
      if (this.i === before) this.next();   // never stall on an unconsumed token
    }
    return { kind: "seq", items: items };
  };

  Parser.prototype.parseAndOr = function (stops) {
    var left = this.parsePipeline();
    for (;;) {
      var o = this.peek();
      if (!o || (o.op !== "&&" && o.op !== "||")) break;
      this.next();
      left = { kind: "andor", op: o.op, left: left, right: this.parsePipeline() };
    }
    return left;
  };

  Parser.prototype.parsePipeline = function () {
    var cmds = [this.parseCommand()];
    while (this.op("|")) { this.next(); cmds.push(this.parseCommand()); }
    return { kind: "pipe", cmds: cmds };
  };

  Parser.prototype.parseCommand = function () {
    var t = this.peek();
    if (!t) return { kind: "simple", words: [], redirs: [] };
    if (t.raw === "if" || t.raw === "for" || t.raw === "while") return this.parseCompound();
    // function definition:  name () { list }
    if (t.raw && this.t[this.i + 1] && this.t[this.i + 1].op === "(" &&
        this.t[this.i + 2] && this.t[this.i + 2].op === ")" &&
        this.t[this.i + 3] && this.t[this.i + 3].op === "{") {
      var fname = t.raw;
      this.i += 4;
      var fbody = this.parseList(["}"]);

      if (this.op("}")) this.next();
      return { kind: "funcdef", name: fname, body: fbody };
    }
    var words = [], redirs = [];
    for (;;) {
      var x = this.peek();
      if (!x) break;
      // A number glued to a redirection is that file descriptor: `cmd 2> log`
      // and `cmd 2>/dev/null`.  A space before the operator leaves it an
      // ordinary operand instead -- `seq 3 > f` prints 1 2 3, as bash does.
      var nx = this.t[this.i + 1];
      if (x.op !== "<" && x.raw && /^[0-9]+$/.test(x.raw) && nx && !nx.spaced &&
          (nx.op === ">" || nx.op === ">>")) {
        var fd = parseInt(x.raw, 10);
        this.next();
        var op = this.next();                          // the operator itself
        var dup = false;
        if (this.op("&")) { this.next(); dup = true; } // N>&M
        var w = this.peek();
        var tgt = (w && !w.op && !w.empty) ? this.next() : { segs: [{ lit: "" }], raw: "", empty: true };
        redirs.push({ op: dup ? ">&" : op.op, target: tgt, dup: dup, fd: fd });
        continue;
      }
      if (x.op === ">" || x.op === ">>" || x.op === "<") {
        this.next();
        var dup2 = false;
        if (x.op !== "<" && this.op("&")) { this.next(); dup2 = true; }  // N>&M
        var w2 = this.peek();
        var tgt2 = (w2 && !w2.op && !w2.empty) ? this.next() : { segs: [{ lit: "" }], raw: "", empty: true };
        redirs.push({ op: dup2 ? ">&" : x.op, target: tgt2, dup: dup2, fd: 1 });
        continue;
      }
      if (x.op) break;
      if (!x.empty) words.push(x);
      this.next();
    }
    return { kind: "simple", words: words, redirs: redirs };
  };

  Parser.prototype.parseCompound = function () {
    var kw = this.next().raw, p = this;
    function collect(stops) {
      var arr = [];
      for (;;) {
        var t = p.peek();
        if (!t) break;
        if (t.raw && stops.indexOf(t.raw) >= 0) break;
        if (t.op === ")") break;
        arr.push(p.next());          // keep ';' so statements stay separated
      }
      return new Parser(arr, p.sh).parse();
    }
    if (kw === "if") {
      var cond = collect(["then"]);
      if (p.peek() && p.peek().raw === "then") p.next();
      var body = collect(["else", "fi"]), els = null;
      if (p.peek() && p.peek().raw === "else") { p.next(); els = collect(["fi"]); }
      if (p.peek() && p.peek().raw === "fi") p.next();
      return { kind: "if", cond: cond, body: body, els: els };
    }
    if (kw === "for") {
      var name = p.next().raw, words = [];
      if (p.peek() && p.peek().raw === "in") {
        p.next();
        while (p.peek() && p.peek().raw !== "do" && !p.op(";")) words.push(p.next());
      }
      while (p.peek() && !p.op(";") && p.peek().raw !== "do") p.next();
      if (p.op(";")) p.next();
      if (p.peek() && p.peek().raw === "do") p.next();
      var fbody = collect(["done"]);
      if (p.peek()) p.next();
      return { kind: "for", name: name, words: words, body: fbody };
    }
    var wcond = collect(["do"]);
    if (p.peek()) p.next();
    var wbody = collect(["done"]);
    if (p.peek()) p.next();
    return { kind: "while", cond: wcond, body: wbody };
  };

  // ===================== commands =====================

  var CMDS = {};
  function defCmd(name, fn, help) { CMDS[name] = { run: fn, help: help || "" }; }
  // Shell builtins (bash's own set): looked up before PATH commands.
  var BUI = {};
  function defBui(name, fn) { BUI[name] = { run: fn }; }

  function opt(args, spec) {
    var o = { _: [] }, i = 0;
    spec = spec || {};
    while (i < args.length) {
      var a = args[i];
      if (a === "--") { o._ = o._.concat(args.slice(i + 1)); break; }
      if (a.length > 1 && a.charAt(0) === "-" && a !== "-") {
        if (a.slice(0, 2) === "--") {
          var eq = a.indexOf("=");
          var key = eq < 0 ? a.slice(2) : a.slice(2, eq);
          if (spec.long && spec.long.indexOf(key) >= 0) {
            if (eq < 0 && spec.argLong && spec.argLong.indexOf(key) >= 0) o[key] = args[++i];
            else o[key] = eq < 0 ? true : a.slice(eq + 1);
          } else o._.push(a);
          i++; continue;
        }
        var chars = a.slice(1);
        for (var k = 0; k < chars.length; k++) {
          var c = chars.charAt(k);
          if (spec.arg && spec.arg.indexOf(c) >= 0) { o[c] = chars.slice(k + 1) || args[++i]; break; }
          o[c] = true;
        }
        i++; continue;
      }
      o._.push(a); i++;
    }
    return o;
  }

  // ---------------- GNU-style option parsing (getopt_long) ----------------
  //
  // coreutils parses with getopt_long and words every failure itself:
  //
  //     $ cat -Z
  //     cat: invalid option -- 'Z'
  //     Try 'cat --help' for more information.
  //
  // getopt() walks argv exactly that way.  Options may follow operands (GNU
  // getopt permutes), `--` ends the option list, and the walk stops at the
  // first of --help, --version or a bad option -- which is what makes
  // `cat --help -Z` succeed while `cat -Z --help` fails.
  //
  //     spec = { short: { n: "bool", c: "arg" },     // "arg" eats a value
  //              long:  { number: "bool",            // value = the key
  //                       count: ["arg", "c"] },     // [kind, key] to alias
  //              exit: 1,                            // status on a usage error
  //              helpShort: "h", versionShort: "V" } // only if really accepted
  //
  //     g = getopt("cat", args, spec)
  //     -> { o: { n: true }, _: [operands], err: null|"cat: invalid ...",
  //          help: false, version: false, exit: 1 }
  //
  // finish() answers g the way coreutils does; pass it your shell and name.
  function getopt(prog, args, spec) {
    spec = spec || {};
    var shortSpec = spec.short || {}, longSpec = spec.long || {};
    var o = {}, out = [], i = 0, exit = spec.exit || 1;
    function done(err) {
      return { o: o, _: out, err: err || null, help: false, version: false, exit: exit };
    }
    function doneWith(flag) {
      var r = done(null);
      r[flag] = true;
      return r;
    }
    while (i < args.length) {
      var a = args[i++];
      if (a === "--") { out = out.concat(args.slice(i)); i = args.length; break; }
      if (a.length < 2 || a.charAt(0) !== "-") { out.push(a); continue; }
      if (a.charAt(1) === "-") {                                  // --long[=value]
        var eq = a.indexOf("="), name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        if (name === "help") return doneWith("help");
        if (name === "version") return doneWith("version");
        var has = Object.prototype.hasOwnProperty.call(longSpec, name);
        if (!has) {
          return done(prog + ": unrecognized option '" + (eq < 0 ? a : a.slice(0, eq)) + "'");
        }
        var le = longSpec[name], lk = typeof le === "string" ? name : le[1];
        var kind = typeof le === "string" ? le : le[0];
        if (kind === "bool") {
          if (eq >= 0) return done(prog + ": option '--" + name + "' doesn't allow an argument");
          o[lk] = true;
        } else if (eq >= 0) {
          o[lk] = a.slice(eq + 1);
        } else if (i < args.length) {
          o[lk] = args[i++];
        } else {
          return done(prog + ": option '--" + name + "' requires an argument");
        }
        continue;
      }
      var chars = a.slice(1);                                    // -abc / -cVALUE
      for (var k = 0; k < chars.length; k++) {
        var c = chars.charAt(k);
        if (spec.helpShort && c === spec.helpShort) return doneWith("help");
        if (spec.versionShort && c === spec.versionShort) return doneWith("version");
        var se = Object.prototype.hasOwnProperty.call(shortSpec, c) ? shortSpec[c] : null;
        // POSIX lets head, tail and pr write `-3` for "-n 3"; a spec says so
        // with `digits: "n"`, which is where the number is filed.  The whole
        // run of digits is the value, so `-40` is forty and not four.
        if (se === null && spec.digits && /^[0-9]$/.test(c)) {
          var run = /^[0-9]+/.exec(chars.slice(k))[0];
          o[spec.digits] = run;
          k += run.length - 1;
          continue;
        }
        if (se === null) return done(prog + ": invalid option -- '" + c + "'");
        if (se === "bool") { o[c] = true; continue; }
        if (se === "optarg") {
          // the value is only recognised when glued to the letter, so
          // `od -w 2` sets no width and reads a file called "2"
          var attached = chars.slice(k + 1);
          o[c] = attached || true;
          k = chars.length - 1;
          continue;
        }
        var val = chars.slice(k + 1);
        if (!val) {
          if (i < args.length) val = args[i++];
          else return done(prog + ": option requires an argument -- '" + c + "'");
        }
        o[c] = val;
        break;                                                    // the value ate the rest
      }
    }
    return done(null);
  }

  // The `--help` / `--version` text of a coreutils program, captured verbatim
  // from the real binary by tools/gen_coreutils_help.py.
  function doc(prog, which) {
    var t = which === "version" ? LW.CUVER : LW.CUHELP;
    var rows = t && t[prog];
    return rows && rows.length ? rows.join("\n") + "\n" : "";
  }

  // Answer --help / --version / a getopt failure, or return null to carry on.
  function finish(sh, prog, g, code) {
    if (g.help) return { out: doc(prog, "help"), code: 0 };
    if (g.version) return { out: doc(prog, "version"), code: 0 };
    if (g.err) {
      sh._error(g.err);
      sh._error("Try '" + prog + " --help' for more information.");
      return { out: "", code: code === undefined ? g.exit : code };
    }
    return null;
  }

  function human(n) {
    var u = ["", "K", "M", "G", "T"], i = 0; n = Number(n);
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? String(n) : n.toFixed(1)) + u[i];
  }

  function colorize(name, path, color) {
    if (!color) return name;
    var n = V.getNode(path);
    var col = n && n.t === "d" ? "01;34" : n && n.t === "l" ? "01;36" : null;
    return col ? sgr(col) + name + sgr("0") : name;
  }

  function readInput(args, stdin, sh) {
    if (!args.length || args[0] === "-") return stdin;
    var d = V.readFile(sh.path(args[0]));
    return d;
  }

  // ---- ls
  defCmd("ls", function (args, stdin, sh) {
    var o = opt(args, { bool: "laFh1Rr", long: ["all", "long", "color", "human-readable", "reverse"], argLong: ["color"] });
    var color = !!o.color;
    if (o.color === "never") color = false;
    var targets = o._.length ? o._ : ["."];
    var long = !!(o.l || o.long), all = !!(o.a || o.all), one = !!o["1"];
    var res = "";
    for (var i = 0; i < targets.length; i++) {
      var p = sh.path(targets[i]);
      var n = V.getNode(p);
      if (!n) { sh._error("ls: cannot access '" + targets[i] + "': No such file or directory"); return { out: "", code: 2 }; }
      if (n.t !== "d") {
        if (n.dev && LW.DEV) {
          var grp = n.devType === "b" ? "disk" : "root";
          res += (long ? LW.DEV.perms({ type: n.devType, mode: n.devType === "b" ? "0660" : "0666" }) +
            " 1 root " + grp.padEnd(5) + " " + String(n.major).padStart(3) + ", " +
            String(n.minor).padStart(3) + " Oct  3 09:14 " : "") +
            colorize(V.baseName(p), p, color) + "\n";
        } else {
          res += (long ? "-rw-r--r-- 1 linuxweb linuxweb " + String((n.d || "").length).padStart(6) + " Oct  3 09:14 " : "") +
            colorize(V.baseName(p), p, color) + "\n";
        }
        continue;
      }
      if (targets.length > 1) res += targets[i] + ":\n";
      var names = Object.keys(n.c).sort();
      if (!all) names = names.filter(function (x) { return x.charAt(0) !== "."; });
      if (o.r || o.reverse) names.reverse();
      if (long) {
        res += "total " + names.length * 4 + "\n";
        names.forEach(function (nm) {
          var c = n.c[nm];
          if (c.dev && LW.DEV) {
            var grp = c.devType === "b" ? "disk" : "root";
            res += LW.DEV.perms({ type: c.devType, mode: c.devType === "b" ? "0660" : "0666" }) +
              " 1 root " + grp.padEnd(5) + " " + String(c.major).padStart(3) + ", " +
              String(c.minor).padStart(3) + " Oct  3 09:14 " + nm + "\n";
            return;
          }
          var perms = c.t === "d" ? "drwxr-xr-x" : c.t === "l" ? "lrwxrwxrwx" : "-rw-r--r--";
          var size = c.t === "l" ? c.to.length : c.t === "d" ? 4096 : (c.get ? 0 : (c.d || "").length);
          res += perms + " 1 linuxweb linuxweb " + String(size).padStart(6) + " Oct  3 09:14 " +
            colorize(nm, p + "/" + nm, color) + (c.t === "l" ? " -> " + c.to : "") + "\n";
        });
      } else {
        var cells = names.map(function (nm) { return colorize(nm, p + "/" + nm, color); });
        if (one) { cells.forEach(function (c2) { res += c2 + "\n"; }); }
        else {
          var w = 0; cells.forEach(function (c2) { w = Math.max(w, c2.replace(/\x1b\[[0-9;]*m/g, "").length); });
          w += 2;
          var perRow = Math.max(1, Math.floor(80 / w));
          for (var r = 0; r < cells.length; r += perRow) {
            var row = "";
            for (var c3 = r; c3 < Math.min(r + perRow, cells.length); c3++) {
              var vis = cells[c3].replace(/\x1b\[[0-9;]*m/g, "").length;
              row += cells[c3] + new Array(Math.max(1, w - vis + 1)).join(" ");
            }
            res += row.replace(/\s+$/, "") + "\n";
          }
        }
      }
      if (targets.length > 1) res += "\n";
    }
    return { out: res, code: 0 };
  }, "ls - list directory contents");

  // ---- cat
  //
  // coreutils' cat, spelled out.  The options fold the way GNU's do
  // (-A = -vET, -e = -vE, -t = -vT), -b overrides -n, the line number runs
  // on across every file and across stdin, and -s squeezes blank lines
  // globally rather than per file.  Files are concatenated into one stream
  // first, so a file with no trailing newline simply runs into the next one:
  // with f = "x", `cat -n f f` prints a single numbered line "xx".
  //
  // A file that cannot be read is reported on stderr and everything else is
  // still printed, with a final status of 1 -- `cat nope f` prints f.
  // `-` is stdin, read once; a second `-` sees end of file, like a pipe.
  function utf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length &&
               s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else out.push(0xef, 0xbf, 0xbd);                 // lone surrogate -> U+FFFD
    }
    return out;
  }
  // -v's notation: ^@..^_ for controls, ^? for DEL, M- for the high bit,
  // applied to the UTF-8 *bytes* -- which is why `cat -v` on "é" prints
  // M-CM-), not é.
  function showByte(b, showTabs) {
    if (b < 32) {
      if (b === 9) return showTabs ? "^I" : "\t";
      if (b === 10) return "\n";
      return "^" + String.fromCharCode(b + 64);
    }
    if (b < 127) return String.fromCharCode(b);
    if (b === 127) return "^?";
    return "M-" + showByte(b - 128, showTabs);
  }
  // The one canonical option set, shared by the defCmd and by the terminal
  // capture path in the shell (bare `cat` reading the tty).
  var CAT_OPTS = {
    short: { A: "bool", b: "bool", e: "bool", E: "bool", n: "bool",
             s: "bool", t: "bool", T: "bool", u: "bool", v: "bool" },
    long: {
      "show-all": ["bool", "A"], "number-nonblank": ["bool", "b"],
      "show-ends": ["bool", "E"], number: ["bool", "n"],
      "squeeze-blank": ["bool", "s"], "show-tabs": ["bool", "T"],
      "show-nonprinting": ["bool", "v"],
    },
  };
  // Fold -A/-e/-t into the -vET family and render a whole input string as
  // cat would.  Pure function (no shell, no streams) so the terminal capture
  // path can call it incrementally and cut off only what has grown.
  function catFormat(o, data) {
    var oo = {};
    for (var kk in o) oo[kk] = o[kk];
    if (oo.A) { oo.v = true; oo.E = true; oo.T = true; }
    if (oo.e) { oo.v = true; oo.E = true; }
    if (oo.t) { oo.v = true; oo.T = true; }
    var decorate = !!(oo.v || oo.T), ends = !!oo.E, squeeze = !!oo.s;
    var nonblank = !!oo.b, number = !!oo.b || !!oo.n;    // -b wins over -n

    var endsInNl = data.slice(-1) === "\n";
    var parts = data.split("\n");
    if (parts.length && parts[parts.length - 1] === "") parts.pop();
    var out = "", no = 1, prevBlank = false;
    for (var j = 0; j < parts.length; j++) {
      var line = parts[j];
      if (squeeze && line === "" && prevBlank) continue;
      var body = line;
      if (decorate) {
        var bs = utf8Bytes(line), s = "";
        for (var b = 0; b < bs.length; b++) s += showByte(bs[b], !!oo.T);
        body = s;
      }
      if (number && (!nonblank || line !== "")) {
        body = String(no).padStart(6) + "\t" + body;
        no++;
      }
      // every line carries a newline except the last one of an input that
      // did not end in one -- and -E only marks the newlines it sees.
      var nl = (j < parts.length - 1 || endsInNl) ? "\n" : "";
      if (ends && nl) body += "$";
      out += body + nl;
      prevBlank = line === "";
    }
    return out;
  }
  defCmd("cat", function (args, stdin, sh) {
    var g = getopt("cat", args, CAT_OPTS);
    var done = finish(sh, "cat", g);
    if (done) return done;

    var files = g._.length ? g._ : ["-"], data = "", code = 0, stdinTaken = false;
    for (var i = 0; i < files.length; i++) {
      var name = files[i];
      if (name === "-") { if (!stdinTaken) { data += stdin || ""; stdinTaken = true; } continue; }
      var p = sh.path(name), n = V.getNode(p);
      if (n && n.t === "d") {
        sh._error("cat: " + name + ": Is a directory"); code = 1; continue;
      }
      if (!n) {
        sh._error("cat: " + name + ": No such file or directory"); code = 1; continue;
      }
      var d = V.readFile(p);
      if (d === null) { sh._error("cat: " + name + ": No such file or directory"); code = 1; continue; }
      data += d;
    }
    return { out: catFormat(g.o, data), code: code };
  }, "cat - concatenate files and print");

  // A bare `cat` -- no files, no redirection, no pipe, terminal as stdin --
  // has nothing to do yet, so the shell runs it interactively (see the
  // capture path below): each line you type is copied, live, like a real
  // tty, and Ctrl-D ends the copying.  Returns null if this line is not the
  // bare terminal form.
  function catTerminalArgs(line) {
    var s = line.trim();
    if (!s) return null;
    // any structural character means this cat is part of a bigger command
    if (/[`|;&<>()]/.test(s) || /\$\(/.test(s)) return null;
    var toks = s.split(/\s+/);
    if (toks[0] !== "cat" || toks.length === 0) return null;
    var seenDashdash = false;
    for (var i = 1; i < toks.length; i++) {
      var t = toks[i];
      if (t === "--") { if (seenDashdash) return null; seenDashdash = true; continue; }
      if (!seenDashdash && t.charAt(0) === "-" && t.length > 1 && t !== "--") continue;
      if (t === "-" || t === "/dev/stdin" || t === "/dev/fd/0") continue;
      return null;                                     // a real file operand
    }
    return toks.slice(1);
  }

  function headTail(name, fromEnd) {
    defCmd(name, function (args, stdin, sh) {
      var o = opt(args, { arg: "nc" });
      var n = 10, from = null;
      if (o.n !== undefined && /^\+/.test(String(o.n))) from = parseInt(String(o.n).slice(1), 10) - 1;
      else if (o.n !== undefined) n = parseInt(o.n, 10) || 10;
      else if (o.c !== undefined) n = parseInt(o.c, 10) || 10;
      else for (var k in o) if (k !== "_" && /^[0-9]+$/.test(k) && o[k]) { n = parseInt(k, 10); break; }
      var files = o._.length ? o._ : ["-"], text = "";
      for (var i = 0; i < files.length; i++) {
        if (files[i] === "-") { text += stdin; continue; }
        var d = V.readFile(sh.path(files[i]));
        if (d === null) { sh._error(name + ": cannot open '" + files[i] + "' for reading: No such file or directory"); return { out: "", code: 1 }; }
        text += d;
      }
      var arr = text.split("\n"); if (arr[arr.length - 1] === "") arr.pop();
      if (fromEnd && from !== null) return { out: arr.slice(from).join("\n") + "\n", code: 0 };
      return { out: (fromEnd ? arr.slice(-n) : arr.slice(0, n)).join("\n") + "\n", code: 0 };
    }, name + " - output the " + (fromEnd ? "last" : "first") + " part of files");
  }
  headTail("head", false); headTail("tail", true);

  defCmd("wc", function (args, stdin, sh) {
    var o = opt(args, { bool: "lwc" });
    var files = o._.length ? o._ : ["-"], any = o.l || o.w || o.c, res = "";
    for (var i = 0; i < files.length; i++) {
      var text = files[i] === "-" ? stdin : V.readFile(sh.path(files[i]));
      if (text === null) { sh._error("wc: " + files[i] + ": No such file or directory"); return { out: "", code: 1 }; }
      var l = (text.match(/\n/g) || []).length;
      var w = text.trim() ? text.trim().split(/\s+/).length : 0;
      var parts = [];
      if (o.l || !any) parts.push(String(l).padStart(7));
      if (o.w || !any) parts.push(String(w).padStart(7));
      if (o.c || !any) parts.push(String(text.length).padStart(7));
      res += parts.join(" ") + (files[i] === "-" ? "" : " " + files[i]) + "\n";
    }
    return { out: res, code: 0 };
  }, "wc - print newline, word, and byte counts");

  defCmd("grep", function (args, stdin, sh) {
    var o = opt(args, { bool: "ivnEcH", long: ["color"] });
    if (o.color === "never") o.color = false;      // --color=never must win
    if (o.color === "auto" && !sh.term) o.color = false;
    if (!o._.length) { sh._error("grep: missing pattern"); return { out: "", code: 2 }; }
    var pat = o._.shift(), re;
    try { re = new RegExp(pat, o.i ? "i" : ""); }
    catch (e) { sh._error("grep: " + pat + ": invalid regular expression"); return { out: "", code: 2 }; }
    var files = o._.length ? o._ : ["-"], res = "", status = 1;
    for (var i = 0; i < files.length; i++) {
      var text = files[i] === "-" ? stdin : V.readFile(sh.path(files[i]));
      if (text === null) { sh._error("grep: " + files[i] + ": No such file or directory"); continue; }
      var arr = text.split("\n"); if (arr[arr.length - 1] === "") arr.pop();
      var count = 0;
      for (var j = 0; j < arr.length; j++) {
        if (re.test(arr[j]) !== !!o.v) {
          status = 0;
          count++;
          if (o.c) continue;
          var line = ((files.length > 1 && !o.h) ? files[i] + ":" : "") + (o.n ? (j + 1) + ":" : "") + arr[j];
          if (o.color) line = line.replace(re, function (m) { return sgr("01;31") + m + sgr("0"); });
          res += line + "\n";
        }
      }
      if (o.c) res += String(count) + (files.length > 1 ? ":" + files[i] : "") + "\n";
    }
    return { out: res, code: status };
  }, "grep - print lines matching a pattern");

  defCmd("sort", function (args, stdin, sh) {
    var o = opt(args, { bool: "rnu", arg: "k" });
    var text = o._.length ? V.readFile(sh.path(o._[0])) : stdin;
    if (text === null) { sh._error("sort: " + o._[0] + ": No such file or directory"); return { out: "", code: 2 }; }
    var arr = text.split("\n"); if (arr[arr.length - 1] === "") arr.pop();
    arr.sort(function (a, b) {
      var r = o.n ? (parseFloat(a) - parseFloat(b)) : (a < b ? -1 : a > b ? 1 : 0);
      return o.r ? -r : r;
    });
    if (o.u) arr = arr.filter(function (v, i2) { return i2 === 0 || v !== arr[i2 - 1]; });
    return { out: arr.join("\n") + (arr.length ? "\n" : ""), code: 0 };
  }, "sort - sort lines of text files");

  defCmd("uniq", function (args, stdin, sh) {
    var o = opt(args, { bool: "cdu" });
    var text = args.length ? V.readFile(sh.path(args[0])) : stdin;
    var arr = text.split("\n"); if (arr[arr.length - 1] === "") arr.pop();
    var res = "", prev = null, count = 0;
    function flush() {
      if (prev === null) return;
      var pre = o.c ? String(count).padStart(7) + " " : "";
      if (o.u) { if (count === 1) res += prev + "\n"; }
      else if (o.d) { if (count > 1) res += pre + prev + "\n"; }
      else res += pre + prev + "\n";
    }
    arr.forEach(function (l) { if (l === prev) count++; else { flush(); prev = l; count = 1; } });
    flush();
    return { out: res, code: 0 };
  }, "uniq - report or omit repeated lines");

  defCmd("cut", function (args, stdin, sh) {
    var o = opt(args, { arg: "cdf", bool: "s", long: ["output-delimiter"] });
    if (o.c !== undefined) {                     // cut -c<list>
      var text = o._.length ? V.readFile(sh.path(o._[0])) : stdin;
      var arr = text.split("\n"); if (arr[arr.length - 1] === "") arr.pop();
      var ranges = String(o.c).split(",").map(function (x) {
        var r = /^(\d+)-(\d*)$/.exec(x);
        return r ? { a: +r[1], b: r[2] ? +r[2] : 1e9 } : { a: +x, b: +x };
      });
      var outArr = arr.map(function (l) {
        var pick = "";
        ranges.forEach(function (r) {
          for (var i = r.a; i <= Math.min(r.b, l.length); i++) pick += l.charAt(i - 1);
        });
        return pick;
      });
      return { out: outArr.join("\n") + (outArr.length ? "\n" : ""), code: 0 };
    }
    var delim = o.d === undefined ? "\t" : o.d;
    var fields = (o.f || "1").split(",").map(function (x) {
      var r = /^(\d+)-(\d*)$/.exec(x);
      return r ? { a: +r[1], b: r[2] ? +r[2] : 1e9 } : { a: +x, b: +x };
    });
    var text = o._.length ? V.readFile(sh.path(o._[0])) : stdin;
    var arr = text.split("\n"); if (arr[arr.length - 1] === "") arr.pop();
    var outArr = [];
    arr.forEach(function (l) {
      var parts = l.split(delim), sel = [];
      fields.forEach(function (f) { for (var i = f.a; i <= Math.min(f.b, parts.length); i++) sel.push(parts[i - 1]); });
      if (sel.length) outArr.push(sel.join(o["output-delimiter"] === undefined ? delim : o["output-delimiter"]));
    });
    return { out: outArr.join("\n") + (outArr.length ? "\n" : ""), code: 0 };
  }, "cut - remove sections from each line of files");

  defCmd("tr", function (args, stdin) {
    if (args.length < 2) { return { out: stdin, code: 1 }; }
    var s1 = args[0], s2 = args[1];
    if (s1 === "a-z" && s2 === "A-Z") return { out: stdin.toUpperCase(), code: 0 };
    if (s1 === "A-Z" && s2 === "a-z") return { out: stdin.toLowerCase(), code: 0 };
    var res = "";
    for (var i = 0; i < stdin.length; i++) {
      var k = s1.indexOf(stdin.charAt(i));
      res += k < 0 ? stdin.charAt(i) : s2.charAt(Math.min(k, s2.length - 1));
    }
    return { out: res, code: 0 };
  }, "tr - translate or delete characters");

  defCmd("sed", function (args, stdin, sh) {
    var o = opt(args, { bool: "n", arg: "e" });
    var script = o.e || o._.shift();
    var text = o._.length ? V.readFile(sh.path(o._[0])) : stdin;
    var m = /^s(.)(.*?)\1(.*?)\1([gi]*)$/.exec(script || "");
    if (!m) return { out: text, code: 0 };
    var re = new RegExp(m[2], m[4].indexOf("g") >= 0 ? "g" : "");
    var arr = text.split("\n"); if (arr[arr.length - 1] === "") arr.pop();
    return { out: arr.map(function (l) { return l.replace(re, m[3]); }).join("\n") + "\n", code: 0 };
  }, "sed - stream editor (s/// only)");

  defCmd("tac", function (args, stdin, sh) {
    var text = args.length ? V.readFile(sh.path(args[0])) : stdin;
    var arr = text.split("\n"); if (arr[arr.length - 1] === "") arr.pop();
    return { out: arr.reverse().join("\n") + "\n", code: 0 };
  }, "tac - concatenate and print files in reverse");
  defCmd("rev", function (args, stdin, sh) {
    var text = args.length ? V.readFile(sh.path(args[0])) : stdin;
    var arr = text.split("\n"); if (arr[arr.length - 1] === "") arr.pop();
    return { out: arr.map(function (l) { return l.split("").reverse().join(""); }).join("\n") + "\n", code: 0 };
  }, "rev - reverse lines characterwise");
  defCmd("nl", function (args, stdin, sh) {
    var text = args.length ? V.readFile(sh.path(args[0])) : stdin;
    var arr = text.split("\n"); if (arr[arr.length - 1] === "") arr.pop();
    return { out: arr.map(function (l, i) { return String(i + 1).padStart(6) + "\t" + l; }).join("\n") + "\n", code: 0 };
  }, "nl - number lines");

  function cmdEcho(args) {
    var o = opt(args, { bool: "neE" });
    var text = o._.join(" ");
    if (o.e) {
      var r = expandEscapes(text);
      text = r.text;
      if (r.stop) return { out: text, code: 0 };
    }
    return { out: text + (o.n ? "" : "\n"), code: 0 };
  }
  defCmd("echo", cmdEcho, "echo - write arguments to standard output");
  defBui("echo", cmdEcho);

  // printf(1): the format is reused until the arguments run out, so
  // `printf 'a%.0s' 1 2 3` prints aaa, and a missing argument is empty.
  // The conversion is %[flags][width][.precision]conv, with `*` taking the
  // width or precision from the argument list.
  var PRINTF_RE = /%([-+ #0']*)(\d+|\*)?(?:\.(\d+|\*))?([sdbxXouefgc])/g;

  function cmdPrintf(args) {
    if (!args.length) return { out: "", code: 0 };
    var fmt = expandEscapes(args.shift()).text;
    var out = "", argi = 0;                    // the cursor spans every pass

    do {
      var m, i, pass = "", at = 0, converted = false;
      i = argi;
      PRINTF_RE.lastIndex = 0;
      while ((m = PRINTF_RE.exec(fmt)) !== null) {
        pass += fmt.slice(at, m.index).replace(/%%/g, "%");
        at = m.index + m[0].length;
        converted = true;
        var flags = m[1] || "", conv = m[4];
        var width = m[2] === "*" ? (i < args.length ? parseInt(args[i++], 10) || 0 : 0)
          : m[2] ? parseInt(m[2], 10) : 0;
        var prec = m[3] === "*" ? (i < args.length ? parseInt(args[i++], 10) || 0 : 0)
          : m[3] !== undefined ? parseInt(m[3], 10) : undefined;
        var raw = i < args.length ? args[i++] : "";
        var a = raw, text;
        switch (conv) {
          case "d": case "i": case "u":
            a = String(parseInt(raw, 10) || 0);
            if (prec !== undefined) a = String(Math.abs(parseInt(raw, 10) || 0)).padStart(prec, "0");
            text = (flags.indexOf("+") >= 0 && parseInt(raw, 10) >= 0 ? "+" : "") + a;
            break;
          case "f": case "e": case "g":
            text = (parseFloat(raw) || 0).toFixed(prec === undefined ? 6 : prec);
            break;
          case "x": text = (parseInt(raw, 10) || 0).toString(16); break;
          case "X": text = (parseInt(raw, 10) || 0).toString(16).toUpperCase(); break;
          case "o": text = (parseInt(raw, 10) || 0).toString(8); break;
          case "c": text = raw ? raw.charAt(0) : ""; break;
          case "b": text = expandEscapes(raw).text; break;
          default: text = raw;
        }
        if (conv === "s" && prec !== undefined) text = text.slice(0, prec);
        if (width) {
          if (flags.indexOf("-") >= 0) text = text.padEnd(width, " ");
          else if (flags.indexOf("0") >= 0 && "dioxXuf".indexOf(conv) >= 0) {
            text = (text[0] === "+" || text[0] === "-" ? text[0] + text.slice(1).padStart(width - 1, "0")
              : text.padStart(width, "0"));
          } else text = text.padStart(width, " ");
        }
        pass += text;
      }
      // a format with no conversion prints once, with %% collapsed
      if (!converted) { out += fmt.replace(/%%/g, "%"); break; }
      out += pass + fmt.slice(at).replace(/%%/g, "%");
      argi = i;
    } while (i < args.length);

    return { out: out, code: 0 };
  }
  defCmd("printf", cmdPrintf, "printf - format and print data");
  defBui("printf", cmdPrintf);

  defCmd("seq", function (args) {
    var a = args.map(Number), start = 1, step = 1, end;
    if (a.length === 1) end = a[0];
    else if (a.length === 2) { start = a[0]; end = a[1]; }
    else { start = a[0]; step = a[1]; end = a[2]; }
    var res = [];
    for (var v = start; step > 0 ? v <= end : v >= end; v += step) res.push(v);
    return { out: res.join("\n") + (res.length ? "\n" : ""), code: 0 };
  }, "seq - print a sequence of numbers");

  function cmdTrue() { return { out: "", code: 0 }; }
  function cmdFalse() { return { out: "", code: 1 }; }
  defCmd("true", cmdTrue); defBui("true", cmdTrue);
  defCmd("false", cmdFalse); defBui("false", cmdFalse);
  // yes(1) never ends; a finite run stands in for that, long enough that
  // `yes | head -n 40` sees forty lines, which is how it is normally used.
  defCmd("yes", function (args) {
    var line = (args.join(" ") || "y") + "\n";
    var out = "";
    for (var i = 0; i < 10000; i++) out += line;
    return { out: out, code: 0 };
  });
  defCmd("sleep", function (args) { return { out: "", code: 0, sleep: parseFloat(args[0] || "1") }; });

  defCmd("uname", function (args) {
    var o = opt(args, { bool: "asrvmnpo", long: ["all", "kernel-name", "kernel-release", "machine"] });
    if (o.a || o.all) return { out: "Linux " + HOST + " 7.2.8 #1 SMP PREEMPT_DYNAMIC Thu Oct 2 21:14:07 UTC 2026 x86_64 GNU/Linux\n", code: 0 };
    var parts = [];
    if (o.s || o["kernel-name"] || !(o.r || o.v || o.m || o.n || o.p || o.o)) parts.push("Linux");
    if (o.r || o["kernel-release"]) parts.push("7.2.8");
    if (o.v) parts.push("#1 SMP PREEMPT_DYNAMIC Thu Oct 2 21:14:07 UTC 2026");
    if (o.m || o["machine"]) parts.push("x86_64");
    if (o.n) parts.push(HOST);
    if (o.p) parts.push("x86_64");
    if (o.o) parts.push("GNU/Linux");
    return { out: parts.join(" ") + "\n", code: 0 };
  }, "uname - print system information");

  defCmd("whoami", function () { return { out: USER + "\n", code: 0 }; }, "print effective user name");
  defCmd("id", function () { return { out: "uid=1000(linuxweb) gid=1000(linuxweb) groups=1000(linuxweb),27(sudo)\n", code: 0 }; }, "print user and group IDs");
  defCmd("groups", function () { return { out: "linuxweb sudo\n", code: 0 }; });
  defCmd("hostname", function () { return { out: HOST + "\n", code: 0 }; }, "show the system's host name");
  defCmd("tty", function () {
    var n = LW.VTs ? LW.VTs.activeVt() : 1;
    return { out: "/dev/tty" + n + "\n", code: 0 };
  }, "print the file name of the terminal connected to standard input");

  defCmd("fgconsole", function () {
    return { out: String(LW.VTs ? LW.VTs.activeVt() : 1) + "\n", code: 0 };
  }, "print the number of the active virtual terminal");

  defCmd("chvt", function (args) {
    var n = parseInt(args[0], 10);
    if (!n) { return { out: "", code: 1 }; }
    if (!LW.VTs || !LW.VTs.switchTo(n)) return { out: "", code: 1 };
    return { out: "", code: 0 };
  }, "change the foreground virtual terminal");

  defCmd("date", function (args) {
    var d = new Date();
    var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var mons = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    function two(n) { return String(n).padStart(2, "0"); }
    var s = days[d.getUTCDay()] + " " + mons[d.getUTCMonth()] + " " + String(d.getUTCDate()).padStart(2, " ") +
      " " + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds()) + " UTC " + d.getUTCFullYear();
    if (args.length && args[0].charAt(0) === "+") {
      s = args[0].slice(1).replace(/%Y/g, d.getUTCFullYear()).replace(/%m/g, two(d.getUTCMonth() + 1))
        .replace(/%d/g, two(d.getUTCDate())).replace(/%H/g, two(d.getUTCHours()))
        .replace(/%M/g, two(d.getUTCMinutes())).replace(/%S/g, two(d.getUTCSeconds()));
    }
    return { out: s + "\n", code: 0 };
  }, "print the system date and time");

  defCmd("uptime", function () { return { out: " 09:14:03 up 15 min,  1 user,  load average: 0.00, 0.01, 0.00\n", code: 0 }; }, "tell how long the system has been running");

  defCmd("free", function (args) {
    var h = args.indexOf("-h") >= 0;
    var row = h ? "1.9Gi      393Mi      1.4Gi      12Mi      402Mi      1.6Gi"
      : "2032604    1452336     402116       18896     413344    1729108";
    return { out: "               total        used        free      shared  buff/cache   available\n" +
      "Mem:      " + row + "\nSwap:           0           0           0\n", code: 0 };
  }, "display amount of free and used memory");

  defCmd("df", function (args) {
    var h = args.indexOf("-h") >= 0;
    return { out: "Filesystem      Size  Used Avail Use% Mounted on\n" + (h
      ? "/dev/sda2        39G  8.2G   29G  23% /\ntmpfs           200M  1.2M  199M   1% /run\n/dev/sda1       511M  8.9M  503M   2% /boot/efi\ntmpfs           1.0G   16K  1.0G   1% /dev/shm\n"
      : "/dev/sda2    39845888 8567804 29246992  23% /\ntmpfs          204276    1240   203036   1% /run\n"), code: 0 };
  }, "report file system disk space usage");

  defCmd("du", function (args, stdin, sh) {
    var o = opt(args, { bool: "sh" });
    var target = o._[0] || ".";
    function size(path) {
      var n = V.getNode(path);
      if (!n) return 0;
      if (n.t === "f") return n.get ? 0 : (n.d || "").length;
      var t = 4096;
      Object.keys(n.c).forEach(function (k) { t += size(path + "/" + k); });
      return t;
    }
    var s = size(sh.path(target));
    return { out: (o.h ? human(s) : String(Math.ceil(s / 1024))) + "\t" + target + "\n", code: 0 };
  }, "estimate file space usage");

  defCmd("ps", function () {
    return { out: "    PID TTY          TIME CMD\n    901 tty1     00:00:00 bash\n   1042 tty1     00:00:00 ps\n", code: 0 };
  }, "report a snapshot of current processes");

  defCmd("env", function (args, stdin, sh) {
    var res = "";
    Object.keys(sh.env).sort().forEach(function (k) { res += k + "=" + sh.env[k] + "\n"; });
    return { out: res, code: 0 };
  }, "print the environment");
  defCmd("printenv", function (args, stdin, sh) {
    if (args.length) return { out: (sh.env[args[0]] !== undefined ? sh.env[args[0]] + "\n" : ""), code: sh.env[args[0]] !== undefined ? 0 : 1 };
    return CMDS.env.run(args, stdin, sh);
  }, "print all or part of environment");

  defCmd("mount", function (args) {
    if (args.indexOf("-t") >= 0 && args.indexOf("idbfs") >= 0) {
      return { out: "idbfs mounted on / (IndexedDB)\n", code: 0 };
    }
    var extra = LW.DEV
      ? "devtmpfs on /dev type devtmpfs (rw,nosuid,relatime,size=1009540k,nr_inodes=252385,mode=755)\n"
      : "";
    return { out: V.mountsText() + extra, code: 0 };
  }, "show mounted filesystems");

  defCmd("idbfs", function (args) {
    var o = opt(args, { bool: "a", long: ["stats", "sync", "populate"] });
    if (o.sync || o.populate) {
      // asynchronous: report when the flush lands
      var self = this;
      V.syncfs(!!o.populate, function (ok) {
        self.term.write("idbfs: syncfs" + (o.populate ? " populate" : "") +
          (ok ? " ok" : " failed") + "\n");
        self.term.render();
      });
      return { out: "", code: 0 };
    }
    var s = V.stats();
    var rows = [
      "idbfs on / type idbfs (rw,auto-persist=" + s.autoPersist + ")",
      "  store:    " + (s.open ? "linuxweb-vfs (IndexedDB)" : "not mounted"),
      "  records:  " + s.records + " (" + s.files + " files, " + s.dirs + " dirs)",
      "  bytes:    " + s.bytes,
      "  pending:  " + s.pending + " write(s) queued",
      s.error ? "  error:    " + s.error : "",
    ].filter(Boolean);
    return { out: rows.join("\n") + "\n", code: 0 };
  }, "inspect the IndexedDB filesystem");

  defCmd("lsblk", function () {
    if (!LW.DEV) return { out: "lsblk: devtmpfs is not mounted\n", code: 1 };
    var mounts = { sda1: "/boot/efi", sda2: "/", sda3: "[SWAP]", sr0: "/media/cdrom" };
    var blocks = LW.DEV.filter("b");
    var out = "NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS\n";
    blocks.filter(function (n) { return n.name.indexOf("loop") !== 0; }).forEach(function (n) {
      var kids = blocks.filter(function (k) { return k.name !== n.name && k.name.indexOf(n.name) === 0; });
      out += n.name.padEnd(6) + String(n.major + ":" + n.minor).padStart(6) + "  0 " +
        ((n.blocks / 2097152).toFixed(1) + "G").padStart(5) + "  0 " + (kids.length ? "disk" : "disk") + " \n";
      kids.forEach(function (k) {
        var sz = k.blocks >= 1048576 ? (k.blocks / 2097152).toFixed(1) + "G" : Math.round(k.blocks / 1024) + "M";
        out += "\u251c\u2500" + k.name.padEnd(4) + String(k.major + ":" + k.minor).padStart(6) + "  0 " +
          sz.padStart(5) + "  0 part " + (mounts[k.name] || "") + "\n";
      });
    });
    return { out: out, code: 0 };
  }, "list block devices");

  defCmd("mknod", function (args) {
    if (!LW.DEV) return { out: "mknod: devtmpfs is not mounted\n", code: 1 };
    if (args.length < 4) {
      return { out: "mknod: missing operand\nUsage: mknod NAME TYPE MAJOR MINOR\n", code: 1 };
    }
    var r = LW.DEV.mknod(args[0], args[1], parseInt(args[2], 10), parseInt(args[3], 10));
    if (r.msg) { this._error(r.msg); return { out: "", code: r.code }; }
    return { out: "", code: 0 };
  }, "make block or character special files");

  defCmd("udevadm", function (args) {
    if (!LW.DEV) return { out: "udevadm: devtmpfs is not mounted\n", code: 1 };
    if (args[0] === "trigger") return { out: "", code: 0 };
    if (args[0] === "info") {
      var name = null;
      for (var di = 0; di < args.length; di++) {
        if (args[di] === "-n" || args[di] === "--name") { name = args[++di]; }
        else if (args[di].charAt(0) !== "-" && args[di] !== "info" && !name) name = args[di];
      }
      if (!name) return { out: "udevadm info: missing device name\n", code: 1 };
      var n = LW.DEV.get(String(name).replace(/^\/dev\//, ""));
      if (!n) return { out: "udevadm info: " + name + ": not a device\n", code: 1 };
      return { out: [
        "P: /devices/virtual/" + n.class + "/" + n.name, "N: " + n.name,
        "E: DEVNAME=/dev/" + n.name, "E: MAJOR=" + n.major, "E: MINOR=" + n.minor,
        "E: DEVTYPE=" + (n.class === "sd" || n.class === "loop" ? "disk" : "generic"),
        "E: SUBSYSTEM=" + n.class,
      ].join("\n") + "\n", code: 0 };
    }
    return { out: "udevadm: unknown command '" + (args[0] || "") + "'\n", code: 1 };
  }, "udev management tool");

  defCmd("hotplug", function (args) {
    if (!LW.DEV) return { out: "hotplug: devtmpfs is not mounted\n", code: 1 };
    var name = null, remove = false;
    args.forEach(function (a) {
      if (a === "--remove" || a === "-r") remove = true;
      else if (a.charAt(0) !== "-" && name === null) name = a;
    });
    if (!name) {
      return { out: "devices: " + LW.DEV.list().map(function (n) { return n.name; }).join(" ") +
        "\nplug with: hotplug sdb | hotplug --remove sdb\n", code: 0 };
    }
    if (remove) {
      if (!LW.DEV.unregister(name)) return { out: "hotplug: " + name + ": no such device\n", code: 1 };
      return { out: "hotplug: " + name + " removed \u2014 the node is gone from /dev\n", code: 0 };
    }
    var d = LW.DEV.hotplug(name);
    if (!d) return { out: "hotplug: no such device '" + name + "'\n", code: 1 };
    return { out: "[" + d.major + ":" + d.minor + "] " + d.name + ": new " +
      (d.type === "b" ? "block" : "char") + " device, node created in /dev\n", code: 0 };
  }, "plug or unplug an emulated device");

  defCmd("dmesg", function (args) {
    var log = (LW.stampedLog || LW.plainLog || "").replace(/\x1b\[[0-9;:]*m/g, "");
    var arr = log.split("\n");
    if (arr[arr.length - 1] === "") arr.pop();
    if (args.length && /^\d+$/.test(args[0])) arr = arr.slice(-parseInt(args[0], 10));
    if (args.indexOf("-t") >= 0) arr = arr.map(function (l) { return l.replace(/^\[\s*\d+\.\d+\]\s?/, ""); });
    return { out: arr.join("\n") + "\n", code: 0 };
  }, "print or control the kernel ring buffer");

  defCmd("stat", function (args, stdin, sh) {
    if (!args.length) { sh._error("stat: missing operand"); return { out: "", code: 1 }; }
    var p = sh.path(args[0]), n = V.getNode(p);
    if (!n) { sh._error("stat: cannot statx '" + args[0] + "': No such file or directory"); return { out: "", code: 1 }; }
    var kind = n.t === "d" ? "directory" : n.t === "l" ? "symbolic link"
      : n.dev ? (n.devType === "b" ? "block special file" : "character special file") : "regular file";
    if (n.dev) {
      return { out: "  File: " + args[0] + "\n" +
        "  Size: 0\tBlocks: 0          IO Block: 4096   " + kind + "\n" +
        "Device: " + n.major + "," + n.minor + "\tInode: 8           Links: 1     Device type: " +
        n.major + "," + n.minor + "\n" +
        "Access: (0666/" + (n.devType === "b" ? "brw-rw----" : "crw-rw-rw-") + ")\n", code: 0 };
    }
    return { out: "  File: " + args[0] + "\n" +
      "  Size: " + (n.t === "f" ? (n.d || "").length : 4096) + "\tBlocks: 8          IO Block: 4096   " + kind + "\n" +
      "Device: 8,2\tInode: 262147      Links: 1\n" +
      "Access: (0755/" + (n.t === "d" ? "drwxr-xr-x" : "-rwxr-xr-x") + ")\n" +
      "Modify: 2026-10-03 09:14:02.000000000 +0000\n", code: 0 };
  }, "display file or file system status");

  defCmd("file", function (args, stdin, sh) {
    var res = "";
    args.forEach(function (a) {
      var n = V.getNode(sh.path(a));
      res += a + ": " + (!n ? "cannot open `" + a + "' (No such file or directory)"
        : n.t === "d" ? "directory" : n.t === "l" ? "symbolic link" : "ASCII text") + "\n";
    });
    return { out: res, code: 0 };
  }, "determine file type");

  defCmd("tree", function (args, stdin, sh) {
    var last = args.filter(function (a) { return a.charAt(0) !== "-"; }).pop();
    var start = sh.path(last || ".");
    var linesOut = [start], dirs = 0, files = 0;
    (function walk(path, prefix) {
      var n = V.getNode(path);
      if (!n || n.t !== "d") return;
      var names = Object.keys(n.c).sort();
      names.forEach(function (nm, i) {
        var lastOne = i === names.length - 1, child = n.c[nm];
        linesOut.push(prefix + (lastOne ? "\u2514\u2500\u2500 " : "\u251c\u2500\u2500 ") + nm);
        if (child.t === "d") { dirs++; walk(path + "/" + nm, prefix + (lastOne ? "    " : "\u2502   ")); }
        else files++;
      });
    })(start, "");
    linesOut.push("", dirs + " directories, " + files + " files");
    return { out: linesOut.join("\n") + "\n", code: 0 };
  }, "list contents of directories in a tree-like format");

  defCmd("find", function (args, stdin, sh) {
    var start = ".", name = null;
    for (var i = 0; i < args.length; i++) {
      if (args[i] === "-name") name = args[++i];
      else if (args[i].charAt(0) !== "-") start = args[i];
    }
    var base = sh.path(start), re = name ? V.globToRe(name) : null, res = [];
    (function walk(path, isRoot) {
      var n = V.getNode(path);
      if (!n) return;
      if (!isRoot && (!re || re.test(V.baseName(path)))) res.push(path);
      if (n.t === "d") Object.keys(n.c).forEach(function (k) { walk(path + "/" + k, false); });
    })(base, true);
    return { out: res.join("\n") + (res.length ? "\n" : ""), code: 0 };
  }, "search for files in a directory hierarchy");

  defCmd("which", function (args) {
    var res = "", code = 0;
    args.forEach(function (a) {
      if (CMDS[a] || BUILTIN[a] || BUI[a]) res += "/usr/bin/" + a + "\n"; else code = 1;
    });
    return { out: res, code: code };
  }, "locate a command");

  defCmd("basename", function (args, stdin, sh) {
    var b = V.baseName(sh.path(args[0] || ""));
    var sfx = args[1];
    if (sfx && b.slice(-sfx.length) === sfx) b = b.slice(0, -sfx.length);
    return { out: b + "\n", code: 0 };
  }, "strip directory and suffix from filenames");
  defCmd("dirname", function (args, stdin, sh) {
    var p = sh.path(args[0] || ".");
    var i = p.lastIndexOf("/");
    return { out: (i <= 0 ? "/" : p.slice(0, i)) + "\n", code: 0 };
  }, "strip last component from file name");

  defCmd("tee", function (args, stdin, sh) {
    var o = opt(args, { bool: "a" });
    o._.forEach(function (f) { V.writeFile(sh.path(f), stdin, !!o.a); });
    return { out: stdin, code: 0 };
  }, "read from stdin and write to stdout and files");

  defCmd("touch", function (args, stdin, sh) {
    args.forEach(function (a) { var p = sh.path(a); if (!V.getNode(p)) V.writeFile(p, "", false); });
    return { out: "", code: 0 };
  }, "change file timestamps");
  defCmd("mkdir", function (args, stdin, sh) {
    var o = opt(args, { bool: "p" }), code = 0;
    o._.forEach(function (a) {
      var p = sh.path(a);
      if (o.p) { V.mkdirp(p); return; }
      var par = V.getNode(V.parentOf(p));
      if (!par || par.t !== "d") { sh._error("mkdir: cannot create directory '" + a + "': No such file or directory"); code = 1; return; }
      if (par.c[V.baseName(p)]) { sh._error("mkdir: cannot create directory '" + a + "': File exists"); code = 1; return; }
      par.c[V.baseName(p)] = V.dir({});
      V.persist(p);
    });
    return { out: "", code: code };
  }, "make directories");
  defCmd("rm", function (args, stdin, sh) {
    var o = opt(args, { bool: "rfv", long: ["recursive", "force"] }), code = 0;
    o._.forEach(function (a) {
      var p = sh.path(a), par = V.getNode(V.parentOf(p)), nm = V.baseName(p);
      if (!par || par.t !== "d" || !par.c[nm]) {
        if (!(o.f || o.force)) { sh._error("rm: cannot remove '" + a + "': No such file or directory"); code = 1; }
        return;
      }
      if (par.c[nm].t === "d" && !(o.r || o.recursive)) { sh._error("rm: cannot remove '" + a + "': Is a directory"); code = 1; return; }
      V.unlink(p);
    });
    return { out: "", code: code };
  }, "remove files or directories");
  defCmd("cp", function (args, stdin, sh) {
    var o = opt(args, { bool: "rR", long: ["recursive"] });
    if (o._.length < 2) { sh._error("cp: missing destination file operand"); return { out: "", code: 1 }; }
    var dst = sh.path(o._.pop()), code = 0;
    o._.forEach(function (a) {
      var src = sh.path(a), n = V.getNode(src);
      if (!n) { sh._error("cp: cannot stat '" + a + "': No such file or directory"); code = 1; return; }
      if (n.t === "d" && !(o.r || o.R || o.recursive)) { sh._error("cp: -r not specified; omitting directory '" + a + "'"); code = 1; return; }
      var target = V.isDir(dst) ? dst + "/" + V.baseName(src) : dst;
      if (n.t === "f") {
        var par = V.getNode(V.parentOf(target));
        if (par) { par.c[V.baseName(target)] = V.file(n.get ? n.get() : n.d); V.persist(target); }
      } else {
        V.mkdirp(target);
        (function rec(s, t) {
          var sn = V.getNode(s);
          Object.keys(sn.c).forEach(function (k) {
            if (sn.c[k].t === "d") { V.mkdirp(t + "/" + k); rec(s + "/" + k, t + "/" + k); }
            else { V.writeFile(t + "/" + k, sn.c[k].d || "", false); }
          });
        })(src, target);
      }
    });
    return { out: "", code: code };
  }, "copy files and directories");
  defCmd("mv", function (args, stdin, sh) {
    if (args.length < 2) { sh._error("mv: missing destination file operand"); return { out: "", code: 1 }; }
    var dst = sh.path(args.pop()), code = 0;
    args.forEach(function (a) {
      var src = sh.path(a), par = V.getNode(V.parentOf(src)), nm = V.baseName(src);
      if (!par || !par.c[nm]) { sh._error("mv: cannot stat '" + a + "': No such file or directory"); code = 1; return; }
      var n = par.c[nm], target = V.isDir(dst) ? dst + "/" + nm : dst;
      var dpar = V.getNode(V.parentOf(target));
      if (!dpar) { code = 1; return; }
      dpar.c[V.baseName(target)] = n;
      delete par.c[nm];
      V.persistTree(target);
      V.deleteTree(src);
    });
    return { out: "", code: code };
  }, "move (rename) files");
  defCmd("ln", function (args, stdin, sh) {
    var o = opt(args, { bool: "s", long: ["symbolic"] });
    if (o._.length < 2) { sh._error("ln: missing file operand"); return { out: "", code: 1 }; }
    var par = V.getNode(V.parentOf(sh.path(o._[1])));
    if (par) { par.c[V.baseName(o._[1])] = { t: "l", to: o._[0] }; V.persist(sh.path(o._[1])); }
    return { out: "", code: 0 };
  }, "make links between files");
  defCmd("chmod", function (args) {
    if (args.length < 2) { return { out: "", code: 1 }; }
    return { out: "", code: 0 };
  }, "change file mode bits");

  defCmd("man", function (args) {
    if (!args.length) { return { out: "", code: 1 }; }
    var t = args[0];
    var pages = {
      ls: ["LS(1)", "", "NAME", "       ls - list directory contents", "", "SYNOPSIS",
        "       ls [OPTION]... [FILE]...", "", "DESCRIPTION",
        "       List information about the FILEs (the current directory by default)."],
      bash: ["BASH(1)", "", "NAME", "       bash - GNU Bourne-Again SHell", "", "SYNOPSIS",
        "       bash [options] [command_string | file]"],
    };
    return { out: (pages[t] || [t.toUpperCase() + "(1)", "", "NAME", "       no manual entry for " + t]).join("\n") + "\n", code: 0 };
  }, "an interface to the system reference manuals");

  // ---- bash / sh -------------------------------------------------------------
  //
  // Running `bash` by itself starts a real interactive sub-shell on the same
  // tty and drops back to the parent on `exit` (or Ctrl-D on an empty line),
  // exactly a real login.  `bash -c 'LINE'` runs the string and
  // `bash script.sh` runs the script, like the real thing.
  function shProgram(prog, args, stdin, sh) {
    var scriptIdx = -1;
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a === "--") break;
      if (a === "-c" || (a.charAt(0) === "-" && a.charAt(1) !== "-" && a.indexOf("c") >= 0)) {
        scriptIdx = i + 1; break;
      }
      if (a.charAt(0) !== "-") break;      // a script path
    }
    if (scriptIdx >= 0) {
      if (scriptIdx >= args.length) {
        sh._error(prog + ": -c: option requires an argument");
        return { out: "", code: 2 };
      }
      try {
        sh.runLine(args[scriptIdx], false);
      } catch (e) {
        // an exit in the -c script ends it, not the parent shell
        if (!(e && (e.__exit !== undefined || e.__return !== undefined))) throw e;
      }
      return { out: sh.lastOut, code: sh.status };
    }
    if (args.length && args[0].charAt(0) !== "-") {
      var d = V.readFile(sh.path(args[0]));
      if (d === null) { sh._error(prog + ": " + args[0] + ": No such file or directory"); return { out: "", code: 127 }; }
      return sh.bi_source([args[0]]);
    }
    // interactive: a fresh shell on the same tty keeps the user's identity,
    // working directory, and environment, the way a real sub-shell does
    var child = new Shell(sh.term);
    child.applyUser(sh.env.USER || USER);
    for (var k in sh.env) child.env[k] = sh.env[k];
    child.cwd = sh.cwd;
    child.env.PWD = sh.cwd;
    child.status = sh.status;
    sh._child = child;
    child.start(false);
    return { out: "", code: 0 };
  }
  defCmd("bash", function (args, stdin, sh) { return shProgram("bash", args, stdin, sh); },
    "bash - GNU Bourne-Again SHell");
  defCmd("sh", function (args, stdin, sh) { return shProgram("sh", args, stdin, sh); },
    "sh - invoke the GNU command interpreter");

  // ===================== shell =====================

  function decodePrompt(s, sh) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch !== "\\") { out += ch; continue; }
      var n = s.charAt(++i);
      // numeric escapes, which is how prompts spell colours: \033 (octal) and
      // \x1b (hex).  (\u stays the username, as in bash.)
      if (n === "x" || (n >= "0" && n <= "7")) {
        var m = /^(x[0-9a-fA-F]{1,2}|[0-7]{1,3})/.exec(s.slice(i));
        if (m) {
          var tok = m[0];
          var v = tok.charAt(0) === "x" ? parseInt(tok.slice(1), 16) : parseInt(tok, 8);
          if (!isNaN(v)) out += String.fromCharCode(v);
          i += tok.length - 1;
          continue;
        }
      }
      switch (n) {
        case "u": out += sh.env.USER; break;
        case "h": out += HOST.split(".")[0]; break;
        case "H": out += HOST; break;
        case "w": {
          var w = sh.cwd;
          if (w === HOME) w = "~";
          else if (w.indexOf(HOME + "/") === 0) w = "~" + w.slice(HOME.length);
          out += w; break;
        }
        case "W": out += V.baseName(sh.cwd) || "/"; break;
        case "s": out += "bash"; break;
        case "v": out += LW.BASH.version; break;
        case "V": out += LW.BASH.versionString; break;
        case "$": out += sh.isRoot ? "#" : "$"; break;
        case "n": out += "\n"; break;
        case "t": out += LW.clock(); break;
        case "d": out += "Sat Oct 03"; break;
        case "e": out += "\x1b"; break;
        case "[": case "]": break;
        case "\\": out += "\\"; break;
        default: out += n;
      }
    }
    return out;
  }

  function Shell(term) {
    this.term = term;
    this.cwd = HOME;
    this.env = {
      HOME: HOME, USER: USER, LOGNAME: USER, HOSTNAME: HOST, PWD: HOME,
      SHELL: "/bin/bash", TERM: "linux", LANG: "C.UTF-8",
      PATH: "/usr/local/bin:/usr/bin:/bin:.",
      PS1: "\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ ",
    };
    this.vars = {};
    this.aliases = { ll: "ls -alF", la: "ls -A", l: "ls -CF", ls: "ls --color=auto", grep: "grep --color=auto" };
    this.functions = {};
    // bash exposes its own version in the environment
    this.env.BASH_VERSION = LW.BASH.versionString;
    this.env.BASH_VERSINFO = [
      LW.BASH.version.split(".")[0], LW.BASH.version.split(".")[1],
      LW.BASH.patchLevel, LW.BASH.buildVersion, 1,
      LW.BASH.releaseStatus, LW.BASH.machtype,
    ].join(" ");
    this.env.MACHTYPE = LW.BASH.machtype;
    this.env.HOSTTYPE = LW.BASH.machtype.split("-")[0];
    this.env.OSTYPE = "linux-gnu";
    this.status = 0;
    this.history = [];
    this.installDefaultFunctions();
    this.buf = "";
    this.cursor = 0;
    this.histIdx = -1;
    this.inRow = 0; this.inStart = 0; this.lastLen = 0;
    this.prompt = "";
    this._curErr = "";
    this.lastOut = "";
    this.running = false;
    this.isRoot = false;
  }

  Shell.prototype.path = function (p) {
    p = String(p);
    if (p === "~") p = HOME;
    else if (p.slice(0, 2) === "~/") p = HOME + p.slice(1);
    return V.norm(p, this.cwd);
  };
  Shell.prototype.getVar = function (name) {
    if (name === "?") return String(this.status);
    if (name === "$") return "901";
    if (name === "#") return String((this.env.__args || []).length);
    if (name === "@" || name === "*") return (this.env.__args || []).join(" ");
    if (/^[1-9]$/.test(name)) return (this.env.__args || [])[parseInt(name, 10) - 1] || "";
    if (name === "0") return "bash";
    if (name === "-") return "himBH";
    if (this.vars[name] !== undefined) return this.vars[name];
    return this.env[name] !== undefined ? this.env[name] : "";
  };
  Shell.prototype.varValue = function (name) { return this.getVar(name); };
  Shell.prototype._error = function (msg) { this._curErr += msg + "\n"; };

  Shell.prototype.substitute = function (src) {
    this.runLine(src, true);
    return this.lastOut.replace(/\n+$/, "");
  };

  Shell.prototype.runLine = function (line, silent) {
    this.lastOut = "";
    // A bare `cat` (flags only, no files, no redirections) runs as a terminal
    // reader: it consumes the keystrokes typed next and copies them live.
    var cap = catTerminalArgs(line);
    if (cap) {
      var g0 = getopt("cat", cap, CAT_OPTS);
      if (!g0.err && !g0.help && !g0.version) {
        this._capture = { buf: "", printed: 0, pending: "", o: g0.o };
        this.status = 0;
        return 0;
      }
    }
    var toks = new Lexer(line, this).run();
    this.lastOut = "";
    if (!toks.length) { this.status = 0; return 0; }
    var ast = new Parser(toks, this).parse();
    var prevErr = this._curErr;
    this._curErr = "";
    var res;
    try { res = this.exec(ast, ""); }
    catch (e) {
      this._curErr = prevErr;
      throw e;
    }
    // execSimple hands its stderr back in the result, so take it from there;
    // _curErr alone would be empty after the nested call reset it.
    var err = (res && res.err) || this._curErr;
    this._curErr = prevErr;
    this.lastOut = (res && res.out) || "";
    if (!silent && err) this.term.write(err);
    return this.status;
  };

  Shell.prototype.exec = function (node, stdin) {
    switch (node.kind) {
      case "seq": {
        var out = "", err = "";
        for (var i = 0; i < node.items.length; i++) {
          var r = this.exec(node.items[i], stdin);
          out += r.out || ""; err += r.err || "";
        }
        return { out: out, err: err };
      }
      case "andor": {
        var l = this.exec(node.left, stdin);
        var run = node.op === "&&" ? this.status === 0 : this.status !== 0;
        if (!run) return l;
        var r2 = this.exec(node.right, stdin);
        return { out: (l.out || "") + (r2.out || ""), err: (l.err || "") + (r2.err || "") };
      }
      case "pipe": {
        var data = stdin, errAll = "";
        for (var k = 0; k < node.cmds.length; k++) {
          var rr = this.exec(node.cmds[k], data);
          data = rr.out || "";
          errAll += rr.err || "";
        }
        return { out: data, err: errAll };
      }
      case "if": {
        var c = this.exec(node.cond);
        var body = this.status === 0 ? node.body : node.els;
        if (!body) return { out: c.out || "", err: c.err || "" };
        var b = this.exec(body);
        return { out: (c.out || "") + (b.out || ""), err: b.err || "" };
      }
      case "while": {
        var o2 = "", e2 = "", guard = 0;
        for (;;) {
          var cc = this.exec(node.cond);
          if (this.status !== 0 || guard++ > 1000) break;
          var bb = this.exec(node.body);
          o2 += bb.out || ""; e2 += bb.err || "";
        }
        return { out: o2, err: e2 };
      }
      case "for": {
        var vals = [];
        for (var wi = 0; wi < node.words.length; wi++) {
          var t = node.words[wi];
          var w = this.expand(t.segs);
          if (!t.quoted && /[*?\[]/.test(w)) {
            var g = V.glob(w, this.cwd);
            if (g.length) { vals = vals.concat(g); continue; }
          }
          vals.push(w);
        }
        var of = "", ef = "";
        for (var vi = 0; vi < vals.length; vi++) {
          this.vars[node.name] = vals[vi];
          var fr = this.exec(node.body);
          of += fr.out || ""; ef += fr.err || "";
        }
        delete this.vars[node.name];
        return { out: of, err: ef };
      }
      case "funcdef":
        this.functions[node.name] = { ast: node.body };
        return { out: "", err: "" };
      case "simple":
        return this.execSimple(node, stdin);
      default:
        return { out: "", err: "" };
    }
  };

  // Resolve a word's segments against the shell state, now (at run time).
  Shell.prototype.expand = function (segs) {
    var out = "";
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.lit !== undefined) out += s.lit;
      else if (s.var !== undefined) out += this.getVar(s.var);
      else if (s.cmd !== undefined) out += this.substitute(s.cmd);
      else if (s.arith !== undefined) out += String(this.arith(s.arith));
    }
    return out;
  };

  // Integer arithmetic for $(( ... )): variables are substituted, then the
  // expression is whitelisted so nothing but numbers/operators can run.
  Shell.prototype.arith = function (expr) {
    var self = this;
    var sub = String(expr).replace(/[A-Za-z_][A-Za-z0-9_]*/g, function (n) {
      var v = parseInt(self.getVar(n), 10);
      return isNaN(v) ? "0" : String(v);
    });
    if (!/^[\s0-9+\-*/%()]+$/.test(sub)) return 0;
    try { return Function('"use strict";return(' + sub + ')')() | 0; }
    catch (e) { return 0; }
  };

  Shell.prototype.execSimple = function (node, stdin) {
    var argv = [], i;
    for (i = 0; i < node.words.length; i++) {
      var t = node.words[i];
      var w = this.expand(t.segs);
      if (!t.quoted && /[*?\[]/.test(w)) {
        var g = V.glob(w, this.cwd);
        if (g.length) { argv = argv.concat(g); continue; }
      }
      argv.push(w);
    }
    if (!argv.length && !node.redirs.length) return { out: "", err: "" };

    var assigns = [];
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
      var eq = argv[0].indexOf("=");
      assigns.push([argv[0].slice(0, eq), argv[0].slice(eq + 1)]);
      argv.shift();
    }

    var rIn = null, rOut = null, rErrOut = null, rAppend = false, mergeErr = false;
    for (i = 0; i < node.redirs.length; i++) {
      var rd = node.redirs[i];
      // NB: a dup target is an fd number, not a path -- "1" must not become
      // ./1 before we compare it.
      var target = this.expand(rd.target.segs);
      if (rd.op === "<") rIn = this.path(target);
      else if (rd.dup) { if (target === "1" || target === "&1") mergeErr = true; }
      else if (rd.fd === 2) { rErrOut = this.path(target); rAppend = rd.op === ">>"; }
      else { rOut = this.path(target); rAppend = rd.op === ">>"; }
    }

    if (!argv.length) {
      for (i = 0; i < assigns.length; i++) { this.vars[assigns[i][0]] = assigns[i][1]; this.env[assigns[i][0]] = assigns[i][1]; }
      if (rOut) V.writeFile(rOut, "", rAppend);
      return { out: "", err: "" };
    }

    var name = argv[0];
    if (this.aliases[name] && name.indexOf("/") < 0) {
      argv = this.aliases[name].split(" ").concat(argv.slice(1));
      name = argv[0];
    }

    var input = stdin;
    if (rIn) {
      var d = V.readFile(rIn);
      if (d === null) {
        this._error("bash: " + rIn + ": No such file or directory");
        this.status = 1;
        return { out: "", err: this._takeErr() };
      }
      input = d;
    }

    var prevErr = this._curErr;
    this._curErr = "";
    var res;
    try {
      if (assigns.length) {
        var oldEnv = this.env;
        var merged = Object.assign({}, this.env);
        for (i = 0; i < assigns.length; i++) merged[assigns[i][0]] = assigns[i][1];
        this.env = merged;
        try { res = this.dispatch(name, argv.slice(1), input); }
        finally { this.env = oldEnv; }
      } else {
        res = this.dispatch(name, argv.slice(1), input);
      }
    } catch (e) {
      this._curErr = prevErr;
      if (e && (e.__exit !== undefined || e.__return !== undefined)) throw e;
      this._error("bash: " + name + ": " + (e && e.message));
      var em = this._curErr;
      this._curErr = prevErr;
      this.status = 1;
      return { out: "", err: em };
    }
    var errText = this._curErr;
    this._curErr = prevErr;
    res = res || { out: "", code: 0 };
    if (res.async && res.start) {          // takes over the terminal
      this._asyncTask = res.start;
      this.status = 0;
      // `cmd 2>&1` still merges for an async command: whatever it wrote to
      // stderr before taking over is emitted through the task, which owns
      // the only stdout there is.
      if (mergeErr && errText) {
        var start = res.start;
        this._asyncTask = function (io) { io.write(errText); return start(io); };
      }
      return { out: "", err: mergeErr ? "" : errText };
    }
    this.status = res.code === undefined ? 0 : res.code;
    var outText = res.out || "";
    if (mergeErr) { outText += errText; errText = ""; }   // 2>&1
    if (rOut) { V.writeFile(rOut, outText, rAppend); outText = ""; }
    // `cmd 2> file` sends the diagnostics to the file, not to the terminal
    if (rErrOut && errText) { V.writeFile(rErrOut, errText, rAppend); errText = ""; }
    return { out: outText, err: errText };
  };
  Shell.prototype._takeErr = function () { var e = this._curErr; this._curErr = ""; return e; };

  // ---------- builtins ----------

  var BUILTIN = {
    cd: "bi_cd", pwd: "bi_pwd", export: "bi_export", unset: "bi_unset",
    set: "bi_set", alias: "bi_alias", unalias: "bi_unalias",
    source: "bi_source", ".": "bi_source", exit: "bi_exit", return: "bi_return",
    read: "bi_read", history: "bi_history", help: "bi_help", type: "bi_type",
    command: "bi_command", eval: "bi_eval", umask: "bi_umask", jobs: "bi_noop",
    wait: "bi_noop", test: "bi_test", "[": "bi_test", kill: "bi_noop",
    shift: "bi_noop", let: "bi_let", exec: "bi_noop", trap: "bi_noop",
    hash: "bi_noop", bg: "bi_noop", fg: "bi_noop", suspend: "bi_noop",
    times: "bi_noop", local: "bi_noop", declare: "bi_noop", typeset: "bi_noop",
    readonly: "bi_noop", shopt: "bi_noop", ulimit: "bi_noop", clear: "bi_clear",
    reset: "bi_reset", logout: "bi_exit", sync: "bi_sync", bind: "bi_bind",
    sudo: "bi_sudo",
  };

  Shell.prototype.bi_cd = function (args) {
    var target = args[0] || this.env.HOME;
    if (target === "-") target = this.env.OLDPWD || this.env.HOME;
    var p = this.path(target);
    if (!V.isDir(p)) { this._error("bash: cd: " + target + ": No such file or directory"); return { out: "", code: 1 }; }
    this.env.OLDPWD = this.cwd;
    this.cwd = p;
    this.env.PWD = p;
    return { out: "", code: 0 };
  };
  Shell.prototype.bi_pwd = function () { return { out: this.cwd + "\n", code: 0 }; };
  Shell.prototype.bi_export = function (args) {
    var self = this;
    args.forEach(function (a) {
      var eq = a.indexOf("=");
      if (eq < 0) { if (self.vars[a] !== undefined) { self.env[a] = self.vars[a]; delete self.vars[a]; } }
      else self.env[a.slice(0, eq)] = a.slice(eq + 1);
    });
    return { out: "", code: 0 };
  };
  Shell.prototype.bi_unset = function (args) {
    var self = this;
    args.forEach(function (a) { delete self.env[a]; delete self.vars[a]; });
    return { out: "", code: 0 };
  };
  Shell.prototype.bi_set = function (args) {
    if (args.length && (args[0] === "-o" || args[0] === "+o")) {
      var plus = args[0] === "+o";
      var out = "";
      (LW.SET_O || []).forEach(function (opt) {
        if (plus) out += "set " + (opt[1] ? "-o " : "+o ") + opt[0] + "\n";
        else out += opt[0] + new Array(Math.max(1, 16 - opt[0].length)).join(" ") +
          "\t" + (opt[1] ? "on" : "off") + "\n";
      });
      return { out: out, code: 0 };
    }
    if (!args.length) {
      var res = "";
      var self = this;
      Object.keys(this.env).sort().forEach(function (k) { res += k + "='" + self.env[k] + "'\n"; });
      return { out: res, code: 0 };
    }
    return { out: "", code: 0 };
  };
  Shell.prototype.bi_alias = function (args) {
    var self = this, out = "";
    if (!args.length) {
      Object.keys(this.aliases).forEach(function (k) { out += "alias " + k + "='" + self.aliases[k] + "'\n"; });
      return { out: out, code: 0 };
    }
    args.forEach(function (a) {
      var eq = a.indexOf("=");
      if (eq < 0) out += (self.aliases[a] ? "alias " + a + "='" + self.aliases[a] + "'" : "bash: alias: " + a + ": not found") + "\n";
      else self.aliases[a.slice(0, eq)] = a.slice(eq + 1).replace(/^['"]|['"]$/g, "");
    });
    return { out: out, code: 0 };
  };
  Shell.prototype.bi_unalias = function (args) {
    var self = this;
    if (args[0] === "-a") { this.aliases = {}; return { out: "", code: 0 }; }
    args.forEach(function (a) { delete self.aliases[a]; });
    return { out: "", code: 0 };
  };
  Shell.prototype.bi_source = function (args) {
    if (!args.length) { this._error("bash: source: filename argument required"); return { out: "", code: 2 }; }
    var d = V.readFile(this.path(args[0]));
    if (d === null) { this._error("bash: source: " + args[0] + ": No such file or directory"); return { out: "", code: 1 }; }
    var out = "", self = this;
    d.split("\n").forEach(function (l) {
      if (l.trim() && l.trim().charAt(0) !== "#") {
        self.runLine(l, true);
        out += self.lastOut;
      }
    });
    return { out: out, code: 0 };
  };
  Shell.prototype.bi_exit = function (args) {
    var code = args.length ? parseInt(args[0], 10) : this.status;
    throw { __exit: true, code: isNaN(code) ? 0 : code };
  };
  Shell.prototype.bi_read = function () { return { out: "", code: 1 }; };
  Shell.prototype.bi_return = function (args) {
    var code = args.length ? parseInt(args[0], 10) : this.status;
    throw { __return: true, code: isNaN(code) ? 0 : code };
  };

  // Debian ships this handler in /etc/bash.bashrc (it execs
  // /usr/lib/command-not-found); here it is provided natively so the hook is real.
  Shell.prototype.installDefaultFunctions = function () {
    this.functions.command_not_found_handle = {
      native: function (args) {
        var cmd = args[0] || "";
        return {
          out: "Command '" + cmd + "' not found, but can be installed with:\n" +
               "sudo apt install " + cmd + "\n",
          code: 127
        };
      }
    };
  };

  Shell.prototype.callFunction = function (name, args, input) {
    var fn = this.functions[name];
    var saved = this.env.__args;
    this.env.__args = args;
    try {
      if (fn.native) return fn.native(args, input, this);
      var r = this.exec(fn.ast, input);
      return { out: r.out, code: this.status };
    } catch (e) {
      if (e && e.__return) return { out: this.lastOut, code: e.code };
      throw e;
    } finally {
      this.env.__args = saved;
    }
  };

  // bash's failure modes for a command it cannot run.
  // Resolution order is bash's: functions, builtins, then PATH commands --
  // plus the dynamic namespace that `apt` populates.
  Shell.prototype.dispatch = function (name, argv, input) {
    if (this.functions[name]) return this.callFunction(name, argv, input);
    if (Object.prototype.hasOwnProperty.call(BUILTIN, name)) return this[BUILTIN[name]](argv, input);
    if (BUI[name]) return BUI[name].run(argv, input, this);
    if (CMDS[name]) return CMDS[name].run(argv, input, this);
    if (LW.APT && LW.APT.cmds[name]) {
      var r = LW.APT.cmds[name](argv, input, this);
      return r || { out: "", code: 0 };
    }
    return this.commandNotFound(name, argv, input);
  };

  Shell.prototype.commandNotFound = function (name, argv, input) {
    if (name.indexOf("/") >= 0) {
      var n = V.getNode(this.path(name));
      if (!n) { this._error("bash: " + name + ": No such file or directory"); this.status = 127; }
      else if (n.t === "d") { this._error("bash: " + name + ": Is a directory"); this.status = 126; }
      else { this._error("bash: " + name + ": Permission denied"); this.status = 126; }
      return { out: "", code: this.status };
    }
    if (this.functions.command_not_found_handle) {
      var r = this.callFunction("command_not_found_handle", [name].concat(argv), input);
      this.status = r.code === undefined ? 127 : r.code;
      return { out: r.out || "", code: this.status };
    }
    this._error("bash: " + name + ": command not found");
    this.status = 127;
    return { out: "", code: 127 };
  };
  Shell.prototype.bi_history = function () {
    var res = "", self = this;
    this.history.forEach(function (h, i) { res += String(i + 1).padStart(5) + "  " + h + "\n"; });
    return { out: res, code: 0 };
  };
  function helpIndent(s) { return "    " + s; }   // bash indents blank lines too
  function helpPad(s, w) {
    return s.length >= w ? s.slice(0, w - 1) + ">" : s + new Array(w - s.length + 1).join(" ");
  }

  // The header of the bare `help` listing, copied from bash.
  var HELP_HEADER =
    "GNU bash, version " + LW.BASH.versionString + " (" + LW.BASH.machtype + ")\n" +
    "These shell commands are defined internally.  Type `help' to see this list.\n" +
    "Type `help name' to find out more about the function `name'.\n" +
    "Use `info bash' to find out more about the shell in general.\n" +
    "Use `man -k' or `info' to find out more about commands not in this list.\n\n" +
    "A star (*) next to a name means that the command is disabled.\n\n";

  Shell.prototype.bi_help = function (args) {
    var o = opt(args, { bool: "dms", long: ["description", "man", "syntax"] });
    var H = LW.HELP, ORDER = LW.HELP_ORDER;
    var wantDesc = !!(o.d || o.description);
    var wantMan = !!(o.m || o.man);
    var wantSyn = !!(o.s || o.syntax);
    var topics = o._;
    var out = "", code = 0, i;

    if (!topics.length) {
      out = HELP_HEADER;
      // bash splits the screen in half and fills it COLUMN-major: the first
      // half of the entries runs down the left column, the rest down the right.
      var colw = Math.max(1, Math.floor((this.term && this.term.cols ? this.term.cols : 80) / 2));
      var cells = ORDER.map(function (n) { return " " + H[n].usage; });
      var rows = Math.ceil(cells.length / 2);
      for (i = 0; i < rows; i++) {
        out += (helpPad(cells[i], colw) + helpPad(cells[i + rows] || "", colw)).replace(/\s+$/, "") + "\n";
      }
      return { out: out, code: 0 };
    }

    var self = this;
    var allNames = Object.keys(H).sort();
    topics.forEach(function (pat) {
      var re = V.globToRe(pat);
      var matches = allNames.filter(function (n) { return re.test(n); });
      if (!matches.length) {
        // verbatim from bash 5.3 builtins/help.def: the pattern appears three times
        self._error("bash: help: no help topics match `" + pat + "'.  Try `help help' or " +
          "`man -k " + pat + "' or `info " + pat + "'.");
        code = 1;
        return;
      }
      matches.forEach(function (n) {
        var e = H[n];
        if (wantSyn) { out += n + ": " + e.usage + "\n"; return; }
        if (wantDesc) { out += n + " - " + e.desc + "\n"; return; }
        if (wantMan) {
          out += "NAME\n" + helpIndent(n + " - " + e.desc) + "\n\n" +
            "SYNOPSIS\n" + helpIndent(e.usage) + "\n\n";
          if (e.body.length) out += "DESCRIPTION\n" + e.body.map(helpIndent).join("\n") + "\n";
          out += "\n";
          return;
        }
        out += n + ": " + e.usage + "\n";
        if (e.body.length) out += e.body.map(helpIndent).join("\n") + "\n";
      });
    });
    return { out: out, code: code };
  };

  Shell.prototype.bi_type = function (args) {
    var o = opt(args, { bool: "aftpP", long: ["all", "type", "path", "force"] });
    var all = !!(o.a || o.all), wantType = !!o.t, wantPath = !!(o.p || o.P);
    args = o._;
    var self = this, res = "", code = 0;
    if (wantType || wantPath) {
      args.forEach(function (a) {
        var kind = self.functions[a] ? (wantPath ? "" : "function")
          : (Object.prototype.hasOwnProperty.call(BUILTIN, a) || BUI[a]) ? (wantPath ? "" : "builtin")
            : self.aliases[a] ? (wantPath ? "" : "alias")
              : CMDS[a] || (LW.APT && LW.APT.cmds[a]) ? "/usr/bin/" + a : null;
        if (kind === null || kind === "") { code = 1; return; }
        res += kind + "\n";
      });
      return { out: res, code: code };
    }
    args.forEach(function (a) {
      var found = false;
      if (self.functions[a]) { res += a + " is a function\n"; found = true; }
      else if (Object.prototype.hasOwnProperty.call(BUILTIN, a) || BUI[a]) {
        res += a + " is a shell builtin\n"; found = true;
      } else if (self.aliases[a]) { res += a + " is aliased to `" + self.aliases[a] + "'\n"; found = true; }
      if ((CMDS[a] || (LW.APT && LW.APT.cmds[a])) && (all || !found)) {
        res += a + " is /usr/bin/" + a + "\n"; found = true;
      }
      if (!found) { res += "bash: type: " + a + ": not found\n"; code = 1; }
    });
    return { out: res, code: code };
  };
  Shell.prototype.bi_command = function (args, stdin) {
    if (!args.length) return { out: "", code: 0 };
    var nm = args[0];
    if (this.functions[nm]) return this.callFunction(nm, args.slice(1), stdin);
    if (Object.prototype.hasOwnProperty.call(BUILTIN, nm)) return this[BUILTIN[nm]](args.slice(1), stdin);
    if (BUI[nm]) return BUI[nm].run(args.slice(1), stdin, this);
    if (CMDS[nm]) return CMDS[nm].run(args.slice(1), stdin, this);
    return this.commandNotFound(nm, args.slice(1), stdin);
  };
  Shell.prototype.bi_eval = function (args) {
    this.runLine(args.join(" "), true);
    return { out: this.lastOut, code: this.status };
  };
  Shell.prototype.bi_umask = function () { return { out: "0022\n", code: 0 }; };
  Shell.prototype.bi_noop = function () { return { out: "", code: 0 }; };
  Shell.prototype.bi_clear = function () {
    this.term.clear();
    return { out: "", code: 0, cleared: true };
  };
  Shell.prototype.bi_sudo = function (args, stdin) {
    var i = 0;
    while (i < args.length && args[i].charAt(0) === "-") {
      if (args[i] === "-u" || args[i] === "-g" || args[i] === "-p") i++;   // consumes its value
      i++;
    }
    if (i >= args.length) { this._error("usage: sudo command [arguments]"); return { out: "", code: 1 }; }
    return this.dispatch(args[i], args.slice(i + 1), stdin);
  };

  Shell.prototype.bi_reset = function () {
    if (this.term._resetTerm) this.term._resetTerm(); else this.term.clear();
    return { out: "", code: 0, cleared: true };
  };
  Shell.prototype.bi_sync = function () {
    V.flush(function () { /* buffered writes are durable now */ });
    return { out: "", code: 0 };
  };
  Shell.prototype.bi_let = function (args) {
    var v = 0;
    try { v = Function('"use strict";return (' + args.join(" ") + ")")(); }
    catch (e) { return { out: "", code: 1 }; }
    return { out: String(v) + "\n", code: v ? 0 : 1 };
  };
  Shell.prototype.bi_bind = function (args) {
    if (args[0] === "-P" || args[0] === "-p") {
      // the real readline table, captured from bash's own `bind -P`
      return { out: "\n" + (LW.BIND_P || []).join("\n") + "\n", code: 0 };
    }
    var res = "Ctrl+<key>   function\n";
    var keys = Object.keys(CTRL).sort();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var shown = k === "[" ? "[" : k === "\\" ? "\\" : k === "]" ? "]" : k;
      res += "Ctrl+" + shown + "       " + CTRL[k] + (CTRL_HELP[CTRL[k]] ? "   (" + CTRL_HELP[CTRL[k]] + ")" : "") + "\n";
    }
    res += "\n" + keys.length + " bindings (complete emacs-mode Ctrl+ table)\n";
    return { out: res, code: 0 };
  };

  Shell.prototype.bi_test = function (args) {
    if (args[args.length - 1] === "]") args = args.slice(0, -1);
    return { out: "", code: evalTest(args, this) ? 0 : 1 };
  };

  function evalTest(args, sh) {
    if (!args.length) return false;
    if (args[0] === "!") return !evalTest(args.slice(1), sh);
    if (args.length >= 3) {
      var a = args[0], op = args[1], b = args[2];
      switch (op) {
        case "=": case "==": return a === b;
        case "!=": return a !== b;
        case "-eq": return Number(a) === Number(b);
        case "-ne": return Number(a) !== Number(b);
        case "-gt": return Number(a) > Number(b);
        case "-lt": return Number(a) < Number(b);
        case "-ge": return Number(a) >= Number(b);
        case "-le": return Number(a) <= Number(b);
      }
    }
    if (args.length === 2) {
      var n = V.getNode(sh.path(args[1]));
      switch (args[0]) {
        case "-e": return !!n;
        case "-f": return !!n && n.t === "f";
        case "-d": return !!n && n.t === "d";
        case "-r": case "-w": case "-x": return !!n;
        case "-s": return !!n && n.t === "f" && (n.d || "").length > 0;
        case "-n": return args[1].length > 0;
        case "-z": return args[1].length === 0;
      }
    }
    return args[0] !== "" && args[0] !== "0";
  }

  // ---------- prompt / REPL ----------

  Shell.prototype.promptText = function () { return decodePrompt(this.env.PS1, this); };

  Shell.prototype.printMotd = function () {
    var motd = V.readFile("/etc/motd");
    this.term.write("\n");
    if (motd) this.term.write(motd);
    this.term.write("\n");
  };

  Shell.prototype.newPrompt = function () {
    var t = this.term;
    if (t.col !== 0) t.write("\n");
    this.buf = "";
    this.cursor = 0;
    this.histIdx = -1;
    this.undo = [];
    this.kill = this.kill || "";
    this.mark = null;
    this.search = null;
    this.quoted = false;
    this.prompt = this.promptText();
    t.write(this.prompt);
    this.inRow = t.row;
    this.inStart = t.col;
    this.lastLen = 0;
    t.render();
  };

  Shell.prototype.redraw = function () {
    var t = this.term;
    if (this.inStart + Math.max(this.lastLen, this.buf.length) >= t.cols) { t.render(); return; }
    t.setCursor(this.inStart, this.inRow);
    var n = Math.max(this.lastLen, this.buf.length) + 1;
    for (var i = 0; i < n; i++) t.putChar(0x20);
    t.setCursor(this.inStart, this.inRow);
    if (this.buf) t.write(this.buf);
    this.lastLen = this.buf.length;
    t.setCursor(this.inStart + this.cursor, this.inRow);
    t.render();
  };

  // Interactive tty capture: a bare `cat` copies each typed line back,
  // live, through cat's own filter, the way a real cat does on a terminal:
  // the line appears once as the tty echoes it, and cat's copy follows on
  // the next line.  Ctrl-D ends the copying, Ctrl-C kills it.
  Shell.prototype._captureKey = function (ev) {
    var t = this.term, cap = this._capture, k = ev.key;
    if (ev.ctrlKey && !ev.altKey) {
      var c = LW.ctrlChar(ev);
      if (c === "c") {
        t.write("^C\n");
        this._capture = null; this.status = 130; this.newPrompt();
        return;
      }
      if (c === "d") {
        // canonical EOF: the characters typed so far are delivered first.
        if (cap.pending.length > 0) {
          cap.buf += cap.pending;
          var s0 = catFormat(cap.o, cap.buf);
          var d0 = s0.slice(cap.printed);
          if (d0) t.write(d0);
          cap.printed = s0.length;
          cap.pending = "";
        }
        t.write("\n");
        this._capture = null; this.status = 0; this.newPrompt();
        return;
      }
      return;                                        // other chords ignored
    }
    if (ev.altKey || ev.metaKey) return;
    switch (k) {
      case "Enter": {
        var line = cap.pending; cap.pending = "";
        cap.buf += line + "\n";
        t.write("\n");
        var s1 = catFormat(cap.o, cap.buf);
        var d1 = s1.slice(cap.printed);
        if (d1) t.write(d1);
        cap.printed = s1.length;
        t.render();
        return;
      }
      case "Backspace":
        if (cap.pending.length > 0) {
          cap.pending = cap.pending.slice(0, -1);
          t.write("\b \b");
          t.render();
        }
        return;
      case "Escape":
        t.write("^C\n");
        this._capture = null; this.status = 130; this.newPrompt();
        return;
    }
    if (k && k.length === 1) {
      cap.pending += k;
      t.write(k);
      t.render();
    }
  };

  Shell.prototype.submit = function () {
    var t = this.term, line = this.buf;
    t.write("\n");
    this.buf = "";
    this.lastLen = 0;
    if (line.trim()) {
      this.history.push(line);
      if (this.history.length > 500) this.history.shift();
      try {
        this.runLine(line, false);
      } catch (e) {
        if (e && e.__exit) { this.term.write("exit\n"); this.running = false; t.render(); return; }
        this.term.write("bash: " + (e && e.message) + "\n");
        this.status = 1;
      }
      if (this.lastOut) t.write(this.lastOut);
      if (this._asyncTask) { this.runAsync(t); return; }
      t.render();
    }
    // a child shell or an interactive terminal cat owns the screen now
    if (this._child || this._capture) return;
    if (this.running) this.newPrompt();
  };

  // An async command owns the screen (htop, sl, apt's progress) until it calls
  // io.done(); Ctrl+C aborts it.
  Shell.prototype.runAsync = function (t) {
    var self = this;
    var task = this._asyncTask;
    this._asyncTask = null;
    this.busy = true;
    var io = {
      term: t,
      aborted: false,
      write: function (s) { t.write(s); t.render(); },
      done: function (code) {
        self.status = code === undefined ? 0 : code;
        self.busy = false;
        self._asyncIO = null;
        if (self.running) self.newPrompt();
      },
    };
    this._asyncIO = io;
    task(io);
  };

  Shell.prototype.abortAsync = function () {
    var io = this._asyncIO;
    if (io) { io.aborted = true; if (io.timeout) clearTimeout(io.timeout); }
    this._asyncIO = null;
    this.busy = false;
    this.term.write("^C\n");
    this.newPrompt();
  };

  Shell.prototype.complete = function () {
    var text = this.buf.slice(0, this.cursor);
    var m = /(\S*)$/.exec(text), frag = m ? m[1] : "";
    var isFirst = text.slice(0, text.length - frag.length).trim() === "";
    var cands = [], i;
    if (isFirst) {
      var seen = {};
      Object.keys(CMDS).concat(Object.keys(BUILTIN), Object.keys(this.aliases)).forEach(function (c) {
        if (c.indexOf(frag) === 0 && !seen[c]) { seen[c] = 1; cands.push(c); }
      });
      cands.sort();
    } else {
      var dir = ".", dirFrag = frag;
      var slash = frag.lastIndexOf("/");
      if (slash >= 0) { dir = frag.slice(0, slash) || "/"; dirFrag = frag.slice(slash + 1); }
      var names = V.lsDir(this.path(dir));
      var self = this;
      if (names) names.forEach(function (n) {
        if (n.indexOf(dirFrag) === 0) {
          var full = (slash >= 0 ? frag.slice(0, slash + 1) : "") + n;
          if (V.isDir(self.path(dir + "/" + n))) full += "/";
          cands.push(full);
        }
      });
      cands.sort();
    }
    if (!cands.length) return;
    if (cands.length === 1) {
      var insert = cands[0].slice(frag.length);
      this.buf = this.buf.slice(0, this.cursor) + insert + " " + this.buf.slice(this.cursor);
      this.cursor += insert.length + 1;
      this.redraw();
      return;
    }
    var t = this.term, width = 0;
    cands.forEach(function (c) { width = Math.max(width, c.length); });
    width += 2;
    t.write("\n");
    var perRow = Math.max(1, Math.floor(t.cols / width));
    for (i = 0; i < cands.length; i += perRow) {
      t.write(cands.slice(i, i + perRow).join("  ") + "\n");
    }
    t.write(this.prompt);
    this.inRow = t.row;
    this.inStart = t.col;
    this.lastLen = 0;
    t.write(this.buf);
    t.setCursor(this.inStart + this.cursor, this.inRow);
    t.render();
  };

  // Complete readline(3) emacs-mode Ctrl+ mapping, keyed by LW.ctrlChar().
  // Every Ctrl+<char> is listed; chords readline leaves unbound map to "noop"
  // so nothing ever falls through to a literal insert.
  var CTRL = {
    "@": "set-mark",
    "a": "beginning-of-line",
    "b": "backward-char",
    "c": "abort",
    "d": "eof",
    "e": "end-of-line",
    "f": "forward-char",
    "g": "abort",
    "h": "backward-delete-char",
    "i": "complete",
    "j": "accept-line",
    "k": "kill-line",
    "l": "clear-screen",
    "m": "accept-line",
    "n": "next-history",
    "o": "operate-and-get-next",
    "p": "previous-history",
    "q": "quoted-insert",
    "r": "reverse-search-history",
    "s": "forward-search-history",
    "t": "transpose-chars",
    "u": "unix-line-discard",
    "v": "quoted-insert",
    "w": "unix-word-rubout",
    "x": "noop",
    "y": "yank",
    "z": "suspend",
    "[": "abort",
    "\\": "abort",
    "]": "noop",
    "^": "noop",
    "_": "undo",
    "?": "backward-delete-char",
  };
  LW.SHELL_CTRL = CTRL;

  var CTRL_HELP = {
    "set-mark": "set the mark",
    "beginning-of-line": "move to the start of the line",
    "backward-char": "move back one character",
    "abort": "abort the current line",
    "eof": "delete char, or exit the shell on an empty line",
    "end-of-line": "move to the end of the line",
    "forward-char": "move forward one character",
    "backward-delete-char": "delete the character behind the cursor",
    "complete": "complete the word (same as Tab)",
    "accept-line": "accept the line",
    "kill-line": "kill from the cursor to the end of the line",
    "clear-screen": "clear the screen and redraw",
    "next-history": "next line from history",
    "operate-and-get-next": "accept the line and fetch the next history entry",
    "previous-history": "previous line from history",
    "quoted-insert": "insert the next character literally",
    "reverse-search-history": "search backwards through history",
    "forward-search-history": "search forwards through history",
    "transpose-chars": "swap the two characters around the cursor",
    "unix-line-discard": "kill from the cursor back to the start of the line",
    "unix-word-rubout": "kill the word behind the cursor",
    "noop": "(unbound)",
    "yank": "paste the last killed text",
    "suspend": "suspend the shell (no job control here)",
    "undo": "undo the last edit",
  };

  Shell.prototype._pushUndo = function () {
    this.undo.push({ buf: this.buf, cursor: this.cursor });
    if (this.undo.length > 100) this.undo.shift();
  };

  Shell.prototype.insertText = function (s) {
    this.buf = this.buf.slice(0, this.cursor) + s + this.buf.slice(this.cursor);
    this.cursor += s.length;
    this.redraw();
  };

  Shell.prototype._drawSearch = function () {
    var t = this.term;
    var label = this.search.dir === "reverse" ? "(reverse-i-search)" : "(i-search)";
    this.prompt = label + "`" + this.search.query + "': ";
    t.write("\n");
    this.inRow = t.row;
    this.inStart = 0;
    this.lastLen = 0;
    t.write(this.prompt + this.buf);
    this.lastLen = this.buf.length;
    t.setCursor(this.prompt.length + this.cursor, this.inRow);
    t.render();
  };

  Shell.prototype._search = function (dir) {
    if (!this.history.length) return;
    if (!this.search || this.search.dir !== dir) {
      this.search = { dir: dir, query: "", idx: this.history.length, saved: this.buf };
    }
    var found = null, i;
    if (dir === "reverse") {
      for (i = this.search.idx - 1; i >= 0; i--) {
        if (this.history[i].indexOf(this.search.query) >= 0) { found = i; break; }
      }
    } else {
      for (i = this.search.idx + 1; i < this.history.length; i++) {
        if (this.history[i].indexOf(this.search.query) >= 0) { found = i; break; }
      }
    }
    if (found !== null) {
      this.search.idx = found;
      this.buf = this.history[found];
      this.cursor = this.buf.length;
    }
    this._drawSearch();
  };

  Shell.prototype._endSearch = function (accept) {
    var found = this.buf;
    var saved = this.search ? this.search.saved : "";
    var row = this.inRow;
    this.search = null;
    this.buf = accept ? found : saved;
    this.cursor = this.buf.length;
    if (accept) { this.submit(); return; }
    var t = this.term;
    t.setCursor(0, row);
    for (var i = 0; i < t.cols; i++) t.putChar(0x20);
    t.setCursor(0, row);
    this.prompt = this.promptText();
    t.write(this.prompt);
    this.inRow = row;
    this.inStart = t.col;
    this.lastLen = 0;
    if (this.buf) t.write(this.buf);
    this.lastLen = this.buf.length;
    t.setCursor(this.inStart + this.cursor, this.inRow);
    t.render();
  };

  Shell.prototype.ctrl = function (name) {
    var t = this.term;
    switch (name) {
      case "beginning-of-line": this.cursor = 0; this.redraw(); return;
      case "end-of-line": this.cursor = this.buf.length; this.redraw(); return;
      case "backward-char": if (this.cursor > 0) this.cursor--; this.redraw(); return;
      case "forward-char": if (this.cursor < this.buf.length) this.cursor++; this.redraw(); return;
      case "backward-delete-char":
        if (this.cursor > 0) {
          this._pushUndo();
          this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
          this.cursor--;
          this.redraw();
        }
        return;
      case "kill-line":
        this._pushUndo();
        this.kill = this.buf.slice(this.cursor);
        this.buf = this.buf.slice(0, this.cursor);
        this.redraw();
        return;
      case "unix-line-discard":
        this._pushUndo();
        this.kill = this.buf.slice(0, this.cursor);
        this.buf = this.buf.slice(this.cursor);
        this.cursor = 0;
        this.redraw();
        return;
      case "unix-word-rubout": {
        this._pushUndo();
        var i = this.cursor;
        while (i > 0 && this.buf[i - 1] === " ") i--;
        while (i > 0 && this.buf[i - 1] !== " ") i--;
        this.kill = this.buf.slice(i, this.cursor);
        this.buf = this.buf.slice(0, i) + this.buf.slice(this.cursor);
        this.cursor = i;
        this.redraw();
        return;
      }
      case "yank":
        if (this.kill) {
          this._pushUndo();
          this.buf = this.buf.slice(0, this.cursor) + this.kill + this.buf.slice(this.cursor);
          this.cursor += this.kill.length;
          this.redraw();
        }
        return;
      case "transpose-chars":
        if (this.buf.length > 1 && this.cursor > 0) {
          this._pushUndo();
          var p = this.cursor < this.buf.length ? this.cursor : this.buf.length - 1;
          var a = this.buf[p - 1], b = this.buf[p];
          this.buf = this.buf.slice(0, p - 1) + b + a + this.buf.slice(p + 1);
          if (this.cursor < this.buf.length) this.cursor++;
          this.redraw();
        }
        return;
      case "undo":
        if (this.undo.length) {
          var s = this.undo.pop();
          this.buf = s.buf;
          this.cursor = s.cursor;
          this.redraw();
        }
        return;
      case "set-mark": this.mark = this.cursor; return;
      case "complete": this.complete(); return;
      case "accept-line": this.submit(); return;
      case "abort":
        t.write("^C\n");
        this.search = null;
        this.buf = "";
        this.cursor = 0;
        this.newPrompt();
        return;
      case "eof":
        if (this.buf === "") { t.write("exit\n"); this.running = false; }
        else {
          this._pushUndo();
          this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
          this.redraw();
        }
        return;
      case "clear-screen":
        t.clear();
        this.newPrompt();
        return;
      case "previous-history":
        if (this.search) { this._search("reverse"); return; }
        if (this.history.length) {
          if (this.histIdx < 0) this.histIdx = this.history.length;
          if (this.histIdx > 0) this.histIdx--;
          this.buf = this.history[this.histIdx];
          this.cursor = this.buf.length;
          this.redraw();
        }
        return;
      case "next-history":
        if (this.search) { this._search("forward"); return; }
        if (this.histIdx >= 0) {
          this.histIdx++;
          if (this.histIdx >= this.history.length) { this.histIdx = -1; this.buf = ""; }
          else this.buf = this.history[this.histIdx];
          this.cursor = this.buf.length;
          this.redraw();
        }
        return;
      case "operate-and-get-next": this.submit(); return;
      case "quoted-insert": this.quoted = true; return;
      case "reverse-search-history": this._search("reverse"); return;
      case "forward-search-history": this._search("forward"); return;
      case "suspend":
        t.write("\nbash: cannot suspend: no job control in this shell\n");
        this.newPrompt();
        return;
      case "noop":
      default:
        return;
    }
  };

  Shell.prototype.onKey = function (ev) {
    var t = this.term, k = ev.key;

    // bare `cat` on a tty: the keystrokes drive the capture buffer.
    if (this._capture) { this._captureKey(ev); return true; }

    // a child bash owns the keys while it runs (exits drop back here)
    if (this._child) {
      var ch = this._child;
      ch.onKey(ev);
      if (!ch.running) {
        var self = this;
        self.status = ch.status;
        self._child = null;
        self.newPrompt();
      }
      return true;
    }

    if (this.busy) {
      var io = this._asyncIO;
      if (ev.ctrlKey && k === "c") { this.abortAsync(); return true; }
      if (io && io.onKey && io.onKey(ev)) return true;
      return true;                       // the task owns the keyboard
    }

    if (ev.ctrlKey && !ev.altKey) {
      var c = LW.ctrlChar(ev);
      if (c && CTRL[c]) this.ctrl(CTRL[c]);
      return true;                      // every Ctrl chord is consumed
    }
    if (ev.altKey || ev.metaKey) return true;

    // while searching, printable keys extend the query
    if (this.search && k && k.length === 1 && !ev.ctrlKey) {
      this.search.query += k;
      this.search.idx = this.search.dir === "reverse" ? this.history.length : -1;
      this._search(this.search.dir);
      return true;
    }

    // Ctrl+V: the next character goes in literally
    if (this.quoted) {
      this.quoted = false;
      if (k && k.length === 1) { this._pushUndo(); this.insertText(k); }
      return true;
    }

    switch (k) {
      case "Enter": this.submit(); return true;
      case "Backspace":
        if (this.cursor > 0) {
          this._pushUndo();
          this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
          this.cursor--;
          this.redraw();
        }
        return true;
      case "Delete":
        if (this.cursor < this.buf.length) {
          this._pushUndo();
          this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
          this.redraw();
        }
        return true;
      case "ArrowLeft": if (this.cursor > 0) this.cursor--; this.redraw(); return true;
      case "ArrowRight": if (this.cursor < this.buf.length) this.cursor++; this.redraw(); return true;
      case "ArrowUp": this.ctrl("previous-history"); return true;
      case "ArrowDown": this.ctrl("next-history"); return true;
      case "Home": this.ctrl("beginning-of-line"); return true;
      case "End": this.ctrl("end-of-line"); return true;
      case "Tab": this.complete(); return true;
      case "Escape":
        if (this.search) this._endSearch(false);
        return true;
    }
    if (k && k.length === 1) {
      this._pushUndo();
      this.insertText(k);
      return true;
    }
    return false;
  };

  // Adopt an /etc/passwd entry: home directory, shell, prompt identity.
  Shell.prototype.applyUser = function (user) {
    var passwd = V.readFile("/etc/passwd") || "";
    var home = HOME, shell = "/bin/bash", uid = 1000;
    passwd.split("\n").forEach(function (l) {
      var f = l.split(":");
      if (f[0] === user) { uid = parseInt(f[2], 10) || 1000; home = f[5] || HOME; shell = f[6] || shell; }
    });
    this.env.USER = user;
    this.env.LOGNAME = user;
    this.env.HOME = home;
    this.env.SHELL = shell;
    this.env.UID = String(uid);
    this.cwd = home;
    this.env.PWD = home;
    this.isRoot = (uid === 0);
    return this;
  };

  Shell.prototype.start = function (motd) {
    this.running = true;
    if (motd !== false) this.printMotd();
    this.newPrompt();
  };

  // The most common coreutils failure wording:  `prog: name: strerror`.
  // Programs that say something else (head, sort, tac, cp, ...) format it
  // themselves -- the difference is exactly what you see on a real machine.
  function gnuErr(prog, name, kind) {
    return prog + ": " + name + ": " +
      (kind === "dir" ? "Is a directory"
        : kind === "perm" ? "Permission denied"
          : "No such file or directory");
  }

  // A usage complaint of the program's own -- "tr: missing operand" rather
  // than a getopt error -- still ends with coreutils' hint line.
  function usage(sh, prog, msg, code) {
    sh._error(prog + ": " + msg);
    sh._error("Try '" + prog + " --help' for more information.");
    return { out: "", code: code === undefined ? 1 : code };
  }

  // Walk a command's inputs: "-" (or no operand at all) is stdin, read at
  // most once per invocation, and an unreadable input is reported through
  // errFmt while the rest keeps going.  fn(text, name) sees each one; name
  // is null for stdin.  Returns the status coreutils would return.
  function eachInput(prog, args, stdin, sh, errFmt, fn) {
    var files = args.length ? args : ["-"], code = 0, taken = false;
    for (var i = 0; i < files.length; i++) {
      var name = files[i];
      if (name === "-") {
        if (!taken) { fn(stdin || "", null); taken = true; }
        continue;
      }
      var p = sh.path(name), n = V.getNode(p), kind = null;
      if (!n) kind = "missing";
      else if (n.t === "d") kind = "dir";
      var d = kind ? null : V.readFile(p);
      if (d === null && !kind) kind = "missing";
      if (kind) { sh._error((errFmt || gnuErr)(prog, name, kind)); code = 1; continue; }
      fn(d, name);
    }
    return code;
  }

  // The coreutils register.  src/coreutils_*.js define their commands with
  // LW.core.defCmd() after this file has loaded, and share its option
  // parser, so `cp` and `cat` fail the same way coreutils does.
  LW.core = {
    defCmd: defCmd, defBui: defBui, opt: opt,
    getopt: getopt, finish: finish, doc: doc,
    eachInput: eachInput, gnuErr: gnuErr, usage: usage,
    sgr: sgr, human: human, CMDS: CMDS,
  };

  LW.Shell = Shell;
})(window.LW);
