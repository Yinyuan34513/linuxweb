// GNU coreutils -- checksums and encodings.  base32, base64, basenc, cksum,
// md5sum, sha1sum, sha224sum, sha256sum, sha384sum, sha512sum, b2sum, sum.
//
// Requires: vfs.js, bash.js (LW.core), sha256.js (LW.SHA256).
(function (LW) {
  "use strict";

  var V = LW.VFS;
  var def = LW.core.defCmd;
  var getopt = LW.core.getopt, finish = LW.core.finish;
  var eachInput = LW.core.eachInput, gnuErr = LW.core.gnuErr;

})(window.LW);
