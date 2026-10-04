// GNU coreutils -- file commands.  cat lives in bash.js; everything else
// that copies, moves, links, creates, removes, measures or rewrites files:
// cp, mv, rm, rmdir, mkdir, touch, tee, ln, link, unlink, install, mktemp,
// mkfifo, mknod, chmod, chown, chgrp, chcon, readlink, realpath, basename,
// dirname, shred, du, df, dd, stat, csplit.
//
// Requires: vfs.js, bash.js (LW.core).
(function (LW) {
  "use strict";

  var V = LW.VFS;
  var def = LW.core.defCmd;
  var getopt = LW.core.getopt, finish = LW.core.finish;
  var eachInput = LW.core.eachInput, gnuErr = LW.core.gnuErr;

})(window.LW);
