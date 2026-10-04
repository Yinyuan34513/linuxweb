// An 80x25 VGA text-mode renderer drawn pixel-for-pixel with the Linux 8x16
// font.  The canvas is 640x400 native; CSS scales it by an integer factor with
// image-rendering:pixelated so glyphs stay crisp squares.
//
// It speaks ANSI SGR (ESC [ ... m) using the Linux/VGA console palette, and it
// can replay a log at the pace implied by its `[    0.000000] ` timestamps.
//
// Requires font.js (window.LW.DATA) to be loaded first.
(function (LW) {
  "use strict";

  var CW = 8, CH = 16, COLS = 80, ROWS = 25;
  var W = COLS * CW, H = ROWS * CH;

  var DEF_FG = 7;  // light grey
  var DEF_BG = 0;  // black

  function pack(r, g, b) {
    return ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }

  // Base palette (colours 0..15).  Two choices, because "systemd style" looks
  // different on a VGA console than in a modern terminal:
  //   xterm - the modern-terminal palette (default): default fg is #e5e5e5 and
  //           bold green is #00ff00, i.e. what `\e[0;1;32m` looks like today.
  //   vga   - the Linux console / vgacon palette: #aaaaaa on black, bold green
  //           #55ff55, i.e. what systemd's fallback renders on a real VT.
  var PALETTES = {
    vga: [
      0x000000, 0xaa0000, 0x00aa00, 0xaa5500,
      0x0000aa, 0xaa00aa, 0x00aaaa, 0xaaaaaa,
      0x555555, 0xff5555, 0x55ff55, 0xffff55,
      0x5555ff, 0xff55ff, 0x55ffff, 0xffffff
    ],
    xterm: [
      0x000000, 0xcd0000, 0x00cd00, 0xcdcd00,
      0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5,
      0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00,
      0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff
    ]
  };
  var BASE = [];   // packed, set by setPalette()

  function setPalette(name) {
    var rgb = PALETTES[name] || PALETTES.xterm;
    BASE = rgb.map(function (c) {
      return pack((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff);
    });
  }

  // xterm-256 colour n -> packed RGB.  0..15 follow the active base palette,
  // 16..231 are the 6x6x6 cube, 232..255 the 24-step greyscale ramp.
  var CUBE = [0, 95, 135, 175, 215, 255];
  function xterm256(n) {
    n = n & 0xff;
    if (n < 16) return BASE[n];
    if (n < 232) {
      var i = n - 16;
      return pack(CUBE[(i / 36) | 0], CUBE[((i % 36) / 6) | 0], CUBE[i % 6]);
    }
    var v = 8 + (n - 232) * 10;
    return pack(v, v, v);
  }

  // Parse the leading `[   12.345678] ` of a kernel log line, if present.
  function parseTime(line) {
    var m = /^\[\s*(\d+)\.(\d+)\]/.exec(line);
    if (!m) return null;
    return parseInt(m[1], 10) + parseFloat("0." + m[2]);
  }

  function VGAText(canvas, opts) {
    opts = opts || {};
    setPalette(opts.palette || "xterm");
    this.cols = COLS;
    this.rows = ROWS;
    this.W = W;
    this.H = H;

    canvas.width = W;
    canvas.height = H;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.img = this.ctx.createImageData(W, H);
    this.px = new Uint32Array(this.img.data.buffer);

    this.ch = new Uint8Array(COLS * ROWS);
    this.cfg = new Uint32Array(COLS * ROWS);  // packed RGB per cell
    this.cbg = new Uint32Array(COLS * ROWS);
    this.cattr = new Uint8Array(COLS * ROWS); // underline / strike bits

    this.col = 0;
    this.row = 0;
    // --- VT state (see vt.js for the escape engine that drives it) ---
    this.top = 0;
    this.bot = ROWS - 1;
    this._wrapPending = false;
    this.autoWrap = true;
    this.insertMode = false;
    this.originMode = false;
    this.appCursorKeys = false;
    this.tabStops = null;          // built lazily: every 8 columns
    this.saved = null;
    this.mainBuf = null;           // set while the alternate screen is active
    this.cursorVisible = opts.cursor !== false;
    this.blinkOn = true;
    this._blink = null;
    this._timer = null;
    this._prevTime = 0;
    this._sawTime = false;

    this._resetSgr();
    this.clear();
    if (this.cursorVisible) this.startBlink();
  }

  VGAText.prototype._resetSgr = function () {
    this.fgIdx = DEF_FG;   // indexed colour 0..15
    this.fgRGB = null;     // or an exact RGB (set via 38;5;n / 38;2;r;g;b)
    this.bgIdx = DEF_BG;
    this.bgRGB = null;
    this.sgrBold = false;
    this.sgrDim = false;
    this.sgrReverse = false;
    this.sgrConceal = false;
    this.sgrUnderline = false;
    this.sgrStrike = false;
    this._esc = null;
  };

  // Effective packed colours for a cell.  Bold brightens an indexed 0..7, dim
  // darkens an indexed 8..15, and conceal paints the text in the background.
  VGAText.prototype._effFg = function () {
    if (this.sgrConceal) return this._effBg();
    if (this.fgRGB !== null) return this.fgRGB;
    var i = this.fgIdx;
    if (this.sgrBold && i < 8) i += 8;
    else if (this.sgrDim && i >= 8) i -= 8;
    return BASE[i];
  };

  VGAText.prototype._effBg = function () {
    return this.bgRGB !== null ? this.bgRGB : BASE[this.bgIdx];
  };

  VGAText.prototype._attrs = function () {
    var a = 0;
    if (this.sgrUnderline) a |= ATTR_UNDERLINE;
    if (this.sgrStrike) a |= ATTR_STRIKE;
    return a;
  };

  VGAText.prototype.clear = function () {
    this.ch.fill(0x20);
    this.cfg.fill(BASE[DEF_FG]);
    this.cbg.fill(BASE[DEF_BG]);
    this.cattr.fill(0);
    this.col = 0;
    this.row = 0;
    this.top = 0;
    this.bot = ROWS - 1;
    this._wrapPending = false;
    this._prevTime = 0;
    this._sawTime = false;
    this._resetSgr();
    this.render();
  };

  // LF/IND: move down, scrolling inside the margins when already at bottom.
  VGAText.prototype._lineFeed = function () {
    if (this.row === this.bot) {
      if (this._scrollUp) this._scrollUp(1);
      else { this.ch.copyWithin(0, COLS); this.cfg.copyWithin(0, COLS);
             this.cbg.copyWithin(0, COLS); this.cattr.copyWithin(0, COLS);
             for (var i = (ROWS - 1) * COLS; i < ROWS * COLS; i++) {
               this.ch[i] = 0x20; this.cfg[i] = BASE[DEF_FG];
               this.cbg[i] = BASE[DEF_BG]; this.cattr[i] = 0; } }
    } else if (this.row < ROWS - 1) this.row++;
  };
  VGAText.prototype._newline = VGAText.prototype._lineFeed;

  // Apply an SGR parameter list (the text between ESC [ and m).  Accepts ';'
  // and ':' separators, so systemd's `38:5:185` and xterm's `38;5;245` both
  // work, and tolerates the optional colourspace slot in `38:2::r:g:b`.
  var ATTR_UNDERLINE = 1, ATTR_STRIKE = 2;

  VGAText.prototype._sgr = function (params) {
    var parts = (params.length ? params.split(/[;:]/) : ["0"]);
    for (var i = 0; i < parts.length; i++) {
      var n = parseInt(parts[i], 10);
      if (isNaN(n)) n = 0;

      if (n === 0) {
        this.fgIdx = DEF_FG; this.fgRGB = null;
        this.bgIdx = DEF_BG; this.bgRGB = null;
        this.sgrBold = this.sgrDim = this.sgrReverse = this.sgrConceal =
          this.sgrUnderline = this.sgrStrike = false;
      } else if (n === 1) this.sgrBold = true;
      else if (n === 2) this.sgrDim = true;
      else if (n === 3) { /* italic: no VGA equivalent */ }
      else if (n === 4) this.sgrUnderline = true;
      else if (n === 5 || n === 6) { /* blink: the cursor owns blinking */ }
      else if (n === 7) this.sgrReverse = true;
      else if (n === 8) this.sgrConceal = true;
      else if (n === 9) this.sgrStrike = true;
      else if (n === 21 || n === 22) this.sgrBold = this.sgrDim = false;
      else if (n === 23) { /* italic off */ }
      else if (n === 24) this.sgrUnderline = false;
      else if (n === 25) { /* blink off */ }
      else if (n === 27) this.sgrReverse = false;
      else if (n === 28) this.sgrConceal = false;
      else if (n === 29) this.sgrStrike = false;
      else if (n >= 30 && n <= 37) { this.fgIdx = n - 30; this.fgRGB = null; }
      else if (n === 39) { this.fgIdx = DEF_FG; this.fgRGB = null; }
      else if (n >= 40 && n <= 47) { this.bgIdx = n - 40; this.bgRGB = null; }
      else if (n === 49) { this.bgIdx = DEF_BG; this.bgRGB = null; }
      else if (n >= 90 && n <= 97) { this.fgIdx = n - 90 + 8; this.fgRGB = null; }
      else if (n >= 100 && n <= 107) { this.bgIdx = n - 100 + 8; this.bgRGB = null; }
      else if (n === 38 || n === 48) {
        var isFg = (n === 38);
        var m = parseInt(parts[i + 1], 10);
        if (m === 5) {                                   // 38;5;<0..255>
          var idx = parseInt(parts[i + 2], 10);
          if (isNaN(idx)) idx = 0;
          var c = xterm256(idx & 0xff);
          if (isFg) this.fgRGB = c; else this.bgRGB = c;
          i += 2;
        } else if (m === 2) {                            // 38;2;[cs;]<r>;<g>;<b>
          var off = /^\d+$/.test(parts[i + 2] || "") ? 0 : 1;   // skip colourspace
          var r = parseInt(parts[i + 2 + off], 10);
          var g = parseInt(parts[i + 3 + off], 10);
          var b = parseInt(parts[i + 4 + off], 10);
          if (isNaN(r)) r = 0; if (isNaN(g)) g = 0; if (isNaN(b)) b = 0;
          var rgb = pack(r & 0xff, g & 0xff, b & 0xff);
          if (isFg) this.fgRGB = rgb; else this.bgRGB = rgb;
          i += 4 + off;
        }
      }
      // anything else: ignore
    }
  };

  // A real VT cursor only wraps when the *next* glyph arrives, so writing to
  // the last column leaves a pending wrap instead of scrolling immediately.
  VGAText.prototype._putGlyph = function (code) {
    if (this._wrapPending) {
      this._wrapPending = false;
      this.col = 0;
      this._lineFeed();
    }
    if (this.insertMode) this._insertChars(1);
    var idx = this.row * COLS + this.col;
    var fg = this._effFg(), bg = this._effBg();
    if (this.sgrReverse) { var sw = fg; fg = bg; bg = sw; }
    this.ch[idx] = code;
    this.cfg[idx] = fg;
    this.cbg[idx] = bg;
    this.cattr[idx] = this._attrs();
    if (this.col === COLS - 1) this._wrapPending = this.autoWrap;
    else this.col++;
  };

  VGAText.prototype.putChar = function (code) {
    if (this._esc !== null) { if (this._escSeq) this._escSeq(code); else this._esc = null; return; }
    if (code === 0x1b) { this._esc = ""; return; }
    if (code === 0x07) return;                                   // BEL
    if (code === 0x0a) {                                         // LF (ONLCR: CR+LF)
      this._wrapPending = false;
      this.col = 0;
      this._lineFeed();
      return;
    }
    if (code === 0x0b || code === 0x0c) {                        // VT / FF
      this._wrapPending = false;
      this._lineFeed();
      return;
    }
    if (code === 0x0d) { this._wrapPending = false; this.col = 0; return; }   // CR
    if (code === 0x08) { this._wrapPending = false; if (this.col > 0) this.col--; return; }
    if (code === 0x09) { this._wrapPending = false; this._tabForward(1); return; }
    this._putGlyph(code & 0xff);
  };

  VGAText.prototype.write = function (text) {
    for (var i = 0; i < text.length; i++) this.putChar(text.charCodeAt(i));
  };

  VGAText.prototype._compose = function () {
    var px = this.px, ch = this.ch, cfg = this.cfg, cbg = this.cbg,
        cattr = this.cattr, data = LW.DATA;
    var row, col, r, base, bits, fgpx, bgpx;

    for (row = 0; row < ROWS; row++) {
      var cy = row * CH;
      for (col = 0; col < COLS; col++) {
        var idx = row * COLS + col;
        var code = ch[idx];
        fgpx = cfg[idx];
        bgpx = cbg[idx];
        var g = data.subarray(code * 16, code * 16 + 16);
        var cx = col * CW;
        for (r = 0; r < CH; r++) {
          bits = g[r];
          base = (cy + r) * W + cx;
          px[base + 0] = (bits & 0x80) ? fgpx : bgpx;
          px[base + 1] = (bits & 0x40) ? fgpx : bgpx;
          px[base + 2] = (bits & 0x20) ? fgpx : bgpx;
          px[base + 3] = (bits & 0x10) ? fgpx : bgpx;
          px[base + 4] = (bits & 0x08) ? fgpx : bgpx;
          px[base + 5] = (bits & 0x04) ? fgpx : bgpx;
          px[base + 6] = (bits & 0x02) ? fgpx : bgpx;
          px[base + 7] = (bits & 0x01) ? fgpx : bgpx;
        }
        var at = cattr[idx];
        if (at) {
          var q;
          if (at & ATTR_UNDERLINE) {
            base = (cy + CH - 1) * W + cx;
            for (q = 0; q < CW; q++) px[base + q] = fgpx;
          }
          if (at & ATTR_STRIKE) {
            base = (cy + (CH >> 1)) * W + cx;
            for (q = 0; q < CW; q++) px[base + q] = fgpx;
          }
        }
      }
    }

    if (this.cursorVisible && this.blinkOn && this.row < ROWS) {
      var ly = this.row * CH + CH - 2;
      var lx = this.col * CW;
      var c = BASE[DEF_FG];
      for (r = 0; r < 2; r++) {
        base = (ly + r) * W + lx;
        for (var i = 0; i < CW; i++) px[base + i] = c;
      }
    }
  };

  VGAText.prototype.render = function () {
    // With several virtual terminals sharing one canvas, only the foreground
    // one is allowed to paint (see vts.js).
    if (this.paintEnabled === false) return;
    this._compose();
    this.ctx.putImageData(this.img, 0, 0);
  };

  // Position the write cursor; used by the shell's line editor.
  VGAText.prototype.setCursor = function (col, row) {
    this.col = Math.max(0, Math.min(COLS - 1, col));
    this.row = Math.max(0, Math.min(ROWS - 1, row));
    this._wrapPending = false;
  };

  // Visible width of a string, ignoring ANSI SGR sequences.
  VGAText.prototype.visLen = function (s) {
    return s.replace(/\x1b\[[0-9;:]*m/g, "").length;
  };

  // Canonical name of a Ctrl+<char> combination: Ctrl+A -> "a", Ctrl+[ -> "[",
  // Ctrl+@ -> "@", Ctrl+? -> "?".  Browsers disagree about ev.key for control
  // chords, so keyCode is used as a fallback.
  var CTRL_BY_KEYCODE = {
    32: "@", 64: "@", 63: "?", 91: "[", 92: "\\", 93: "]", 94: "^", 95: "_",
  };
  LW.ctrlChar = function (ev) {
    if (ev.key && ev.key.length === 1 && /^[a-zA-Z@\[\]\\^_?]$/.test(ev.key)) {
      return ev.key.toLowerCase();
    }
    var c = ev.keyCode;
    if (c >= 65 && c <= 90) return String.fromCharCode(c + 32);
    return CTRL_BY_KEYCODE[c] || null;
  };

  VGAText.prototype.startBlink = function () {
    var self = this;
    if (this._blink) return;
    this._blink = setInterval(function () {
      self.blinkOn = !self.blinkOn;
      self.render();
    }, 530);
  };

  VGAText.prototype.stopBlink = function () {
    if (this._blink) {
      clearInterval(this._blink);
      this._blink = null;
    }
  };

  VGAText.prototype._stopTimer = function () {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  };

  // Write the whole log at once (no waiting).
  VGAText.prototype.printInstant = function (text) {
    this._stopTimer();
    this.clear();
    this.write(text);
    this.render();
  };

  // Replay the log line by line, waiting between lines in proportion to the
  // difference between their kernel timestamps.  opts:
  //   minDelay  - ms between ordinary lines (default 28)
  //   timeScale - ms per second of kernel time (default 1500)
  VGAText.prototype.playBoot = function (text, opts) {
    opts = opts || {};
    var minDelay = opts.minDelay == null ? 28 : opts.minDelay;
    var timeScale = opts.timeScale == null ? 1500 : opts.timeScale;
    var lines = text.split("\n");
    var self = this;

    this._stopTimer();
    this.clear();

    var i = 0;
    function step() {
      if (i >= lines.length) {
        self._timer = null;
        if (opts.onDone) opts.onDone();
        return;
      }
      var line = lines[i++];
      var t = parseTime(line);
      var wait = minDelay;
      if (t !== null && self._sawTime) {
        wait = Math.max(minDelay, (t - self._prevTime) * timeScale);
      }
      if (t !== null) {
        self._prevTime = t;
        self._sawTime = true;
      }
      self.write(line);
      self.write("\n");
      self.render();
      self._timer = setTimeout(step, wait);
    }
    step();
  };

  LW.defaultColors = function () { return [BASE[DEF_FG], BASE[DEF_BG]]; };

  LW.VGAText = VGAText;
  LW.TEXT_COLS = COLS;
  LW.TEXT_ROWS = ROWS;
})(window.LW);
