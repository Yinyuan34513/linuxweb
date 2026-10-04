// GNU coreutils -- system and identity commands.  arch, uname, whoami, id,
// groups, date, env, printenv, tty, logname, users, who, hostid, nproc,
// nice, nohup, timeout, sleep, yes, sync, stty, stdbuf, runcon, chroot,
// dir, vdir, dircolors, pinky, pathchk, expr, factor.
//
// Requires: vfs.js, bash.js (LW.core).
(function (LW) {
  "use strict";

  var V = LW.VFS;
  var def = LW.core.defCmd;
  var getopt = LW.core.getopt, finish = LW.core.finish;
  var eachInput = LW.core.eachInput, gnuErr = LW.core.gnuErr;

})(window.LW);
