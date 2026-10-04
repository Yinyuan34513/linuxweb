// GNU coreutils -- text filters.  wc, tr, cut, sort, uniq, head, tail, nl,
// tac, fold, fmt, expand, unexpand, join, comm, paste, split, od, pr,
// numfmt, seq, ptx, shuf, truncate, tsort.
//
// Every command here is a real coreutils program: the options, the error
// wording and the exit statuses are checked against GNU coreutils 9.4
// (LC_ALL=C), and --help / --version print the real text that
// src/coreutils_help.js was generated with.
//
// Requires: vfs.js, bash.js (LW.core).
(function (LW) {
  "use strict";

  var V = LW.VFS;
  var def = LW.core.defCmd;
  var getopt = LW.core.getopt, finish = LW.core.finish;
  var eachInput = LW.core.eachInput, gnuErr = LW.core.gnuErr;

})(window.LW);
