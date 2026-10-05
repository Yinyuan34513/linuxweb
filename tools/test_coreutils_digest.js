// The digests themselves, checked against node's crypto rather than against
// hand-written expectations.  The *wording* of every command is checked
// against the real binaries by tools/difftest.js; what matters here is that
// the arithmetic agrees byte for byte, at every length that matters for the
// padding rules (55/56/64 for the 64-byte block families, 111/112/128 for the
// 128-byte one) and for multi-block inputs.
//
//   node tools/test_coreutils_digest.js
const fs = require("fs"), vm = require("vm"), crypto = require("crypto");
const { loadShell } = require("./shell_harness.js");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log("  FAIL " + name + "\n       got  " + JSON.stringify(got) +
              "\n       want " + JSON.stringify(want));
}

// Ask the shell for a digest of a buffer.  The bytes go straight into the
// filesystem -- printf only expands escapes in its format, not in a %s
// argument, so routing them through a shell escape would test printf instead.
function withBytes(bytes, fn) {
  const { sh, LW } = loadShell();
  LW.VFS.writeFile("/tmp/bytes", bytesToString(bytes), false);
  return fn(sh);
}

function bytesToString(bs) {
  let out = "";
  for (const b of bs) out += String.fromCharCode(b);
  return out;
}

function digestVia(cmd, bytes) {
  return withBytes(bytes, function (sh) {
    sh.runLine(cmd + " /tmp/bytes", false);
    return sh.lastOut.trim();
  });
}

function bytesOf(n, seed) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(seed === undefined ? 97 + (i % 26) : (seed * (i + 1)) & 0xff);
  return out;
}

const ALGOS = ["md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum", "b2sum"];
const NODE_NAME = { md5sum: "md5", sha1sum: "sha1", sha224sum: "sha224", sha256sum: "sha256",
                    sha384sum: "sha384", sha512sum: "sha512", b2sum: "blake2b512" };

// The lengths that straddle every block boundary in the padding rules.
const LENGTHS = [0, 1, 3, 31, 32, 55, 56, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 200, 1000];

console.log("--- digests against node crypto ---");
for (const cmd of ALGOS) {
  let bad = 0;
  for (const len of LENGTHS) {
    const bs = bytesOf(len);
    const got = digestVia(cmd, bs).split(/\s+/)[0];
    const want = crypto.createHash(NODE_NAME[cmd]).update(Buffer.from(bs)).digest("hex");
    if (got !== want) { bad++; if (bad < 2) check(cmd + " at " + len + " bytes", got, want); }
  }
  if (!bad) { pass++; console.log("  ok   " + cmd + " matches node at all " + LENGTHS.length + " lengths"); }
  else fail++;
}

console.log("--- pseudo-random bytes, so a table bug cannot hide ---");
for (const cmd of ["sha256sum", "b2sum"]) {
  let bad = 0;
  for (const seed of [1, 7, 31, 251]) {
    const bs = bytesOf(333, seed);
    const got = digestVia(cmd, bs).split(/\s+/)[0];
    const want = crypto.createHash(NODE_NAME[cmd]).update(Buffer.from(bs)).digest("hex");
    if (got !== want) { bad++; check(cmd + " seed " + seed, got, want); }
  }
  if (!bad) { pass++; console.log("  ok   " + cmd + " matches node on 333-byte pseudo-random input"); }
  else fail++;
}

console.log("--- b2sum's -l selects the digest length ---");
// The length is part of BLAKE2b's parameter block, so a 256-bit digest is not
// a prefix of the 512-bit one.  The expected values are what the real b2sum
// prints for "abc" on this machine.
const B2_LENGTHS = {
  128: "cf4ab791c62b8d2b2109c90275287816",
  256: "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
  384: "6f56a82c8e7ef526dfe182eb5212f7db9df1317e57815dbda46083fc30f54ee6c66ba83be64b302d7cba6ce15bb556f4",
};
for (const bits of [128, 256, 384]) {
  const got = digestVia("b2sum -l " + bits, [97, 98, 99]).split(/\s+/)[0];
  check("b2sum -l " + bits, got, B2_LENGTHS[bits]);
}

console.log("--- cksum's own CRC (GNU's table, plus the length) ---");
// Recovered from GNU's cksum_crc.c: the table comes from GEN, and the file
// length is folded in before the final complement.
const GEN = 0x04000000 | 0x00800000 | 0x00400000 | 0x00010000 | 0x00001000 | 0x00000800 |
           0x00000400 | 0x00000100 | 0x00000080 | 0x00000020 | 0x00000010 | 0x00000004 |
           0x00000002 | 0x00000001;
