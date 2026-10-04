// Linux VGA 8x16 font, decoded from the base64 payload emitted by
// tools/extract_font.py.  Layout: 256 glyphs x 16 rows, one byte per row,
// MSB = leftmost pixel.  Only codes 0..255 (CP437) are addressable.
(function (LW) {
  "use strict";

  LW = LW || (window.LW = window.LW || {});

  var raw = atob(LW.FONT_B64);
  var DATA = new Uint8Array(4096);
  for (var i = 0; i < DATA.length; i++) DATA[i] = raw.charCodeAt(i) & 0xff;

  LW.DATA = DATA;
  LW.GLYPH_W = 8;
  LW.GLYPH_H = 16;

  // glyph(code) -> Uint8Array(16) view; code is masked to a byte.
  LW.glyph = function (code) {
    var c = code & 0xff;
    return DATA.subarray(c * 16, c * 16 + 16);
  };
})(window.LW);
