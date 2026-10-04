// The VT escape engine: everything a Linux virtual terminal understands beyond
// SGR.  Cursor addressing, erase/insert/delete, scroll margins, tab stops, the
// alternate screen, DEC private modes, saved cursor and resets.
//
// Loaded after renderer.js; adds methods to LW.VGAText.
(function (LW) {
  "use strict";

  var V = LW.VGAText.prototype;
  var COLS = LW.TEXT_COLS, ROWS = LW.TEXT_ROWS;

  function defaults() { return LW.defaultColors(); }

  // Write a blank cell, either with the current SGR colours (BCE) or defaults.
  V._blankAt = function (idx, useCurrent) {
    this.ch[idx] = 0x20;
    if (useCurrent) {
      var fg = this._effFg(), bg = this._effBg();
      if (this.sgrReverse) { var sw = fg; fg = bg; bg = sw; }
      this.cfg[idx] = fg;
      this.cbg[idx] = bg;
    } else {
      var d = defaults();
      this.cfg[idx] = d[0];
      this.cbg[idx] = d[1];
    }
    this.cattr[idx] = 0;
  };

  // ---------------------------------------------------------------- tabs ---
  V._tabs = function () {
    if (!this.tabStops) {
      this.tabStops = new Uint8Array(COLS);
      for (var i = 8; i < COLS; i += 8) this.tabStops[i] = 1;
    }
    return this.tabStops;
  };

  V._tabForward = function (n) {
    var stops = this._tabs();
    for (var k = 0; k < n; k++) {
      var c = this.col + 1;
      while (c < COLS - 1 && !stops[c]) c++;
      this.col = Math.min(c, COLS - 1);
    }
    if (this.col >= COLS - 1) this.col = COLS - 1;
  };

  V._tabBackward = function (n) {
    var stops = this._tabs();
    for (var k = 0; k < n; k++) {
      var c = this.col - 1;
      while (c > 0 && !stops[c]) c--;
      this.col = Math.max(c, 0);
    }
  };

  V._setTabStop = function () { this._tabs()[this.col] = 1; };

  V._clearTabStop = function (mode) {
    var stops = this._tabs();
    if (mode === 3) stops.fill(0);
    else if (this.col < COLS) stops[this.col] = 0;
  };

  // ------------------------------------------------------------ scrolling ---
  // Scroll the region [top..bot] up by n lines, blanking the new bottom lines.
  V._scrollUp = function (n) {
    if (n <= 0) return;
    var span = this.bot - this.top + 1;
    if (n > span) n = span;
    var move = n * COLS;
    var from = this.top * COLS, to = (this.bot + 1) * COLS;
    this.ch.copyWithin(from, from + move, to);
    this.cfg.copyWithin(from, from + move, to);
    this.cbg.copyWithin(from, from + move, to);
    this.cattr.copyWithin(from, from + move, to);
    for (var i = (this.bot - n + 1) * COLS; i < (this.bot + 1) * COLS; i++) this._blankAt(i, false);
  };

  V._scrollDown = function (n) {
    if (n <= 0) return;
    var span = this.bot - this.top + 1;
    if (n > span) n = span;
    var move = n * COLS;
    var from = this.top * COLS, to = (this.bot + 1) * COLS;
    this.ch.copyWithin(from + move, from, to - move);
    this.cfg.copyWithin(from + move, from, to - move);
    this.cbg.copyWithin(from + move, from, to - move);
    this.cattr.copyWithin(from + move, from, to - move);
    for (var i = from; i < from + move; i++) this._blankAt(i, false);
  };

  // --------------------------------------------------------------- erasing ---
  V._eraseInLine = function (mode) {
    var base = this.row * COLS;
    var from, to;
    if (mode === 0) { from = this.col; to = COLS; }
    else if (mode === 1) { from = 0; to = this.col + 1; }
    else { from = 0; to = COLS; }
    for (var c = from; c < to; c++) this._blankAt(base + c, true);
  };

  V._eraseInDisplay = function (mode) {
    var i, from, to;
    if (mode === 0) {
      from = this.row * COLS + this.col; to = ROWS * COLS;
      for (i = from; i < to; i++) this._blankAt(i, true);
    } else if (mode === 1) {
      from = 0; to = this.row * COLS + this.col + 1;
      for (i = from; i < to; i++) this._blankAt(i, true);
    } else if (mode === 2 || mode === 3) {
      for (i = 0; i < ROWS * COLS; i++) this._blankAt(i, true);
      if (mode === 3) { /* xterm also drops the scrollback; we keep none */ }
    }
  };

  V._eraseChars = function (n) {
    var base = this.row * COLS;
    for (var c = this.col; c < Math.min(COLS, this.col + n); c++) this._blankAt(base + c, true);
  };

  // ----------------------------------------------------- line/char editing ---
  V._insertLines = function (n) {
    if (this.row < this.top || this.row > this.bot) return;
    var span = this.bot - this.row + 1;
    if (n > span) n = span;
    var move = n * COLS;
    var from = this.row * COLS, to = (this.bot + 1) * COLS;
    this.ch.copyWithin(from + move, from, to - move);
    this.cfg.copyWithin(from + move, from, to - move);
    this.cbg.copyWithin(from + move, from, to - move);
    this.cattr.copyWithin(from + move, from, to - move);
    for (var i = from; i < from + move; i++) this._blankAt(i, false);
  };

  V._deleteLines = function (n) {
    if (this.row < this.top || this.row > this.bot) return;
    var span = this.bot - this.row + 1;
    if (n > span) n = span;
    var move = n * COLS;
    var from = this.row * COLS, to = (this.bot + 1) * COLS;
    this.ch.copyWithin(from, from + move, to);
    this.cfg.copyWithin(from, from + move, to);
    this.cbg.copyWithin(from, from + move, to);
    this.cattr.copyWithin(from, from + move, to);
    for (var i = (this.bot - n + 1) * COLS; i < (this.bot + 1) * COLS; i++) this._blankAt(i, false);
  };

  V._insertChars = function (n) {
    if (n <= 0) return;
    var base = this.row * COLS;
    var span = COLS - this.col;
    if (n > span) n = span;
    this.ch.copyWithin(base + this.col + n, base + this.col, base + COLS);
    this.cfg.copyWithin(base + this.col + n, base + this.col, base + COLS);
    this.cbg.copyWithin(base + this.col + n, base + this.col, base + COLS);
    this.cattr.copyWithin(base + this.col + n, base + this.col, base + COLS);
    for (var c = this.col; c < this.col + n; c++) this._blankAt(base + c, true);
  };

  V._deleteChars = function (n) {
    if (n <= 0) return;
    var base = this.row * COLS;
    var span = COLS - this.col;
    if (n > span) n = span;
    var keep = COLS - this.col - n;
    this.ch.copyWithin(base + this.col, base + this.col + n, base + COLS);
    this.cfg.copyWithin(base + this.col, base + this.col + n, base + COLS);
    this.cbg.copyWithin(base + this.col, base + this.col + n, base + COLS);
    this.cattr.copyWithin(base + this.col, base + this.col + n, base + COLS);
    for (var c = this.col + keep; c < COLS; c++) this._blankAt(base + c, true);
  };

  // -------------------------------------------------------- saved cursor ---
  V._saveCursor = function () {
    this.saved = { col: this.col, row: this.row, fgIdx: this.fgIdx, fgRGB: this.fgRGB,
      bgIdx: this.bgIdx, bgRGB: this.bgRGB, bold: this.sgrBold, dim: this.sgrDim,
      reverse: this.sgrReverse, conceal: this.sgrConceal,
      underline: this.sgrUnderline, strike: this.sgrStrike,
      top: this.top, bot: this.bot, origin: this.originMode };
  };

  V._restoreCursor = function () {
    var s = this.saved;
    if (!s) return;
    this.col = s.col; this.row = s.row;
    this.fgIdx = s.fgIdx; this.fgRGB = s.fgRGB;
    this.bgIdx = s.bgIdx; this.bgRGB = s.bgRGB;
    this.sgrBold = s.bold; this.sgrDim = s.dim; this.sgrReverse = s.reverse;
    this.sgrConceal = s.conceal; this.sgrUnderline = s.underline; this.sgrStrike = s.strike;
    this.top = s.top; this.bot = s.bot; this.originMode = s.origin;
    this._wrapPending = false;
  };

  // -------------------------------------------------------- alternate screen ---
  V._altScreen = function (enter) {
    if (enter) {
      if (this.mainBuf) return;
      this.mainBuf = {
        ch: this.ch, cfg: this.cfg, cbg: this.cbg, cattr: this.cattr,
        col: this.col, row: this.row, top: this.top, bot: this.bot, saved: this.saved,
      };
      this.ch = new Uint8Array(COLS * ROWS);
      this.cfg = new Uint32Array(COLS * ROWS);
      this.cbg = new Uint32Array(COLS * ROWS);
      this.cattr = new Uint8Array(COLS * ROWS);
      for (var i = 0; i < COLS * ROWS; i++) this._blankAt(i, false);
      this.col = 0; this.row = 0; this.top = 0; this.bot = ROWS - 1;
      this._wrapPending = false; this.saved = null;
    } else {
      if (!this.mainBuf) return;
      var m = this.mainBuf;
      this.mainBuf = null;
      this.ch = m.ch; this.cfg = m.cfg; this.cbg = m.cbg; this.cattr = m.cattr;
      this.col = m.col; this.row = m.row; this.top = m.top; this.bot = m.bot;
      this.saved = m.saved;
      this._wrapPending = false;
    }
  };

  // ------------------------------------------------------------- modes ---
  V._setMode = function (mode, on, priv) {
    if (priv) {
      switch (mode) {
        case 1: this.appCursorKeys = on; return;                 // DECCKM
        case 6:                                                  // DECOM
          this.originMode = on;
          this.col = 0;
          this.row = on ? this.top : 0;
          this._wrapPending = false;
          return;
        case 7: this.autoWrap = on; return;                      // DECAWM
        case 25: this.cursorVisible = on; return;                // DECTCEM
        case 47: case 1047: case 1049: this._altScreen(on); return;
        default: return;
      }
    }
    switch (mode) {
      case 4: this.insertMode = on; return;                      // IRM
      default: return;                                           // LNM etc: ignore
    }
  };

  // ------------------------------------------------------------------ RIS ---
  V._resetTerm = function () {
    if (this.mainBuf) this._altScreen(false);
    this._resetSgr();
    this.tabStops = null;
    this.top = 0;
    this.bot = ROWS - 1;
    this.col = 0;
    this.row = 0;
    this._wrapPending = false;
    this.autoWrap = true;
    this.insertMode = false;
    this.originMode = false;
    this.appCursorKeys = false;
    this.saved = null;
    for (var i = 0; i < ROWS * COLS; i++) this._blankAt(i, false);
    this.render();
  };

  // ------------------------------------------------- the escape dispatcher ---
  // Called from putChar while an escape sequence is being collected.
  V._escSeq = function (code) {
    var e = this._esc;
    if (e === "") {
      if (code === 0x5b) { this._esc = "["; return; }            // CSI
      if (code === 0x5d || code === 0x50 || code === 0x5e || code === 0x5f) {
        this._esc = "STR"; return;                               // OSC DCS PM APC
      }
      if (code === 0x28 || code === 0x29 || code === 0x2a || code === 0x2b ||
          code === 0x23 || code === 0x20 || code === 0x25) {
        this._esc = "CHR"; return;                               // one more byte
      }
      this._esc = null;
      this._handleEsc(String.fromCharCode(code));
      return;
    }
    if (e === "STR") {
      if (code === 0x07) { this._esc = null; return; }           // BEL ends OSC
      if (code === 0x1b) { this._esc = "STR2"; return; }
      return;
    }
    if (e === "STR2") {
      this._esc = (code === 0x5c) ? null : "STR";                // ESC \ = ST
      return;
    }
    if (e === "CHR") { this._esc = null; return; }               // swallow it
    if (e.charAt(0) === "[") {
      if (code >= 0x40 && code <= 0x7e) {
        var params = e.slice(1);
        this._esc = null;
        this._csi(params, String.fromCharCode(code));
      } else {
        this._esc += String.fromCharCode(code);
      }
      return;
    }
    this._esc = null;
  };

  // ESC <final> -- the non-CSI set.
  V._handleEsc = function (f) {
    switch (f) {
      case "7": this._saveCursor(); return;                      // DECSC
      case "8": this._restoreCursor(); return;                   // DECRC
      case "D": this._wrapPending = false; this._lineFeed(); return;          // IND
      case "E": this._wrapPending = false; this.col = 0; this._lineFeed(); return; // NEL
      case "M":                                                  // RI
        this._wrapPending = false;
        if (this.row === this.top) this._scrollDown(1);
        else if (this.row > 0) this.row--;
        return;
      case "H": this._setTabStop(); return;                      // HTS
      case "c": this._resetTerm(); return;                       // RIS
      case "=": case ">": case "Z": return;                      // keypad / DA
      default: return;
    }
  };

  // CSI <params> <final>.
  V._csi = function (pstr, f) {
    var priv = false, inter = "";
    var s = pstr;
    if (s.charAt(0) === "?") { priv = true; s = s.slice(1); }
    else if (s.charAt(0) === ">") { s = s.slice(1); }
    // split off any intermediate bytes (0x20..0x2f)
    var parts = s.split(/[;:]/).map(function (x) {
      var m = /^[0-9]*/.exec(x)[0];
      if (m !== x) inter = x.slice(m.length);
      return m === "" ? null : parseInt(m, 10);
    });
    function arg(i, dflt) {
      var v = parts[i];
      return (v === null || v === undefined || v === 0 && dflt !== undefined) ? dflt : v;
    }
    function raw(i) { var v = parts[i]; return (v === null || v === undefined) ? 0 : v; }
    var t = this;
    function clampRow(r) {
      return t.originMode ? Math.min(t.bot, Math.max(t.top, r))
        : Math.max(0, Math.min(ROWS - 1, r));
    }

    switch (f) {
      case "A": t.row = clampRow(t.row - arg(0, 1)); break;               // CUU
      case "B": t.row = clampRow(t.row + arg(0, 1)); break;               // CUD
      case "C": case "a": t.col = Math.min(COLS - 1, t.col + arg(0, 1)); break;  // CUF/CHA? (a=HPR)
      case "D": t.col = Math.max(0, t.col - arg(0, 1)); break;                   // CUB
      case "E": t.row = clampRow(t.row + arg(0, 1)); t.col = 0; break;    // CNL
      case "F": t.row = clampRow(t.row - arg(0, 1)); t.col = 0; break;    // CPL
      case "G": case "`": t.col = Math.min(COLS, Math.max(1, arg(0, 1))) - 1; break; // CHA
      case "d": {                                                                // VPA
        var r = Math.min(ROWS, Math.max(1, arg(0, 1))) - 1;
        t.row = t.originMode ? Math.min(t.bot, t.top + r) : r;
        break;
      }
      case "H": case "f": {                                                      // CUP
        var rr = Math.min(ROWS, Math.max(1, arg(0, 1))) - 1;
        var cc = Math.min(COLS, Math.max(1, arg(1, 1))) - 1;
        t.row = t.originMode ? Math.min(t.bot, t.top + rr) : rr;
        t.col = cc;
        break;
      }
      case "J": t._eraseInDisplay(raw(0)); break;                                // ED
      case "K": t._eraseInLine(raw(0)); break;                                   // EL
      case "L": t._insertLines(arg(0, 1)); break;                                // IL
      case "M": t._deleteLines(arg(0, 1)); break;                                // DL
      case "@": t._insertChars(arg(0, 1)); break;                                // ICH
      case "P": t._deleteChars(arg(0, 1)); break;                                // DCH
      case "X": t._eraseChars(arg(0, 1)); break;                                 // ECH
      case "S": t._scrollUp(arg(0, 1)); break;                                   // SU
      case "T": t._scrollDown(arg(0, 1)); break;                                 // SD
      case "r": {                                                                // DECSTBM
        var top = Math.max(1, arg(0, 1)) - 1;
        var bot = Math.min(ROWS, arg(1, ROWS)) - 1;
        if (bot > top) { t.top = top; t.bot = bot; t.col = 0; t.row = t.originMode ? top : 0; }
        break;
      }
      case "s": t._saveCursor(); break;                                          // SCOSC
      case "u": t._restoreCursor(); break;                                       // SCORC
      case "g": t._clearTabStop(raw(0)); break;                                  // TBC
      case "I": for (var i = 0; i < arg(0, 1); i++) t._tabForward(1); break;     // CHT
      case "Z": for (var z = 0; z < arg(0, 1); z++) t._tabBackward(1); break;    // CBT
      case "h": parts.forEach(function (m) { if (m !== null) t._setMode(m, true, priv); }); break;
      case "l": parts.forEach(function (m) { if (m !== null) t._setMode(m, false, priv); }); break;
      case "m": t._sgr(pstr.charAt(0) === "?" ? pstr.slice(1) : pstr); break;
      case "n":                                                                  // DSR
        if (raw(0) === 6) t._respond("\x1b[" + (t.row + 1) + ";" + (t.col + 1) + "R");
        else if (raw(0) === 5) t._respond("\x1b[0n");
        break;
      case "c":                                                                  // DA
        if (raw(0) === 0) t._respond("\x1b[?6c");                                // VT102
        break;
      default: break;
    }
  };

  // Replies (DSR/DA) go back to whoever feeds the terminal, if anything.
  V._respond = function (s) {
    if (typeof this.onResponse === "function") this.onResponse(s);
  };
})(window.LW);
