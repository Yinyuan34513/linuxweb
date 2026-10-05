// The digest commands: md5sum, sha*sum, b2sum, cksum, sum and the base-N
// encoders.  Every expected value in here was captured from the real GNU
// coreutils binaries on this machine (LC_ALL=C) -- the point is that the
// JavaScript implementations agree with them, byte for byte.
const fs = require("fs"), vm = require("vm"), path = require("path");

function Term() { this.cols = 80; this.rows = 25; this.text = ""; }
Term.prototype.write = function (s) { this.text += s; };
Term.prototype.putChar = function (c) {};
Term.prototype.setCursor = function () {};
Term.prototype.render = function () {};
Term.prototype.clear = function () { this.text = ""; };

const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval,
              Date, atob, window: {} };
vm.createContext(ctx);
const dir = path.join(__dirname, "..");
for (const f of ["src/bash.data.js", "src/help.js", "src/vfs.js", "src/coreutils_help.js",
                 "src/bash.js", "src/coreutils_digest.js"]) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
}
const LW = ctx.window.LW;
LW.clock = () => "09:14:03";
LW.stampedLog = "";
LW.plainLog = "";

const term = new Term();
const sh = new LW.Shell(term);

let pass = 0, fail = 0;
function run(cmd) { sh.runLine(cmd, false); return sh.lastOut; }
function check(name, cmd, want) {
  let got;
  try { got = run(cmd); } catch (e) { got = "THREW: " + e.message; }
  const ok = typeof want === "function" ? want(got) : got === want;
  if (ok) { pass++; console.log("  ok   " + name); }
  else {
    fail++;
    console.log("  FAIL " + name + "\n       cmd: " + cmd +
                "\n       got:  " + JSON.stringify(got) +
                "\n      want:  " + JSON.stringify(want));
  }
}

// --- digests of "abc" and of the empty input, from the real tools -----------
const ABC = {
  md5sum: "900150983cd24fb0d6963f7d28e17f72",
  sha1sum: "a9993e364706816aba3e25717850c26c9cd0d89d",
  sha224sum: "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7",
  sha256sum: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  sha384sum: "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
  sha512sum: "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
  b2sum: "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
};
const EMPTY = {
  md5sum: "d41d8cd98f00b204e9800998ecf8427e",
  sha256sum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  b2sum: "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
};

// Byte lengths that straddle the 55/56 and 119/120 padding boundaries -- where
// a hash implementation goes wrong if the length is mis-encoded.
const PAD55 = "ef1772b6dff9a122358552954ad0df65";     // md5 of 55 'a'
const PAD56 = "3b0c8ac703f828b04c6c197006d17218";     // 56 'a'
const PAD64 = "014842d480b571495a4a0363793f7367";     // 64 'a'
const SHA119 = "31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb";
const SHA120 = "2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c";

console.log("--- digests (values from GNU coreutils) ---");
for (const cmd of Object.keys(ABC)) {
  check(cmd + " of 'abc'", "printf 'abc' | " + cmd, ABC[cmd] + "  -\n");
}
for (const cmd of Object.keys(EMPTY)) {
  check(cmd + " of empty input", "printf '' | " + cmd, EMPTY[cmd] + "  -\n");
}
check("md5 of 55 bytes", `printf 'a%.0s' $(seq 1 55) | md5sum`, PAD55 + "  -\n");
check("md5 of 56 bytes", `printf 'a%.0s' $(seq 1 56) | md5sum`, PAD56 + "  -\n");
check("md5 of 64 bytes", `printf 'a%.0s' $(seq 1 64) | md5sum`, PAD64 + "  -\n");
check("sha256 of 119 bytes", `printf 'a%.0s' $(seq 1 119) | sha256sum`, SHA119 + "  -\n");
check("sha256 of 120 bytes", `printf 'a%.0s' $(seq 1 120) | sha256sum`, SHA120 + "  -\n");

console.log("--- a file operand and the two-space separator ---");
check("md5sum names the file", "printf 'abc' > /tmp/d; md5sum /tmp/d", ABC.md5sum + "  /tmp/d\n");
check("multiple operands", "printf 'abc' > /tmp/d; md5sum /tmp/d /tmp/d",
      ABC.md5sum + "  /tmp/d\n" + ABC.md5sum + "  /tmp/d\n");
check("--tag is the default", "printf 'abc' > /tmp/d; md5sum --tag /tmp/d", ABC.md5sum + "  /tmp/d\n");
check("--untagged uses one space", "printf 'abc' > /tmp/d; md5sum --untagged /tmp/d", ABC.md5sum + " /tmp/d\n");
check("missing file -> stderr", "md5sum /nope 2>&1", "md5sum: /nope: No such file or directory\n");
check("missing file status", "md5sum /nope >/dev/null 2>&1; echo $?", "1\n");