const R = [GEN];
for (let i = 1; i < 8; i++) R.push((((R[i - 1] << 1) ^ ((R[i - 1] & 0x80000000) ? GEN : 0)) >>> 0));
const TABLE = [];
for (let n = 0; n < 256; n++) {
  let rem = 0;
  for (let b = 0; b < 8; b++) if (n & (1 << b)) rem = (rem ^ R[b]) >>> 0;
  TABLE.push(rem >>> 0);
}
function gnuCksumCrc(bs) {
  let crc = 0;
  for (const b of bs) crc = ((((crc << 8) >>> 0) ^ TABLE[((crc >> 24) ^ b) & 0xff]) >>> 0);
  let n = bs.length;
  while (n) {
    crc = ((((crc << 8) >>> 0) ^ TABLE[((crc >> 24) ^ (n & 0xff)) & 0xff]) >>> 0);
    n = Math.floor(n / 256);
  }
  return (~crc) >>> 0;
}
{
  let bad = 0;
  for (const len of [0, 1, 3, 55, 200, 1000]) {
    const bs = bytesOf(len);
    const got = parseInt(digestVia("cksum", bs).split(/\s+/)[0], 10);
    const want = gnuCksumCrc(bs);
    if (got !== want) { bad++; check("cksum crc at " + len + " bytes", got, want); }
  }
  if (!bad) { pass++; console.log("  ok   cksum matches GNU's CRC at every length tried"); }
  else fail++;
}

console.log("--- the 16-bit checksums ---");
// BSD: rotate the accumulator right one bit, then add.  System V: a running
// sum of the bytes with the carries folded back in.
function bsdSum(bs) {
  let s = 0;
  for (const b of bs) s = (((s >> 1) | ((s & 1) << 15)) + b) & 0xffff;
  return s;
}
function sysvSum(bs) {
  let s = 0;
  for (const b of bs) { s = (s + b) & 0xffff; s = (s >> 16) + (s & 0xffff); }
  return s & 0xffff;
}
{
  let bad = 0;
  for (const len of [0, 1, 3, 200, 1000]) {
    const bs = bytesOf(len);
    // one shell for both sums, so they read the same file
    const { sh, LW } = loadShell();
    LW.VFS.writeFile("/tmp/bytes", bytesToString(bs), false);
    sh.runLine("sum /tmp/bytes", false);
    const bsdLine = sh.lastOut.trim().split(/\s+/);
    if (parseInt(bsdLine[0], 10) !== bsdSum(bs)) { bad++; check("sum BSD at " + len, bsdLine[0], bsdSum(bs)); }
    if (parseInt(bsdLine[1], 10) !== Math.ceil(len / 1024)) { bad++; check("sum BSD blocks at " + len, bsdLine[1], Math.ceil(len / 1024)); }
    sh.runLine("sum -s /tmp/bytes", false);
    const sysvLine = sh.lastOut.trim().split(/\s+/);
    if (parseInt(sysvLine[0], 10) !== sysvSum(bs)) { bad++; check("sum -s at " + len, sysvLine[0], sysvSum(bs)); }
    if (parseInt(sysvLine[1], 10) !== Math.ceil(len / 512)) { bad++; check("sum -s blocks at " + len, sysvLine[1], Math.ceil(len / 512)); }
  }
  if (!bad) { pass++; console.log("  ok   sum's BSD and System V checksums agree at every length tried"); }
  else fail++;
}

console.log("--- base-N encoders ---");
{
  const cases = [
    ["base64", "YWJj"], ["base32", "MFRGG==="], ["basenc --base16", "616263"],
    ["basenc --base64url", "YWJj"], ["basenc --base2msbf", "011000010110001001100011"],
  ];
  for (const [cmd, want] of cases) {
    const { sh } = loadShell();
    sh.runLine("printf 'abc' | " + cmd, false);
    check(cmd, sh.lastOut.trim(), want);
  }
  // round trips
  for (const cmd of ["base64", "base32"]) {
    const { sh } = loadShell();
    sh.runLine("seq 1 40 | " + cmd + " | " + cmd + " -d | md5sum", false);
    const { sh: sh2 } = loadShell();
    sh2.runLine("seq 1 40 | md5sum", false);
    check(cmd + " round trip", sh.lastOut, sh2.lastOut);
  }
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);