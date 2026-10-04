// VT escape-engine tests: cursor addressing, erase/edit, scroll margins,
// tab stops, alternate screen, private modes and DSR/DA replies.
const fs = require("fs"), vm = require("vm"), path = require("path");
const dir = path.join(__dirname, "..");

function Img(w, h) { this.data = new Uint8ClampedArray(w * h * 4); }
function makeTerm() {
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => new Img(w, h), putImageData() {} }) };
  return new ctx.window.LW.VGAText(canvas, { cursor: true, palette: "xterm" });
}

const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, atob, window: {} };
vm.createContext(ctx);
for (const f of ["src/font.data.js", "src/font.js", "src/renderer.js", "src/vt.js"]) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
}
const LW = ctx.window.LW;
const ESC = "\x1b";

let pass = 0, fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + "\n       got:  " + g + "\n       want: " + w); }
}
function row(t, r) {
  let s = "";
  for (let c = 0; c < t.cols; c++) s += String.fromCharCode(t.ch[r * t.cols + c]);
  return s.replace(/\s+$/, "");
}
function pos(t) { return [t.row, t.col]; }

console.log("--- cursor addressing ---");
let t = makeTerm();
t.write(ESC + "[2;3H");
check("CUP 2;3", pos(t), [1, 2]);
t.write("AB");
check("CUP then text", row(t, 1), "  AB");
t.write(ESC + "[5;5H" + ESC + "[2A");
check("CUU 2", pos(t), [2, 4]);
t.write(ESC + "[3B");
check("CUD 3", pos(t), [5, 4]);
t.write(ESC + "[10D");
check("CUB 10", pos(t), [5, 0]);
t.write(ESC + "[7C");
check("CUF 7", pos(t), [5, 7]);
t.write(ESC + "[20G");
check("CHA 20", pos(t), [5, 19]);
t.write(ESC + "[3d");
check("VPA 3", pos(t), [2, 19]);

console.log("--- control characters ---");
t = makeTerm();
t.write("ab\tcd");
check("tab stop at 8", [t.ch[0], t.ch[1] - 96, t.col], [0x61, 2, 10]);
t.write("\r\n");
check("CR/LF", pos(t), [1, 0]);
t.write("xy\bZ");
check("backspace overwrites", row(t, 1), "xZ");

console.log("--- erase ---");
t = makeTerm();
t.write("hello world" + ESC + "[1;3H" + ESC + "[K");
check("EL 0", row(t, 0), "he");
t = makeTerm();
t.write("hello" + ESC + "[1;3H" + ESC + "[1K");
check("EL 1", row(t, 0), "   lo");
t = makeTerm();
t.write("hello" + ESC + "[1;3H" + ESC + "[2K");
check("EL 2", row(t, 0), "");
t = makeTerm();
t.write("a".repeat(200) + ESC + "[2J");
check("ED 2", row(t, 0) + row(t, 5), "");

console.log("--- insert / delete ---");
t = makeTerm();
t.write("abc" + ESC + "[1;1H" + ESC + "[2@");
check("ICH 2", row(t, 0), "  abc");
t = makeTerm();
t.write("abcde" + ESC + "[1;1H" + ESC + "[2P");
check("DCH 2", row(t, 0), "cde");
t = makeTerm();
t.write("abcde" + ESC + "[1;2H" + ESC + "[2X");
check("ECH 2", row(t, 0), "a  de");
t = makeTerm();
t.write("one\r\ntwo\r\nthree" + ESC + "[1;1H" + ESC + "[L");
check("IL at top pushes down", [row(t, 0), row(t, 1), row(t, 2)], ["", "one", "two"]);
t = makeTerm();
t.write("one\r\ntwo\r\nthree" + ESC + "[1;1H" + ESC + "[M");
check("DL at top pulls up", [row(t, 0), row(t, 1), row(t, 2)], ["two", "three", ""]);

console.log("--- scroll margins ---");
t = makeTerm();
t.write("top" + ESC + "[20;1Hbottom");
t.write(ESC + "[2;3r");            // region = rows 2..3
t.write(ESC + "[3;1H" + "\n");     // LF at region bottom scrolls the region
check("region scrolled, outside intact", [row(t, 0), row(t, 2), row(t, 19)], ["top", "", "bottom"]);
t = makeTerm();
t.write("a\r\nb\r\nc");
t.write(ESC + "[1;3r" + ESC + "[3;1H" + "\n");
check("INITIAL region scrolls off 'a'", [row(t, 0), row(t, 1), row(t, 2)], ["b", "c", ""]);
t = makeTerm();
t.write(ESC + "[2;1H" + "x" + ESC + "[S");
check("SU scrolls up", [row(t, 0), row(t, 1)], ["x", ""]);
t = makeTerm();
t.write("y" + ESC + "[1;1H" + ESC + "[T");
check("SD scrolls down", [row(t, 0), row(t, 1)], ["", "y"]);

console.log("--- save / restore and the alt screen ---");
t = makeTerm();
t.write("abc" + ESC + "[1;1H" + ESC + "7" + ESC + "[5;5H" + ESC + "8");
check("DECSC/DECRC", pos(t), [0, 0]);
t = makeTerm();
t.write("main" + ESC + "[?1049h");
check("alt screen is blank", row(t, 0), "");
t.write("alt" + ESC + "[?1049l");
check("main screen restored", row(t, 0), "main");

console.log("--- private modes ---");
t = makeTerm();
t.write(ESC + "[?25l");
check("DECTCEM off", t.cursorVisible, false);
t.write(ESC + "[?25h");
check("DECTCEM on", t.cursorVisible, true);
t = makeTerm();
t.write(ESC + "[?7l");
t.write("a".repeat(90));
check("DECAWM off: no wrap", [row(t, 0).length, t.row], [80, 0]);
t = makeTerm();
t.write("z".repeat(80) + "Q");
check("DECAWM on: wraps on next glyph", [t.row, t.ch[t.cols]], [1, 0x51]);

console.log("--- tab stops ---");
t = makeTerm();
t.write(ESC + "[3g" + ESC + "[11G" + ESC + "H" + ESC + "[1G" + "\t");
check("HTS + tab", pos(t), [0, 10]);
t.write(ESC + "[g" + ESC + "[1G" + "\t");
check("TBC removes stop", pos(t), [0, 79]);

console.log("--- queries ---");
t = makeTerm();
let reply = null;
t.onResponse = (s) => { reply = s; };
t.write(ESC + "[4;7H" + ESC + "[6n");
check("DSR cursor position", reply, ESC + "[4;7R");
reply = null;
t.write(ESC + "[c");
check("DA1", reply, ESC + "[?6c");

console.log("--- ris ---");
t = makeTerm();
t.write("junk" + ESC + "[5;10r" + ESC + "c");
check("RIS clears", [row(t, 0), t.top, t.bot], ["", 0, t.rows - 1]);
check("RIS homes", pos(t), [0, 0]);

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