console.log("--- -c: verifying a list ---");
check("OK", "printf 'abc' > /tmp/d; md5sum /tmp/d > /tmp/s; md5sum -c /tmp/s", "/tmp/d: OK\n");
check("FAILED", "printf 'zzz' > /tmp/e; md5sum /tmp/e | sed s/./f/ > /tmp/s2; md5sum -c /tmp/s2",
      "/tmp/e: FAILED\n");
check("-c status is 1 on failure", "printf 'zzz' > /tmp/e; md5sum /tmp/e | sed s/./f/ > /tmp/s2; md5sum -c /tmp/s2 >/dev/null 2>&1; echo $?", "1\n");
check("-c on a missing file", "printf '%s  /nope\n' 900150983cd24fb0d6963f7d28e17f72 > /tmp/s3; md5sum -c /tmp/s3 2>&1",
      "md5sum: /nope: No such file or directory\n");

console.log("--- cksum and sum (formats captured from the real tools) ---");
check("cksum of 'abc'", "printf 'abc' | cksum", "1219131554 3\n");
check("cksum of empty", "printf '' | cksum", "4294967295 0\n");
check("cksum names the file", "printf 'abc' > /tmp/d; cksum /tmp/d", "1219131554 3 /tmp/d\n");
check("cksum two operands", "printf 'abc' > /tmp/d; printf 'xyz' > /tmp/e; cksum /tmp/d /tmp/e",
      "1219131554 3 /tmp/d\n3273594848 3 /tmp/e\n");
check("cksum --algorithm=bsd", "printf 'abc' | cksum -a bsd", "16556     1\n");
check("cksum --algorithm=sysv", "printf 'abc' | cksum -a sysv", "294 1\n");
check("cksum -a md5 uses the labelled form", "printf 'abc' | cksum -a md5",
      "MD5 (-) = 900150983cd24fb0d6963f7d28e17f72\n");
check("cksum -a sha256 names the file", "printf 'abc' > /tmp/d; cksum -a sha256 /tmp/d",
      "SHA256 (/tmp/d) = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n");
check("cksum bad algorithm", "printf 'abc' | cksum -a nope 2>&1", (o) =>
      o.indexOf("cksum: invalid argument 'nope' for '--algorithm'\nValid arguments are:\n  - 'bsd'\n") === 0 &&
      /Try 'cksum --help' for more information\.\n$/.test(o));
check("sum default is BSD, 1K blocks", "printf 'abc' | sum", "16556     1\n");
check("sum -r is the default", "printf 'abc' | sum -r", "16556     1\n");
check("sum -s is System V, 512B blocks", "printf 'abc' | sum -s", "294 1\n");
check("sum of empty", "printf '' | sum", "00000     0\n");
check("sum names the file", "printf 'abc' > /tmp/d; sum /tmp/d", "16556     1 /tmp/d\n");
check("sum has no -z", "sum -z /tmp/d 2>&1", (o) => o.indexOf("sum: invalid option -- 'z'\n") === 0);

console.log("--- base64 / base32 ---");
check("base64 of 'abc'", "printf 'abc' | base64", "YWJj\n");
check("base64 round trip", "printf 'abc' | base64 | base64 -d", "abc");
check("base64 wraps at 76", "seq 1 100 | base64 | wc -l | tr -d ' '", "6\n");
check("base64 -w0 does not wrap", "seq 1 100 | base64 -w0 | wc -l | tr -d ' '", "0\n");
check("base64 -w3 wraps short", "printf 'abc' | base64 -w 3 | tr '\\n' ','", "YWJj");
check("base64 -w0 drops the newline", "printf 'abc' | base64 -w0 | wc -c", "4");
check("base64 of empty", "printf '' | base64", "\n");
check("base32 of 'abc'", "printf 'abc' | base32", "MFRGG===\n");
check("base32 round trip", "printf 'abc' | base32 | base32 -d", "abc");
check("basenc --base16", "printf 'abc' | basenc --base16", "616263\n");
check("basenc --base64url escapes + and /", "printf '\\xfb\\xff' | basenc --base64url", "-_8=\n");
check("basenc --base2msbf", "printf 'A' | basenc --base2msbf", "01000001\n");
check("basenc --base2lsbf", "printf 'A' | basenc --base2lsbf", "10000010\n");
check("base64 bad input -> stderr", "printf '!' | base64 -d 2>&1", "base64: invalid input\n");

console.log("--- --help / --version come from the capture ---");
check("md5sum --help is the real text", "md5sum --help", (o) => o.indexOf("Usage: md5sum [OPTION]... [FILE]...") === 0);
check("cksum --version first line", "cksum --version", (o) => o.indexOf("cksum (GNU coreutils)") === 0);
check("b2sum --help lists -l", "b2sum --help", (o) => o.indexOf("-l, --length=BITS") > 0);
check("invalid option", "md5sum -Z 2>&1", "md5sum: invalid option -- 'Z'\nTry 'md5sum --help' for more information.\n");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);