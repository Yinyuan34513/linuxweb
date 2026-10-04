// getty(8) + login(1): the console login flow.
//
// Prints /etc/issue, prompts "<host> login:", reads a hidden password, checks
// it against /etc/shadow (SHA-256), prints "Login incorrect" and retries on
// failure, and on success shows the motd and starts a login shell.  When the
// user logs out the getty comes back, exactly like a real console.
(function (LW) {
  "use strict";

  var V = LW.VFS;

  // Complete Ctrl+ mapping for the login prompt.  Every Ctrl+<char> is listed;
  // chords with no meaning while logging in map to "ignore" instead of falling
  // through to a literal insert.
  var CTRL = {
    "@": "erase-line",   // (set-mark has no meaning here)
    "a": "beginning",
    "b": "left",
    "c": "restart",
    "d": "eof",
    "e": "end",
    "f": "right",
    "g": "abort",
    "h": "erase-char",
    "i": "ignore",       // Tab
    "j": "accept",       // LF
    "k": "erase-line",
    "l": "clear",
    "m": "accept",       // CR
    "n": "ignore",
    "o": "ignore",
    "p": "ignore",
    "q": "ignore",
    "r": "redraw",
    "s": "ignore",
    "t": "ignore",
    "u": "erase-line",
    "v": "ignore",       // quoted-insert
    "w": "erase-word",
    "x": "ignore",
    "y": "ignore",
    "z": "ignore",       // suspend
    "[": "abort",        // ESC
    "\\": "abort",       // SIGQUIT
    "]": "ignore",
    "^": "ignore",
    "_": "ignore",
    "?": "erase-char",   // DEL
  };

  function shadowField(user) {
    var s = V.readFile("/etc/shadow") || "";
    var arr = s.split("\n");
    for (var i = 0; i < arr.length; i++) {
      var f = arr[i].split(":");
      if (f[0] === user) return f[1];
    }
    return null;
  }

  function userExists(user) {
    var pw = V.readFile("/etc/passwd") || "";
    return pw.split("\n").some(function (l) { return l.split(":")[0] === user; });
  }

  function auth(user, pass) {
    var field = shadowField(user);
    if (field === null) return false;
    if (field === "!" || field === "*") return false;   // locked account
    if (field === "") return pass === "";               // empty password
    return LW.checkPassword(field, pass);
  }

  function Getty(term, onShell) {
    this.term = term;
    this.onShell = onShell;
    this.mode = "login";
    this.buf = "";
    this.cursor = 0;
    this.user = "";
    this.busy = false;
    this.attempts = 0;
    this.inRow = 0;
    this.inStart = 0;
    this.lastLen = 0;
  }

  Getty.prototype.issue = function () {
    var s = V.readFile("/etc/issue") || "Debian GNU/Linux 13 \\n \\l\n\n";
    // \\l is this terminal's own name, so tty2 really says tty2.
    var ttyName = "tty" + (this.term.vt || 1);
    return s.replace(/\\n/g, V.HOST).replace(/\\l/g, ttyName)
      .replace(/\\r/g, "7.2.8").replace(/\\m/g, "x86_64");
  };

  Getty.prototype.start = function () {
    this.busy = false;
    this.attempts = 0;
    var t = this.term;
    if (t.col !== 0) t.write("\n");
    t.write(this.issue());
    this.promptLogin();
  };

  // The state reset that makes a retry behave exactly like the first attempt.
  Getty.prototype.promptLogin = function () {
    this.mode = "login";
    this.buf = "";
    this.cursor = 0;
    this.user = "";
    var t = this.term;
    t.write(V.HOST + " login: ");
    this.inRow = t.row;
    this.inStart = t.col;
    this.lastLen = 0;
    t.render();
  };

  Getty.prototype.promptPassword = function () {
    this.mode = "password";
    this.buf = "";
    this.cursor = 0;
    this.term.write("Password: ");
    this.term.render();
  };

  Getty.prototype.redraw = function () {
    var t = this.term;
    if (this.mode !== "login") return;
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

  Getty.prototype.fail = function () {
    var self = this;
    this.busy = true;
    this.attempts++;
    this.term.write("Login incorrect\n");
    this.term.render();
    // login(1) backs off briefly before letting you try again
    setTimeout(function () { self.busy = false; self.promptLogin(); }, 1200);
  };

  Getty.prototype.success = function () {
    var t = this.term;
    t.write("Last login: Sat Oct  3 09:13:58 UTC 2026 on tty1\n");
    var motd = V.readFile("/etc/motd");
    if (motd) t.write(motd);
    t.write("\n");
    t.render();
    this.onShell(this.user);
  };

  Getty.prototype.accept = function () {
    var t = this.term;
    t.write("\n");
    if (this.mode === "login") {
      var u = this.buf.trim();
      if (u === "") { this.promptLogin(); return; }
      this.user = u;
      if (!userExists(u)) { this.fail(); return; }
      this.promptPassword();
      return;
    }
    var p = this.buf;
    this.buf = "";
    this.cursor = 0;
    if (auth(this.user, p)) this.success();
    else this.fail();
  };

  Getty.prototype.eraseChar = function () {
    if (this.mode !== "login") {
      if (this.cursor > 0) { this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor); this.cursor--; }
      return;
    }
    if (this.cursor > 0) {
      this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
      this.cursor--;
      this.redraw();
    }
  };

  Getty.prototype.eraseWord = function () {
    if (this.mode !== "login") return;
    while (this.cursor > 0 && this.buf[this.cursor - 1] === " ") { this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor); this.cursor--; }
    while (this.cursor > 0 && this.buf[this.cursor - 1] !== " ") { this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor); this.cursor--; }
    this.redraw();
  };

  Getty.prototype.eraseLine = function () {
    if (this.mode !== "login") { this.buf = ""; this.cursor = 0; return; }
    this.buf = ""; this.cursor = 0; this.redraw();
  };

  Getty.prototype.insert = function (ch) {
    this.buf = this.buf.slice(0, this.cursor) + ch + this.buf.slice(this.cursor);
    this.cursor++;
    if (this.mode === "login") this.redraw();
  };

  Getty.prototype.ctrl = function (name) {
    var t = this.term;
    switch (name) {
      case "accept": this.accept(); return;
      case "erase-char": this.eraseChar(); return;
      case "erase-word": this.eraseWord(); return;
      case "erase-line": this.eraseLine(); return;
      case "beginning": if (this.mode === "login") { this.cursor = 0; this.redraw(); } return;
      case "end": if (this.mode === "login") { this.cursor = this.buf.length; this.redraw(); } return;
      case "left": if (this.mode === "login" && this.cursor > 0) { this.cursor--; this.redraw(); } return;
      case "right": if (this.mode === "login" && this.cursor < this.buf.length) { this.cursor++; this.redraw(); } return;
      case "clear": t.clear(); t.write(this.issue()); t.write(V.HOST + " login: ");
        this.inRow = t.row; this.inStart = t.col; this.lastLen = 0; t.render(); return;
      case "redraw":
        if (this.mode === "login") this.redraw(); else t.render();
        return;
      case "restart":                 // Ctrl+C: login(1) starts over
        t.write("^C\n");
        this.promptLogin();
        return;
      case "eof":                     // Ctrl+D
        if (this.buf === "") t.write("\n");
        this.promptLogin();
        return;
      case "abort":                   // Ctrl+G / Ctrl+\ / ESC
        t.write("\n");
        this.promptLogin();
        return;
      case "ignore":
      default:
        return;
    }
  };

  Getty.prototype.onKey = function (ev) {
    if (this.busy) { return true; }
    var t = this.term, k = ev.key;

    if (ev.ctrlKey && !ev.altKey) {
      var c = LW.ctrlChar(ev);
      if (c && CTRL[c]) this.ctrl(CTRL[c]);
      return true;                     // every Ctrl chord is consumed
    }
    if (ev.altKey) return true;

    if (ev.metaKey) return true;

    switch (k) {
      case "Enter": this.accept(); return true;
      case "Backspace": this.eraseChar(); return true;
      case "Delete": this.eraseChar(); return true;
      case "ArrowLeft": this.ctrl("left"); return true;
      case "ArrowRight": this.ctrl("right"); return true;
      case "Home": this.ctrl("beginning"); return true;
      case "End": this.ctrl("end"); return true;
      case "Tab": return true;
      case "Escape": this.ctrl("abort"); return true;
    }
    if (k && k.length === 1) { this.insert(k); return true; }   // password: buffers, never echoes
    return false;
  };

  LW.Getty = Getty;
  LW.GETTY_CTRL = CTRL;
})(window.LW);
