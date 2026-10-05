// `file`, checksum and encoding commands: the ones that look at a file's
// bytes rather than its name.
//
// base32, base64, basenc, cksum, md5sum, sha1sum, sha224sum, sha256sum,
// sha384sum, sha512sum, b2sum, sum.
//
// The digests are the real algorithms over the same byte-oriented strings the
// shell stores (a character below 0x100 is one byte), and every one of them is
// checked against the system's binary in tools/test_coreutils_digest.js.
// --help / --version print the text captured from the real tools.
//
// Requires: vfs.js, bash.js (LW.core).
(function (LW) {
  "use strict";

  var V = LW.VFS;
  var def = LW.core.defCmd;
  var getopt = LW.core.getopt, finish = LW.core.finish;
  var eachInput = LW.core.eachInput, gnuErr = LW.core.gnuErr;

  // Read each operand (or stdin) and hand it to fn(text, name); name is null
  // for standard input.  Same shape as the one in coreutils_text.js -- the
  // helpers are per-file on purpose so each file stands alone.
  function inputs(prog, args, stdin, sh, errFmt, fn) {
    return eachInput(prog, args, stdin, sh, errFmt || gnuErr, fn);
  }

  // ---------------------------------------------------------------- bytes --

  // The shell keeps file contents as strings, one character per byte for the
  // byte range the VT can draw.  Everything here works on that representation.
  function bytes(text) {
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x100) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }

  function fromBytes(bs) {
    var out = "";
    for (var i = 0; i < bs.length; i++) out += String.fromCharCode(bs[i]);
    return out;
  }

  // A file name is printed with a leading \ when it contains a newline or a
  // backslash, exactly as the real tools escape it.
  function escaped(name) {
    return /[\\\n]/.test(name) ? "\\" + name : name;
  }

  // ---------------------------------------------------------------- hex/32 --

  function hex(bs) {
    var s = "";
    for (var i = 0; i < bs.length; i++) s += (bs[i] < 16 ? "0" : "") + bs[i].toString(16);
    return s;
  }

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  var B32HEX = "0123456789ABCDEFGHIJKLMNOPQRSTUV";

  // base64 encode; -w COLS wraps (0 disables), default 76 like coreutils.
  function b64encode(bs) {
    var out = "";
    for (var i = 0; i < bs.length; i += 3) {
      var b0 = bs[i], b1 = bs[i + 1], b2 = bs[i + 2];
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      out += b2 === undefined ? "=" : B64[b2 & 63];
    }
    return out;
  }

  function b64decode(s) {
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === "=") break;
      var v = B64.indexOf(ch);
      if (v < 0) {
        if (ch === "\n" || ch === "\r" || ch === " " || ch === "\t") continue;
        throw new Error("invalid input");
      }
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 0xff);
      }
    }
    return out;
  }

  // Five bytes in, eight characters out.  The accumulator is kept with
  // multiplication rather than `<<` -- five bytes is 40 bits, which does not
  // survive JavaScript's 32-bit shift operator.  A trailing partial group is
  // left-aligned in its five bits, which is what makes "abc" -> "MFRGG===".
  function b32encode(bs, alpha) {
    var out = "";
    for (var i = 0; i < bs.length; i += 5) {
      var chunk = bs.slice(i, i + 5);
      var acc = 0, bits = 0;
      for (var j = 0; j < chunk.length; j++) { acc = acc * 256 + chunk[j]; bits += 8; }
      var full = Math.floor(bits / 5), rest = bits % 5;
      for (var k = 0; k < 8; k++) {
        if (k < full) {
          out += alpha[Math.floor(acc / Math.pow(2, bits - 5 * (k + 1))) % 32];
        } else if (k === full && rest) {
          out += alpha[(acc % Math.pow(2, rest)) * Math.pow(2, 5 - rest)];
        } else out += "=";
      }
    }
    return out;
  }

  function b32decode(s, alpha) {
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i).toUpperCase();
      if (ch === "=") break;
      var v = alpha.indexOf(ch);
      if (v < 0) {
        if (ch === "\n" || ch === "\r" || ch === " " || ch === "\t") continue;
        throw new Error("invalid input");
      }
      buf = (buf << 5) | v;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 0xff);
      }
    }
    return out;
  }

  // ------------------------------------------------------------- digests ----

  // CRC-32 (IEEE), what cksum uses.
  var CRC_TABLE = (function () {
    var table = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bs, seed) {
    var c = (seed === undefined ? 0 : seed) ^ 0xffffffff;
    for (var i = 0; i < bs.length; i++) c = CRC_TABLE[(c ^ bs[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // System V's sum(1) checksum: add each byte and fold the carry back into the
  // low 16 bits, so the result is the byte sum modulo 65536 with the carries
  // counted in.  `printf abc | cksum -a sysv` -> 294 (97+98+99), and 3000 'a'
  // bytes -> 28860 rather than 28856 because of the four folded carries.
  function sysvSum(bs, seed) {
    var s = seed === undefined ? 0 : seed;
    for (var i = 0; i < bs.length; i++) {
      s = (s + bs[i]) & 0xffff;
      s = (s >> 16) + (s & 0xffff);
    }
    return s & 0xffff;
  }

  // ---------------------------------------------------------------- md5 -----

  function md5(bs) {
    var s = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    var K = [];
    for (var i = 0; i < 64; i++) {
      K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
    }
    var msg = bs.slice();
    var bitLen = bs.length * 8;
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    for (var b = 0; b < 8; b++) msg.push((bitLen / Math.pow(2, b * 8)) & 0xff);

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    function rotl(x, c) { return ((x << c) | (x >>> (32 - c))) >>> 0; }

    for (var chunk = 0; chunk < msg.length; chunk += 64) {
      var M = [];
      for (var w = 0; w < 16; w++) {
        M[w] = msg[chunk + w * 4] | (msg[chunk + w * 4 + 1] << 8) |
               (msg[chunk + w * 4 + 2] << 16) | (msg[chunk + w * 4 + 3] << 24);
      }
      var A = a0, B = b0, C = c0, D = d0;
      for (var i2 = 0; i2 < 64; i2++) {
        var F, g;
        if (i2 < 16) { F = (B & C) | (~B & D); g = i2; }
        else if (i2 < 32) { F = (D & B) | (~D & C); g = (5 * i2 + 1) % 16; }
        else if (i2 < 48) { F = B ^ C ^ D; g = (3 * i2 + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i2) % 16; }
        F = (F + A + K[i2] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, s[i2])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    return leWords([a0, b0, c0, d0]);
  }

  function leWords(words) {
    var out = [];
    words.forEach(function (w) {
      out.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff);
    });
    return out;
  }

  // ------------------------------------------------------- sha1 / sha2 -----
  //
  // All five are the same shape: pad, expand the message schedule, then 64
  // (SHA-1/256) or 80 (SHA-512) rounds over an eight-word state.  The
  // arithmetic is written in BigInt on purpose: with Number, `x >>> n` is
  // unsigned but `x & 0xffffffff` is *signed*, so any word above 2^31 turns
  // negative and every later shift quietly changes meaning.
  //
  // The constants are the fractional parts of the cube roots of the first
  // 64 / 80 primes (FIPS 180-4 4.2.2), and SHA-224 / SHA-384 have their own
  // initial state, not a truncation of SHA-256 / SHA-512.
  var MASK32 = 0xffffffffn;
  var MASK64 = (1n << 64n) - 1n;

  var K256 = [
    0x428a2f98n, 0x71374491n, 0xb5c0fbcfn, 0xe9b5dba5n, 0x3956c25bn,
    0x59f111f1n, 0x923f82a4n, 0xab1c5ed5n, 0xd807aa98n, 0x12835b01n,
    0x243185ben, 0x550c7dc3n, 0x72be5d74n, 0x80deb1fen, 0x9bdc06a7n,
    0xc19bf174n, 0xe49b69c1n, 0xefbe4786n, 0x0fc19dc6n, 0x240ca1ccn,
    0x2de92c6fn, 0x4a7484aan, 0x5cb0a9dcn, 0x76f988dan, 0x983e5152n,
    0xa831c66dn, 0xb00327c8n, 0xbf597fc7n, 0xc6e00bf3n, 0xd5a79147n,
    0x06ca6351n, 0x14292967n, 0x27b70a85n, 0x2e1b2138n, 0x4d2c6dfcn,
    0x53380d13n, 0x650a7354n, 0x766a0abbn, 0x81c2c92en, 0x92722c85n,
    0xa2bfe8a1n, 0xa81a664bn, 0xc24b8b70n, 0xc76c51a3n, 0xd192e819n,
    0xd6990624n, 0xf40e3585n, 0x106aa070n, 0x19a4c116n, 0x1e376c08n,
    0x2748774cn, 0x34b0bcb5n, 0x391c0cb3n, 0x4ed8aa4an, 0x5b9cca4fn,
    0x682e6ff3n, 0x748f82een, 0x78a5636fn, 0x84c87814n, 0x8cc70208n,
    0x90befffan, 0xa4506cebn, 0xbef9a3f7n, 0xc67178f2n];
  var K512 = [
    0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
    0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
    0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
    0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
    0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
    0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
    0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
    0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
    0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
    0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
    0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
    0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
    0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
    0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
    0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
    0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
    0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
    0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
    0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
    0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n];

  var IV256 = [0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an,
               0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n];
  var IV224 = [0xc1059ed8n, 0x367cd507n, 0x3070dd17n, 0xf70e5939n,
               0xffc00b31n, 0x68581511n, 0x64f98fa7n, 0xbefa4fa4n];
  var IV512 = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn,
               0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn,
               0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
  var IV384 = [0xcbbb9d5dc1059ed8n, 0x629a292a367cd507n, 0x9159015a3070dd17n,
               0x152fecd8f70e5939n, 0x67332667ffc00b31n, 0x8eb44a8768581511n,
               0xdb0c2e0d64f98fa7n, 0x47b5481dbefa4fa4n];

  // Rotations are over the variant's own word: 32 bits for SHA-1/256,
  // 64 for SHA-512.
  function rot(x, n, bits) {
    var mask = bits === 32 ? MASK32 : MASK64;
    return ((x << n) | (x >> (BigInt(bits) - n))) & mask;
  }
  function rotr(x, n, bits) {
    var mask = bits === 32 ? MASK32 : MASK64;
    return ((x >> n) | (x << (BigInt(bits) - n))) & mask;
  }

  // 0x80, zero padding, then the message length **in bits**, big-endian.
  // SHA-512's length field is 16 bytes: pad to 112, eight zero bytes for the
  // high word (anything under 2^32 bits), then the low eight.
  function padMessage(bs, block) {
    var msg = bs.slice();
    var bits = bs.length * 8;
    msg.push(0x80);
    while (msg.length % block !== (block === 128 ? 112 : 56)) msg.push(0);
    if (block === 128) for (var z = 0; z < 8; z++) msg.push(0);
    for (var i = 7; i >= 0; i--) msg.push(Math.floor(bits / Math.pow(2, i * 8)) & 0xff);
    return msg;
  }

  function beWord(bs, off) {
    return BigInt((bs[off] << 24) | (bs[off + 1] << 16) | (bs[off + 2] << 8) | bs[off + 3]) & MASK32;
  }
  function beWord64(bs, off) {
    return ((beWord(bs, off) << 32n) | beWord(bs, off + 4)) & MASK64;
  }

  function wordsToBytes(ws, bits) {
    var out = [], per = bits / 8;
    ws.forEach(function (w) {
      for (var s = per - 1; s >= 0; s--) {
        out.push(Number((w >> BigInt(s * 8)) & 0xffn));
      }
    });
    return out;
  }

  // BLAKE2 is the odd one out: its state is written out little-endian, so it
  // cannot use wordsToBytes() even though the arithmetic is the same.
  function wordsToBytesLE(ws) {
    var out = [];
    ws.forEach(function (w) {
      for (var s = 0; s < 8; s++) out.push(Number((w >> BigInt(s * 8)) & 0xffn));
    });
    return out;
  }

  function sha1(bs) {
    var H = [0x67452301n, 0xefcdab89n, 0x98badcfen, 0x10325476n, 0xc3d2e1f0n];
    var K = [0x5a827999n, 0x6ed9eba1n, 0x8f1bbcdcn, 0xca62c1d6n];
    var msg = padMessage(bs, 64);
    var W = new Array(80);
    for (var chunk = 0; chunk < msg.length; chunk += 64) {
      for (var i = 0; i < 16; i++) W[i] = beWord(msg, chunk + i * 4);
      for (var j = 16; j < 80; j++) {
        W[j] = rot(W[j - 3] ^ W[j - 8] ^ W[j - 14] ^ W[j - 16], 1n, 32);
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4];
      for (var k = 0; k < 80; k++) {
        var f, t;
        if (k < 20) { f = (b & c) | (~b & MASK32 & d); t = K[0]; }
        else if (k < 40) { f = b ^ c ^ d; t = K[1]; }
        else if (k < 60) { f = (b & c) | (b & d) | (c & d); t = K[2]; }
        else { f = b ^ c ^ d; t = K[3]; }
        var tmp = (rot(a, 5n, 32) + (f & MASK32) + e + t + W[k]) & MASK32;
        e = d; d = c; c = rot(b, 30n, 32); b = a; a = tmp;
      }
      H[0] = (H[0] + a) & MASK32; H[1] = (H[1] + b) & MASK32; H[2] = (H[2] + c) & MASK32;
      H[3] = (H[3] + d) & MASK32; H[4] = (H[4] + e) & MASK32;
    }
    return wordsToBytes(H, 32);
  }

  function sha256(bs) { return wordsToBytes(sha2(bs, 32, IV256), 32); }
  function sha224(bs) { return wordsToBytes(sha2(bs, 32, IV224).slice(0, 7), 32); }
  function sha512(bs) { return wordsToBytes(sha2(bs, 64, IV512), 64); }
  function sha384(bs) { return wordsToBytes(sha2(bs, 64, IV384).slice(0, 6), 64); }

  function sha2(bs, bits, iv) {
    var is64 = bits === 64;
    var mask = is64 ? MASK64 : MASK32;
    var rounds = is64 ? 80 : 64;
    var block = is64 ? 128 : 64;
    var K = is64 ? K512 : K256;
    var H = iv.slice();
    var msg = padMessage(bs, block);
    var W = new Array(rounds);

    for (var chunk = 0; chunk < msg.length; chunk += block) {
      for (var i = 0; i < 16; i++) {
        W[i] = is64 ? beWord64(msg, chunk + i * 8) : beWord(msg, chunk + i * 4);
      }
      for (var j = 16; j < rounds; j++) {
        var s0 = is64
          ? (rotr(W[j - 15], 1n, 64) ^ rotr(W[j - 15], 8n, 64) ^ (W[j - 15] >> 7n))
          : (rotr(W[j - 15], 7n, 32) ^ rotr(W[j - 15], 18n, 32) ^ (W[j - 15] >> 3n));
        var s1 = is64
          ? (rotr(W[j - 2], 19n, 64) ^ rotr(W[j - 2], 61n, 64) ^ (W[j - 2] >> 6n))
          : (rotr(W[j - 2], 17n, 32) ^ rotr(W[j - 2], 19n, 32) ^ (W[j - 2] >> 10n));
        W[j] = (W[j - 16] + s0 + W[j - 7] + s1) & mask;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3];
      var e = H[4], f = H[5], g = H[6], h = H[7];
      for (var r = 0; r < rounds; r++) {
        var S1 = is64
          ? (rotr(e, 14n, 64) ^ rotr(e, 18n, 64) ^ rotr(e, 41n, 64))
          : (rotr(e, 6n, 32) ^ rotr(e, 11n, 32) ^ rotr(e, 25n, 32));
        var ch = (e & f) ^ (~e & mask & g);
        var t1 = (h + S1 + ch + K[r] + W[r]) & mask;
        var S0 = is64
          ? (rotr(a, 28n, 64) ^ rotr(a, 34n, 64) ^ rotr(a, 39n, 64))
          : (rotr(a, 2n, 32) ^ rotr(a, 13n, 32) ^ rotr(a, 22n, 32));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) & mask;
        h = g; g = f; f = e; e = (d + t1) & mask;
        d = c; c = b; b = a; a = (t1 + t2) & mask;
      }
      H[0] = (H[0] + a) & mask; H[1] = (H[1] + b) & mask;
      H[2] = (H[2] + c) & mask; H[3] = (H[3] + d) & mask;
      H[4] = (H[4] + e) & mask; H[5] = (H[5] + f) & mask;
      H[6] = (H[6] + g) & mask; H[7] = (H[7] + h) & mask;
    }
    return H;
  }

// ------------------------------------------------------------- b2sum ------
  //
  // BLAKE2b, parameterised by digest length, which is what -l is for.
  var BLAKE2B_IV = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn,
    0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn,
    0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
  var BLAKE2B_SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3]];

  function blake2b(bs, outlen) {
    // h[0] ^= 0x01010000 ^ (keylen << 8) ^ digest_length; no key here, so the
    // fanout/depth/incremental words are 0 and the key length is 0.
    // h[0] ^= 0x01010000 ^ (keylen << 8) ^ digest_length, and the length
    // field counts *bytes* while outlen is in bits -- 512 bits is 0x40.
    var h = BLAKE2B_IV.slice();
    h[0] ^= 0x01010000n | BigInt(outlen / 8);
    // Even an empty message is compressed once -- as a block of zeroes with the
    // last-block flag set -- so b2sum of nothing is not sha512sum of nothing.
    var blocks = Math.max(1, Math.ceil(bs.length / 128));
    var t = 0n;
    for (var b = 0; b < blocks; b++) {
      var block = bs.slice(b * 128, b * 128 + 128);
      t += BigInt(block.length);             // t counts every byte so far
      while (block.length < 128) block.push(0);
      var m = [];
      for (var i = 0; i < 16; i++) {
        var w = 0n;
        for (var k = 0; k < 8; k++) w |= BigInt(block[i * 8 + k]) << BigInt(8 * k);
        m.push(w);
      }
      compress(h, m, t, b === blocks - 1);
    }
    // only as many whole words as the requested digest needs
    return wordsToBytesLE(h.slice(0, Math.ceil(outlen / 64))).slice(0, outlen);

    function compress(h, m, t, isLast) {
      var v = h.concat(BLAKE2B_IV.slice());
      v[12] ^= t;                               // t low word (t < 2^64 here)
      if (isLast) v[14] ^= MASK64;              // last-block flag
      for (var r = 0; r < 12; r++) {
        var s = BLAKE2B_SIGMA[r];
        G(0, 4, 8, 12, m[s[0]], m[s[1]]);
        G(1, 5, 9, 13, m[s[2]], m[s[3]]);
        G(2, 6, 10, 14, m[s[4]], m[s[5]]);
        G(3, 7, 11, 15, m[s[6]], m[s[7]]);
        G(0, 5, 10, 15, m[s[8]], m[s[9]]);
        G(1, 6, 11, 12, m[s[10]], m[s[11]]);
        G(2, 7, 8, 13, m[s[12]], m[s[13]]);
        G(3, 4, 9, 14, m[s[14]], m[s[15]]);
      }
      for (var i = 0; i < 8; i++) h[i] = h[i] ^ v[i] ^ v[i + 8];

      function G(a, b, c, d, x, y) {
        v[a] = (v[a] + v[b] + x) & MASK64;
        v[d] = rotr(v[d] ^ v[a], 32n, 64);
        v[c] = (v[c] + v[d]) & MASK64;
        v[b] = rotr(v[b] ^ v[c], 24n, 64);
        v[a] = (v[a] + v[b] + y) & MASK64;
        v[d] = rotr(v[d] ^ v[a], 16n, 64);
        v[c] = (v[c] + v[d]) & MASK64;
        v[b] = rotr(v[b] ^ v[c], 63n, 64);
      }
    }
  }

  // ------------------------------------------------------------- commands ---

  // Every digest command is the same program with a different algorithm:
  //   md5sum FILE...   ->  "d41d8c...  FILE"
  //   md5sum           ->  reads stdin, prints the bare digest
  //   md5sum -c        ->  reads a checksum list and verifies it
  //   --tag/--untagged, -z for NUL, --zero for no filename
  function digestCmd(name, fn, outlen) {
    def(name, function (args, stdin, sh) {
      var g = getopt(name, args, {
        short: { b: "bool", c: "bool", t: "bool", w: "arg", z: "bool",
                 l: "arg", "0": "bool" },
        long: { binary: "bool", check: ["bool", "c"], tag: "bool", untagged: "bool",
                status: "bool", strict: "bool", warn: ["bool", "w"],
                zero: ["bool", "z"], length: ["arg", "l"],
                "ignore-missing": "bool", quiet: "bool", text: "bool" },
      });
      var done = finish(sh, name, g);
      if (done) return done;
      var o = g.o;

      if (o.c) return checkMode(name, g._, stdin, sh);

      var out = "", code = 0;
      var tagged = o.untagged ? false : true;
      if (!g._.length) {
        out = hex(fn(bytes(stdin))) + "\n";
        return { out: out, code: 0 };
      }
      code = inputs(name, g._, stdin, sh, gnuErr, function (text, fname) {
        var sum = hex(fn(bytes(text)));
        // standard input is reported as "-", like every coreutils checksum tool
        if (o.z) {
          out += sum + " *" + escaped(fname === null ? "-" : fname) + "\0";
        } else if (tagged) {
          out += sum + "  " + escaped(fname === null ? "-" : fname) + "\n";
        } else {
          out += sum + " " + escaped(fname === null ? "-" : fname) + "\n";
        }
      });
      return { out: out, code: code };
    }, name + " - print and check checksums");

    // -c reads lines of "digest  name" and reports each one.
    function checkMode(prog, args, stdin, sh) {
      var text = "", code = 0;
      code = inputs(prog, args, stdin, sh, gnuErr, function (t) { text += t; });
      var out = "", failed = 0, missing = 0;
      text.split("\n").forEach(function (line) {
        if (line === "") return;
        var m = /^(\S+)\s+[* ]?(.*)$/.exec(line);
        if (!m) {
          sh._error(prog + ": " + line + ": no properly formatted checksum lines found");
          failed++;
          return;
        }
        var want = m[1], fname = m[2];
        var data = V.readFile(sh.path(fname));
        if (data === null) {
          missing++;
          failed++;
          out += prog + ": " + fname + ": No such file or directory\n";
          return;
        }
        var got = hex(fn(bytes(data)));
        if (got !== want.toLowerCase()) {
          failed++;
          out += prog + ": " + fname + ": FAILED\n";
          return;
        }
        out += fname + ": OK\n";
      });
      return { out: out, code: failed ? 1 : 0 };
    }
  }

  digestCmd("md5sum", md5);
  digestCmd("sha1sum", sha1);
  digestCmd("sha224sum", sha224);
  digestCmd("sha256sum", sha256);
  digestCmd("sha384sum", sha384);
  digestCmd("sha512sum", sha512);
  digestCmd("b2sum", function (bs) { return blake2b(bs, 512); });

  // ---- cksum: CRC by default, but --algorithm picks any of the family ------
  //
  // Three different layouts, all taken from the real tool:
  //   crc    "%u %d"                  the classic CRC and byte count
  //   bsd    "%05d %5d"               BSD checksum and 1 KB blocks
  //   sysv   "%d %d"                  System V checksum and 512 B blocks
  //   hashes "SHA256 (name) = digest" a labelled line, with (-) for stdin
  var CKSUM_ALGOS = [
    "bsd", "sysv", "crc", "md5", "sha1", "sha224", "sha256", "sha384",
    "sha512", "blake2b", "sm3"];
  var CKSUM_HASHES = {
    md5: ["MD5", md5], sha1: ["SHA1", sha1], sha224: ["SHA224", sha224],
    sha256: ["SHA256", sha256], sha384: ["SHA384", sha384],
    sha512: ["SHA512", sha512], blake2b: ["BLAKE2b", function (b) { return blake2b(b, 512); }],
  };

  def("cksum", function (args, stdin, sh) {
    var g = getopt("cksum", args, {
      short: { a: "arg", c: "bool", l: "arg", z: "bool", "0": "bool" },
      long: { algorithm: ["arg", "a"], check: ["bool", "c"], length: ["arg", "l"],
              raw: "bool", tag: "bool", untagged: "bool", zero: ["bool", "z"] },
    });
    var done = finish(sh, "cksum", g);
    if (done) return done;
    var algo = g.o.a === undefined ? "crc" : String(g.o.a);
    if (CKSUM_ALGOS.indexOf(algo) < 0) {
      sh._error("cksum: invalid argument '" + algo + "' for '--algorithm'");
      sh._error("Valid arguments are:");
      CKSUM_ALGOS.forEach(function (a) { sh._error("  - '" + a + "'"); });
      sh._error("Try 'cksum --help' for more information.");
      return { out: "", code: 1 };
    }
    if (algo === "sm3") {
      // not implemented; coreutils still accepts the name, so accept it here
      // and say so rather than pretending to have computed it
      sh._error("cksum: 'sm3' is not supported in this build");
      return { out: "", code: 1 };
    }
    var eol = g.o.z ? "\0" : "\n";
    var out = "", code = 0;
    code = inputs("cksum", g._, stdin, sh, gnuErr, function (text, name) {
      var bs = bytes(text), label = name === null ? "" : " " + escaped(name);
      if (CKSUM_HASHES[algo]) {
        out += CKSUM_HASHES[algo][0] + " (" + escaped(name === null ? "-" : name) + ") = " +
          hex(CKSUM_HASHES[algo][1](bs)) + eol;
        return;
      }
      if (algo === "crc") out += crc32(bs) + " " + bs.length + label + eol;
      else if (algo === "bsd") out += pad5(bsdSum(bs)) + " " + String(blocksOf(bs.length, 1024)).padStart(5) + label + eol;
      else out += sysvSum(bs) + " " + blocksOf(bs.length, 512) + label + eol;
    });
    return { out: out, code: code };
  }, "print and check checksums");

  // The BSD checksum: rotate the 16-bit accumulator right one bit, add the
  // byte.  Verified against `cksum -a bsd` for every input tested, including
  // 200 random bytes (43621).
  function bsdSum(bs) {
    var s = 0;
    for (var i = 0; i < bs.length; i++) {
      s = ((s >> 1) | ((s & 1) << 15)) + bs[i];
      s &= 0xffff;
    }
    return s;
  }

  // System V: a running sum of the bytes, folded back into 16 bits whenever it
  // carries.  `printf abc | cksum -a sysv` -> 294, and 3000 'a' bytes -> 28860.
  function blocksOf(n, size) { return Math.ceil(n / size); }
  function pad5(n) { return String(n).padStart(5, "0"); }

  // ---- sum: the BSD and System V 16-bit checksums --------------------------
  //
  // Per `sum --help`: "-r use BSD sum algorithm (the default), use 1K blocks"
  // and "-s, --sysv use System V sum algorithm, use 512 bytes blocks".  The BSD
  // form pads to five columns, the System V form does not.
  def("sum", function (args, stdin, sh) {
    var g = getopt("sum", args, {
      short: { r: "bool", s: "bool", b: "bool", t: "bool", "0": "bool" },
      long: { sysv: ["bool", "s"], bsd: ["bool", "r"], tag: "bool", untagged: "bool" },
    });
    var done = finish(sh, "sum", g);
    if (done) return done;
    var sysv = !!(g.o.s || g.o.sysv);              // -r and the default are BSD
    var out = "", code = 0;
    code = inputs("sum", g._, stdin, sh, gnuErr, function (text, name) {
      var bs = bytes(text);
      var label = name === null ? "" : " " + escaped(name);
      out += sysv
        ? sysvSum(bs) + " " + blocksOf(bs.length, 512) + label + "\n"
        : pad5(bsdSum(bs)) + " " + String(blocksOf(bs.length, 1024)).padStart(5) + label + "\n";
    });
    return { out: out, code: code };
  }, "checksum and block count for each input FILE");

  // ---- base64 --------------------------------------------------------------
  def("base64", function (args, stdin, sh) {
    var g = getopt("base64", args, {
      short: { d: "bool", i: "bool", w: "arg", "0": "bool" },
      long: { decode: ["bool", "d"], "ignore-garbage": ["bool", "i"], wrap: ["arg", "w"] },
    });
    var done = finish(sh, "base64", g);
    if (done) return done;
    var o = g.o, out = "", code = 0;
    code = inputs("base64", g._, stdin, sh, gnuErr, function (text) {
      if (o.d) {
        try {
          out += fromBytes(b64decode(o.i ? text.replace(/[^\x21-\x2b\x2d-\x7e]/g, "") : text));
        } catch (e) {
          sh._error("base64: invalid input");
          code = 1;
        }
        return;
      }
      out += wrap(b64encode(bytes(text)), o.w === undefined ? 76 : parseInt(o.w, 10));
    });
    return { out: out, code: code };
  }, "base64 encode or decode FILE, or standard input, to standard output");

  // ---- base32 --------------------------------------------------------------
  def("base32", function (args, stdin, sh) {
    var g = getopt("base32", args, {
      short: { d: "bool", i: "bool", w: "arg", "0": "bool" },
      long: { decode: ["bool", "d"], "ignore-garbage": ["bool", "i"], wrap: ["arg", "w"] },
    });
    var done = finish(sh, "base32", g);
    if (done) return done;
    var o = g.o, out = "", code = 0;
    code = inputs("base32", g._, stdin, sh, gnuErr, function (text) {
      if (o.d) {
        try {
          out += fromBytes(b32decode(o.i ? text.replace(/[^A-Z2-7=]/gi, "") : text, B32));
        } catch (e) {
          sh._error("base32: invalid input");
          code = 1;
        }
        return;
      }
      out += wrap(b32encode(bytes(text), B32), o.w === undefined ? 76 : parseInt(o.w, 10));
    });
    return { out: out, code: code };
  }, "base32 encode or decode FILE, or standard input, to standard output");

  // ---- basenc: the RFC 4648 family behind one program ----------------------
  def("basenc", function (args, stdin, sh) {
    var g = getopt("basenc", args, {
      short: { d: "bool", i: "bool", w: "arg", "0": "bool" },
      long: {
        base64: "bool", base64url: "bool", base32: "bool", base32hex: "bool",
        base16: "bool", base2msbf: "bool", base2lsbf: "bool", z85: "bool",
        decode: ["bool", "d"], "ignore-garbage": ["bool", "i"], wrap: ["arg", "w"],
      },
    });
    var done = finish(sh, "basenc", g);
    if (done) return done;
    var o = g.o;
    var mode = o.base64url ? "base64url" : o.base32hex ? "base32hex"
      : o.base32 ? "base32" : o.base16 ? "base16"
        : o.base2msbf ? "base2msbf" : o.base2lsbf ? "base2lsbf" : o.z85 ? "z85"
          : "base64";
    var out = "", code = 0;
    code = inputs("basenc", g._, stdin, sh, gnuErr, function (text) {
      var bs = bytes(text);
      if (o.d) {
        try {
          out += fromBytes(decode(mode, o.i ? text.replace(/\s+/g, "") : text));
        } catch (e) {
          sh._error("basenc: invalid input");
          code = 1;
        }
        return;
      }
      out += wrap(encode(mode, bs), o.w === undefined ? 76 : parseInt(o.w, 10));
    });
    return { out: out, code: code };

    function encode(mode2, bs) {
      switch (mode2) {
        case "base64": return b64encode(bs);
        case "base64url": return b64encode(bs).replace(/\+/g, "-").replace(/\//g, "_");
        case "base32": return b32encode(bs, B32);
        case "base32hex": return b32encode(bs, B32HEX);
        case "base16": return hex(bs).toUpperCase();
        case "base2msbf": return bits(bs, true);
        case "base2lsbf": return bits(bs, false);
        case "z85": return z85encode(bs);
      }
      return "";
    }
    function decode(mode2, s) {
      switch (mode2) {
        case "base64":
        case "base64url": return b64decode(s.replace(/-/g, "+").replace(/_/g, "/"));
        case "base32": return b32decode(s, B32);
        case "base32hex": return b32decode(s, B32HEX);
        case "base16": {
          var out2 = [];
          for (var i = 0; i + 1 < s.length; i += 2) out2.push(parseInt(s.substr(i, 2), 16));
          return out2;
        }
        case "base2msbf":
        case "base2lsbf": return unbits(s);
        case "z85": return z85decode(s);
      }
      return [];
    }
    function bits(bs, msbFirst) {
      var out = "";
      bs.forEach(function (b) {
        for (var i = 0; i < 8; i++) {
          var shift = msbFirst ? 7 - i : i;
          out += (b >> shift) & 1;
        }
      });
      return out;
    }
    function unbits(s) {
      var out = [], cur = 0, n = 0;
      for (var i = 0; i < s.length; i++) {
        if (s.charAt(i) !== "0" && s.charAt(i) !== "1") continue;
        cur = (cur << 1) | (s.charAt(i) === "1" ? 1 : 0);
        n++;
        if (n === 8) { out.push(cur); cur = 0; n = 0; }
      }
      return out;
    }
    // Z85 (ZeroMQ): 5 bytes in, 5 characters out, big-endian base-85
    function z85encode(bs) {
      var Z = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";
      var out = "";
      for (var i = 0; i + 5 <= bs.length; i += 5) {
        var v = 0;
        for (var k = 0; k < 5; k++) v = v * 256 + bs[i + k];
        var chunk = "";
        for (var d = 0; d < 5; d++) {
          chunk = Z.charAt(v % 85) + chunk;
          v = Math.floor(v / 85);
        }
        out += chunk;
      }
      return out;
    }
    function z85decode(s) {
      var Z = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";
      var out = [];
      for (var i = 0; i + 5 <= s.length; i += 5) {
        var v = 0;
        for (var k = 0; k < 5; k++) {
          var d = Z.indexOf(s.charAt(i + k));
          if (d < 0) throw new Error("invalid input");
          v = v * 85 + d;
        }
        for (var b = 4; b >= 0; b--) out.push(Math.floor(v / Math.pow(256, b)) % 256);
      }
      return out;
    }
  }, "basenc encode or decode FILE, or standard input, to standard output");

  // Wrap at COLS characters.  -w0 means "no wrapping", and then there is no
  // final newline either -- `printf abc | base64 -w0 | od -c` shows four bytes
  // and nothing else.
  function wrap(text, cols) {
    if (!cols) return text;
    if (!text.length) return "\n";
    var out = "";
    for (var i = 0; i < text.length; i += cols) out += text.slice(i, i + cols) + "\n";
    return out;
  }

})(window.LW);