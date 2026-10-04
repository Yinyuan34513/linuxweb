// Verifies the renderer parses ANSI SGR -- including 256-colour and truecolour
// -- into the per-cell colour buffers.
const fs = require("fs"), vm = require("vm"), path = require("path");
const dir = path.join(__dirname, "..");

const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, atob, window: {} };
vm.createContext(ctx);
for (const f of ["src/font.data.js", "src/font.js", "src/renderer.js", "src/vt.js"]) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
}
const LW = ctx.window.LW;

function Img(w, h) { this.data = new Uint8ClampedArray(w * h * 4); }
function makeTerm(palette) {
  const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (w, h) => new Img(w, h), putImageData() {} }) };
  return new LW.VGAText(canvas, { cursor: false, palette: palette || "xterm" });
}
const rgb = (p) => "rgb(" + (p & 255) + "," + ((p >> 8) & 255) + "," + ((p >> 16) & 255) + ")";

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + "\n       got:  " + got + "\n       want: " + want); }
}

// write `s`, then report the packed fg/bg of the cell right after the prompt
function cellAfter(term, s) {
  term.clear();
  term.write(s);
  const idx = term.row * term.cols + (term.col - 1);
  return { fg: term.cfg[idx], bg: term.cbg[idx], attr: term.cattr[idx] };
}

console.log("--- 16-colour ---");
let t = makeTerm();
check("\\e[31m -> xterm red", rgb(cellAfter(t, "\x1b[31mA").fg), "rgb(205,0,0)");
check("\\e[1;32m -> bright green", rgb(cellAfter(t, "\x1b[1;32mA").fg), "rgb(0,255,0)");
check("\\e[34m -> blue", rgb(cellAfter(t, "\x1b[34mA").fg), "rgb(0,0,238)");
check("\\e[41m -> red background", rgb(cellAfter(t, "\x1b[41mA").bg), "rgb(205,0,0)");
check("\\e[0m resets", rgb(cellAfter(t, "\x1b[31m\x1b[0mA").fg), "rgb(229,229,229)");

console.log("--- 256-colour (semicolon and colon forms) ---");
check("38;5;196 -> red", rgb(cellAfter(t, "\x1b[38;5;196mA").fg), "rgb(255,0,0)");
check("38;5;46  -> green", rgb(cellAfter(t, "\x1b[38;5;46mA").fg), "rgb(0,255,0)");
check("38:5:46  -> green", rgb(cellAfter(t, "\x1b[38:5:46mA").fg), "rgb(0,255,0)");
check("38;5;245 -> grey", rgb(cellAfter(t, "\x1b[38;5;245mA").fg), "rgb(138,138,138)");
check("38;5;21  -> blue", rgb(cellAfter(t, "\x1b[38;5;21mA").fg), "rgb(0,0,255)");
check("48;5;196 -> red bg", rgb(cellAfter(t, "\x1b[48;5;196mA").bg), "rgb(255,0,0)");
check("38;5;185 -> khaki3", rgb(cellAfter(t, "\x1b[38;5;185mA").fg), "rgb(215,215,95)");
check("combined 1;38;5;196", rgb(cellAfter(t, "\x1b[0;1;38;5;196mA").fg), "rgb(255,0,0)");
check("fg+bg together", rgb(cellAfter(t, "\x1b[38;5;196;48;5;21mA").bg), "rgb(0,0,255)");

console.log("--- truecolour ---");
check("38;2;255;128;0", rgb(cellAfter(t, "\x1b[38;2;255;128;0mA").fg), "rgb(255,128,0)");
check("38;2;0;255;0", rgb(cellAfter(t, "\x1b[38;2;0;255;0mA").fg), "rgb(0,255,0)");
check("38:2::1:2:3 (colourspace slot)", rgb(cellAfter(t, "\x1b[38:2::1:2:3mA").fg), "rgb(1,2,3)");
check("48;2;10;20;30 bg", rgb(cellAfter(t, "\x1b[48;2;10;20;30mA").bg), "rgb(10,20,30)");

console.log("--- attributes ---");
check("\\e[4m sets underline", cellAfter(t, "\x1b[4mA").attr & 1, 1);
check("\\e[24m clears underline", cellAfter(t, "\x1b[4m\x1b[24mA").attr & 1, 0);
check("\\e[9m sets strike", cellAfter(t, "\x1b[9mA").attr & 2, 2);
const rev = cellAfter(t, "\x1b[7;31;47mA");
check("\\e[7m swaps fg/bg", rgb(rev.fg) + "/" + rgb(rev.bg), "rgb(229,229,229)/rgb(205,0,0)");
const con = cellAfter(t, "\x1b[31;8mA");
check("\\e[8m conceal paints fg as bg", rgb(con.fg) + "/" + rgb(con.bg), "rgb(0,0,0)/rgb(0,0,0)");

console.log("--- vga palette ---");
const v = makeTerm("vga");
check("vga \\e[31m", rgb(cellAfter(v, "\x1b[31mA").fg), "rgb(170,0,0)");
check("vga \\e[1;32m", rgb(cellAfter(v, "\x1b[1;32mA").fg), "rgb(85,255,85)");
check("vga default fg", rgb(cellAfter(v, "A").fg), "rgb(170,170,170)");
check("256 still exact under vga", rgb(cellAfter(v, "\x1b[38;5;196mA").fg), "rgb(255,0,0)");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
