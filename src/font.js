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

  // The light box-drawing characters, which live in the font at the CP437
  // codes.  A text console has 256 glyphs and nothing else to draw them
  // with, so when a UTF-8 program writes them -- `pstree -U` draws its tree
  // with them -- the screen looks up the code it already has a glyph for,
  // which is also what the Linux VT does.  Anything not listed keeps the
  // old behaviour: the low byte of the code.
  var BOX = {
    0x2500: 0xc4,   // ─ light horizontal
    0x2502: 0xb3,   // │ light vertical
    0x250c: 0xda,   // ┌
    0x2510: 0xbf,   // ┐
    0x2514: 0xc0,   // └
    0x2518: 0xd9,   // ┘
    0x251c: 0xc3,   // ├
    0x2524: 0xb4,   // ┤
    0x252c: 0xc2,   // ┬
    0x2534: 0xc1,   // ┴
    0x253c: 0xc5,   // ┼
  };

  LW.cp437 = function (code) {
    return BOX[code] === undefined ? code : BOX[code];
  };
})(window.LW);
