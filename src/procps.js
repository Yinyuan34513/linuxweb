// ps(1), pgrep(1), pkill(1), pidof(1) and pstree(1).
//
// ps is procps-ng 4.0.5's src/ps ported file by file: the option parser of
// parser.c, the column table of output.c (COLS below), the renderer of
// show_one_proc(), the selection of select.c and the sort/format merge of
// sortformat.c.  Where the real one reads /proc this one reads the table
// src/proc.js keeps, so ps, kill, jobs and /proc cannot disagree; everything
// above that is the same algorithm, which is why the layouts and the error
// wording land where they land on a real machine.
//
// Requires: bash.js (LW.core), proc.js, procps_help.js -- all loaded before.
(function (LW) {
  "use strict";

  var P = LW.proc;
  var V = LW.VFS;
  var def = LW.core.defCmd;
  var HELP = LW.PSHELP || {};
  var VER = LW.PSVER || {};

  // ---- sizes the renderer may use -----------------------------------------
  var OUTBUF = 131072;        // OUTBUF_SIZE -- one absurdly long line
  var SPACE_MAX = 144;        // SPACE_AMOUNT -- padding a column may steal
  var PIDLEN = 7;             // PID_LEN -- /proc/sys/kernel/pid_max
  var COLWID = 240;           // COLWID -- what snprintf() uses for values
  var SIGNAL_NAME_WIDTH = 27; // SIGNAL_NAME_WIDTH -- a signal's full name

  // header_type
  var HEAD_SINGLE = 0, HEAD_NONE = 1, HEAD_MULTI = 2;

  // justification codes (CF_JUST_MASK)
  var J_USER = 1, J_LEFT = 2, J_RIGHT = 3, J_UNLIMITED = 4, J_WCHAN = 5,
      J_SIGNAL = 6;

  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function two(n) { return (n < 10 ? "0" : "") + n; }
  function pad(s, n) { s = String(s); while (s.length < n) s = " " + s; return s; }
  function now() { return LW.now ? LW.now() : new Date(); }

  // The groups /etc/group gives the users here, by gid.  supgid/supgrp and
  // the group names print them, so they come from this one table.
  var GROUPS = { 0: "root", 27: "sudo", 1000: "linuxweb" };

  // procps' escape_str(): copy at most `max` cells, marking anything the
  // terminal would choke on.  It never appends a `+` -- do_pr_name() does.
  function escapeStr(s, max) {
    if (s === null || s === undefined) return "";
    s = String(s);
    if (!(max > 0)) return "";
    var out = "";
    for (var i = 0; i < s.length && out.length < max; i++) {
      var c = s.charCodeAt(i);
      out += (c < 32 || c === 127) ? "." : s.charAt(i);
    }
    return out;
  }

  // procps' do_pr_name(): a name cut to `max` cells, with a `+` when the cut
  // cost something.  Names do; the contents of a path never do.
  function prName(s, max) {
    if (!(max > 0)) return "";
    s = String(s);
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + "+";
  }

  // C's `%um` on a negative lines_to_next_header.  The test columns index
  // their table with it, and -1 wraps around rather than going negative.
  function uMod(n, m) { return (n >>> 0) % m; }

  // ---- the column table ---------------------------------------------------
  //
  // spec: [header, width, justification, value routine]
  // A null value routine is pr_nop: it prints a bare "-".
  // spec: [header, width, justification, value routine]
  var COLS = {
  "%cpu": ["%CPU", 4, 3, "pcpu"],
  "%mem": ["%MEM", 4, 3, "pmem"],
  "_left": ["LLLLLLLL", 8, 2, "tleft"],
  "_left2": ["L2L2L2L2", 8, 2, "tleft2"],
  "_right": ["RRRRRRRRRRR", 11, 3, "tright"],
  "_right2": ["R2R2R2R2R2R", 11, 3, "tright2"],
  "_unlimited": ["U", 16, 4, "tunlim"],
  "_unlimited2": ["U2", 16, 4, "tunlim2"],
  "acflag": ["ACFLG", 5, 3, null],
  "acflg": ["ACFLG", 5, 3, null],
  "addr": ["ADDR", 4, 3, null],
  "addr_1": ["ADDR", 1, 2, null],
  "ag_id": ["AGID", 5, 3, "agid"],
  "ag_nice": ["AGNI", 4, 3, "zero"],
  "alarm": ["ALARM", 5, 3, null],
  "argc": ["ARGC", 4, 3, null],
  "args": ["COMMAND", 27, 4, "args"],
  "atime": ["TIME", 8, 3, "time"],
  "blocked": ["BLOCKED", 9, 6, "blk"],
  "bnd": ["BND", 1, 3, null],
  "bsdstart": ["START", 6, 3, "bsdstart"],
  "bsdtime": ["TIME", 6, 3, "bsdtime"],
  "c": ["C", 2, 3, "c"],
  "caught": ["CAUGHT", 9, 6, "cgt"],
  "cgname": ["CGNAME", 27, 4, "cgroup"],
  "cgroup": ["CGROUP", 27, 4, "cgroup"],
  "cgroupns": ["CGROUPNS", 10, 3, null],
  "class": ["CLS", 3, 2, "class"],
  "cls": ["CLS", 3, 3, "class"],
  "cmaj_flt": ["-", 1, 3, null],
  "cmd": ["CMD", 27, 4, "args"],
  "cmin_flt": ["-", 1, 3, null],
  "cnswap": ["-", 1, 3, null],
  "comm": ["COMMAND", 15, 4, "comm"],
  "command": ["COMMAND", 27, 4, "args"],
  "context": ["CONTEXT", 31, 2, "label"],
  "cp": ["CP", 3, 3, "cp"],
  "cpu": ["CPU", 3, 3, null],
  "cpuid": ["CPUID", 5, 3, "cpu"],
  "cputime": ["TIME", 8, 3, "time"],
  "cputimes": ["TIME", 8, 3, "times"],
  "ctid": ["CTID", 5, 3, null],
  "cuc": ["%CUC", 7, 3, "util"],
  "cursig": ["CURSIG", 6, 3, null],
  "cutime": ["-", 1, 3, null],
  "cuu": ["%CUU", 6, 3, "util"],
  "cwd": ["CWD", 3, 2, null],
  "docker": ["DOCKER", 12, 2, null],
  "drs": ["DRS", 5, 3, "drs"],
  "dsiz": ["DSIZ", 4, 3, "drs"],
  "egid": ["EGID", 5, 3, "gid"],
  "egroup": ["EGROUP", 8, 1, "gname"],
  "eip": ["EIP", 16, 3, "addr0"],
  "emul": ["EMUL", 13, 2, null],
  "end_code": ["E_CODE", 16, 3, null],
  "environ": ["ENVIRONMENT", 31, 4, "env"],
  "esp": ["ESP", 16, 3, "addr0"],
  "etime": ["ELAPSED", 11, 3, "etime"],
  "etimes": ["ELAPSED", 7, 3, "etimes"],
  "euid": ["EUID", 5, 3, "uid"],
  "euser": ["EUSER", 8, 1, "uname"],
  "exe": ["EXE", 27, 4, "exe"],
  "f": ["F", 1, 3, "flag"],
  "fds": ["FDS", 3, 3, "fds"],
  "fgid": ["FGID", 5, 3, "gid"],
  "fgroup": ["FGROUP", 8, 1, "gname"],
  "flag": ["F", 1, 3, "flag"],
  "flags": ["F", 1, 3, "flag"],
  "fname": ["COMMAND", 8, 2, "fname"],
  "fsgid": ["FSGID", 5, 3, "gid"],
  "fsgroup": ["FSGROUP", 8, 1, "gname"],
  "fsuid": ["FSUID", 5, 3, "uid"],
  "fsuser": ["FSUSER", 8, 1, "uname"],
  "fuid": ["FUID", 5, 3, "uid"],
  "fuser": ["FUSER", 8, 1, "uname"],
  "gid": ["GID", 5, 3, "gid"],
  "group": ["GROUP", 8, 1, "gname"],
  "htprv": ["HTPRV", 5, 3, "zero"],
  "htshr": ["HTSHR", 5, 3, "zero"],
  "ignored": ["IGNORED", 9, 6, "ign"],
  "inblk": ["INBLK", 5, 3, null],
  "inblock": ["INBLK", 5, 3, null],
  "intpri": ["PRI", 3, 3, "opri"],
  "ipcns": ["IPCNS", 10, 3, null],
  "jid": ["JID", 1, 3, null],
  "jobc": ["JOBC", 4, 3, null],
  "ktrace": ["KTRACE", 8, 3, null],
  "ktracep": ["KTRACEP", 8, 3, null],
  "label": ["LABEL", 31, 2, "label"],
  "lastcpu": ["C", 3, 3, "cpu"],
  "lim": ["LIM", 5, 3, "lim"],
  "login": ["LOGNAME", 8, 2, null],
  "logname": ["LOGNAME", 8, 2, null],
  "longtname": ["TTY", 8, 2, "tty"],
  "lsession": ["SESSION", 11, 2, null],
  "lstart": ["STARTED", 24, 3, "lstart"],
  "luid": ["LUID", 5, 3, "luid"],
  "luser": ["LUSER", 8, 1, null],
  "lwp": ["LWP", 5, 3, "pid"],
  "lxc": ["LXC", 8, 2, null],
  "m_drs": ["DRS", 5, 3, "drs"],
  "m_dt": ["DT", 4, 3, null],
  "m_lrs": ["LRS", 5, 3, null],
  "m_resident": ["RES", 5, 3, null],
  "m_share": ["SHRD", 5, 3, null],
  "m_size": ["SIZE", 5, 3, "msize"],
  "m_swap": ["SWAP", 5, 3, null],
  "m_trs": ["TRS", 5, 3, "trs"],
  "machine": ["MACHINE", 31, 2, null],
  "maj_flt": ["MAJFL", 6, 3, "majflt"],
  "majflt": ["MAJFLT", 6, 3, "majflt"],
  "min_flt": ["MINFL", 6, 3, "minflt"],
  "minflt": ["MINFLT", 6, 3, "minflt"],
  "mntns": ["MNTNS", 10, 3, null],
  "msgrcv": ["MSGRCV", 6, 3, null],
  "msgsnd": ["MSGSND", 6, 3, null],
  "mwchan": ["MWCHAN", 6, 5, null],
  "netns": ["NETNS", 10, 3, null],
  "ni": ["NI", 3, 3, "nice"],
  "nice": ["NI", 3, 3, "nice"],
  "nivcsw": ["IVCSW", 5, 3, null],
  "nlwp": ["NLWP", 4, 3, "nlwp"],
  "nsignals": ["NSIGS", 5, 3, null],
  "nsigs": ["NSIGS", 5, 3, null],
  "nswap": ["NSWAP", 5, 3, null],
  "numa": ["NUMA", 4, 3, "numa"],
  "nvcsw": ["VCSW", 5, 3, null],
  "nwchan": ["WCHAN", 6, 3, null],
  "oom": ["OOM", 4, 3, "oom"],
  "oomadj": ["OOMADJ", 5, 3, "zero"],
  "opri": ["PRI", 3, 3, "opri"],
  "osz": ["SZ", 2, 3, null],
  "oublk": ["OUBLK", 5, 3, null],
  "oublock": ["OUBLK", 5, 3, null],
  "ouid": ["OWNER", 5, 2, null],
  "p_ru": ["P_RU", 6, 3, null],
  "paddr": ["PADDR", 6, 3, null],
  "pagein": ["PAGEIN", 6, 3, "majflt"],
  "pcap": ["PCAP", 16, 3, "pcap"],
  "pcaps": ["PCAPS", 16, 3, "pcaps"],
  "pcpu": ["%CPU", 4, 3, "pcpu"],
  "pending": ["PENDING", 9, 6, "pnd"],
  "pgid": ["PGID", 5, 3, "pgid"],
  "pgrp": ["PGRP", 5, 3, "pgid"],
  "pid": ["PID", 5, 3, "pid"],
  "pidns": ["PIDNS", 10, 3, null],
  "pmem": ["%MEM", 4, 3, "pmem"],
  "poip": ["-", 1, 3, null],
  "policy": ["POL", 3, 2, "class"],
  "ppid": ["PPID", 5, 3, "ppid"],
  "pri": ["PRI", 3, 3, "pri"],
  "pri_api": ["API", 3, 3, "priapi"],
  "pri_bar": ["BAR", 3, 3, "pribar"],
  "pri_baz": ["BAZ", 3, 3, "pribaz"],
  "pri_foo": ["FOO", 3, 3, "prifoo"],
  "priority": ["PRI", 3, 3, "priority"],
  "prmgrp": ["PRMGRP", 12, 3, null],
  "prmid": ["PRMID", 12, 3, null],
  "project": ["PROJECT", 12, 2, null],
  "projid": ["PROJID", 5, 3, null],
  "pset": ["PSET", 4, 3, null],
  "psr": ["PSR", 3, 3, "cpu"],
  "pss": ["PSS", 5, 3, "zero"],
  "psxpri": ["PPR", 3, 3, null],
  "rbytes": ["RBYTES", 5, 3, "zero"],
  "rchars": ["RCHARS", 5, 3, "zero"],
  "re": ["RE", 3, 3, null],
  "resident": ["RES", 5, 3, null],
  "rgid": ["RGID", 5, 3, "gid"],
  "rgroup": ["RGROUP", 8, 1, "gname"],
  "rlink": ["RLINK", 8, 3, null],
  "rops": ["ROPS", 5, 3, "zero"],
  "rss": ["RSS", 5, 3, "rss"],
  "rssize": ["RSS", 5, 3, "rss"],
  "rsz": ["RSZ", 5, 3, "rss"],
  "rtprio": ["RTPRIO", 6, 3, "rtprio"],
  "ruid": ["RUID", 5, 3, "uid"],
  "ruser": ["RUSER", 8, 1, "uname"],
  "s": ["S", 1, 2, "state"],
  "sched": ["SCH", 3, 3, "sched"],
  "scnt": ["SCNT", 4, 3, null],
  "scount": ["SC", 4, 3, null],
  "seat": ["SEAT", 11, 2, null],
  "sess": ["SESS", 5, 3, "sid"],
  "session": ["SESS", 5, 3, "sid"],
  "sgi_p": ["P", 1, 3, "sgip"],
  "sgi_rss": ["RSS", 4, 2, "rss"],
  "sgid": ["SGID", 5, 3, "gid"],
  "sgroup": ["SGROUP", 8, 1, "gname"],
  "share": ["-", 1, 3, null],
  "sid": ["SID", 5, 3, "sid"],
  "sig": ["PENDING", 9, 6, "pnd"],
  "sig_block": ["BLOCKED", 9, 6, "blk"],
  "sig_catch": ["CATCHED", 9, 6, "cgt"],
  "sig_ignore": ["IGNORED", 9, 6, "ign"],
  "sig_pend": ["SIGNAL", 9, 6, "pnd"],
  "sigcatch": ["CAUGHT", 9, 6, "cgt"],
  "sigignore": ["IGNORED", 9, 6, "ign"],
  "sigmask": ["BLOCKED", 9, 6, "blk"],
  "size": ["SIZE", 5, 3, "size"],
  "sl": ["SL", 3, 3, null],
  "slice": ["SLICE", 31, 2, null],
  "spid": ["SPID", 5, 3, "pid"],
  "stackp": ["STACKP", 16, 3, "addr0"],
  "start": ["STARTED", 8, 3, "start"],
  "start_code": ["S_CODE", 16, 3, null],
  "start_stack": ["STACKP", 16, 3, "addr0"],
  "start_time": ["START", 5, 3, "stime"],
  "stat": ["STAT", 4, 2, "stat"],
  "state": ["S", 1, 2, "state"],
  "status": ["STATUS", 6, 3, null],
  "stime": ["STIME", 5, 3, "stime"],
  "suid": ["SUID", 5, 3, "uid"],
  "supgid": ["SUPGID", 20, 4, "supgid"],
  "supgrp": ["SUPGRP", 40, 4, "supgrp"],
  "suser": ["SUSER", 8, 1, "uname"],
  "svgid": ["SVGID", 5, 3, "gid"],
  "svgroup": ["SVGROUP", 8, 1, "gname"],
  "svuid": ["SVUID", 5, 3, "uid"],
  "svuser": ["SVUSER", 8, 1, "uname"],
  "systime": ["SYSTEM", 6, 3, null],
  "sz": ["SZ", 5, 3, "sz"],
  "taskid": ["TASKID", 5, 3, null],
  "tdev": ["TDEV", 4, 3, null],
  "tgid": ["TGID", 5, 3, "pid"],
  "thcount": ["THCNT", 5, 3, "nlwp"],
  "tid": ["TID", 5, 3, "pid"],
  "time": ["TIME", 8, 3, "time"],
  "timens": ["TIMENS", 10, 3, null],
  "timeout": ["TMOUT", 5, 3, null],
  "times": ["TIME", 8, 3, "times"],
  "tmout": ["TMOUT", 5, 3, null],
  "tname": ["TTY", 8, 2, "tty"],
  "tpgid": ["TPGID", 5, 3, "tpgid"],
  "trs": ["TRS", 4, 3, "trs"],
  "trss": ["TRSS", 4, 3, "trs"],
  "tsess": ["TSESS", 5, 3, null],
  "tsession": ["TSESS", 5, 3, null],
  "tsid": ["TSID", 5, 3, null],
  "tsig": ["PENDING", 9, 6, "pnd"],
  "tsiz": ["TSIZ", 4, 3, "trs"],
  "tt": ["TT", 8, 2, "tty"],
  "tty": ["TT", 8, 2, "tty"],
  "tty4": ["TTY", 4, 2, "tty4"],
  "tty8": ["TTY", 8, 2, "tty"],
  "u_procp": ["UPROCP", 6, 3, null],
  "ucmd": ["CMD", 15, 4, "comm"],
  "ucomm": ["COMMAND", 15, 4, "comm"],
  "uid": ["UID", 5, 3, "uid"],
  "uid_hack": ["UID", 8, 1, "uname"],
  "umask": ["UMASK", 5, 3, null],
  "uname": ["USER", 8, 1, "uname"],
  "unit": ["UNIT", 31, 2, "unit"],
  "upr": ["UPR", 3, 3, null],
  "uprocp": ["UPROCP", 8, 3, null],
  "user": ["USER", 8, 1, "uname"],
  "userns": ["USERNS", 10, 3, null],
  "usertime": ["USER", 4, 3, null],
  "usrpri": ["UPR", 3, 3, null],
  "uss": ["USS", 5, 3, "zero"],
  "util": ["C", 2, 3, "c"],
  "utime": ["UTIME", 6, 3, null],
  "utsns": ["UTSNS", 10, 3, null],
  "uunit": ["UUNIT", 31, 2, null],
  "vm_data": ["DATA", 5, 3, null],
  "vm_exe": ["EXE", 5, 3, null],
  "vm_lib": ["LIB", 5, 3, null],
  "vm_lock": ["LCK", 3, 3, null],
  "vm_stack": ["STACK", 5, 3, null],
  "vsize": ["VSZ", 6, 3, "vsz"],
  "vsz": ["VSZ", 6, 3, "vsz"],
  "wbytes": ["WBYTES", 5, 3, "zero"],
  "wcbytes": ["WCBYTES", 5, 3, "zero"],
  "wchan": ["WCHAN", 6, 5, "wchan"],
  "wchars": ["WCHARS", 5, 3, "zero"],
  "wname": ["WCHAN", 6, 5, "wchan"],
  "wops": ["WOPS", 5, 3, "zero"],
  "xstat": ["XSTAT", 5, 3, null],
  "zone": ["ZONE", 31, 2, "label"],
  "zoneid": ["ZONEID", 31, 3, null],
  "~": ["-", 1, 3, null],
  };

  // Columns procps derives from /proc/sys/kernel/pid_max, printed wide
  // enough for a seven-digit pid.  The set is output.c's CF_PIDMAX flag.
  var PIDMAX = {
    lwp: 1, pgid: 1, pgrp: 1, pid: 1, ppid: 1, sess: 1, session: 1, sid: 1,
    spid: 1, taskid: 1, tgid: 1, tid: 1, tpgid: 1, tsess: 1, tsession: 1,
    tsid: 1,
  };

  // format_array's neighbours: named combinations of specs (macro_array),
  // the AIX "%c"-style descriptors (aix_array) and the single letters the
  // BSD `O` option sorts by (shortsort_array).
  var MACROS = {
    DFMT: "pid,tname,state,cputime,cmd",
    DefBSD: "pid,tname,stat,bsdtime,args",
    DefSysV: "pid,tname,time,cmd",
    END_BSD: "state,tname,cputime,comm",
    END_SYS5: "state,tname,time,command",
    F5FMT: "uname,pid,ppid,c,start,tname,time,cmd",

    FB_: "pid,tt,stat,time,command",
    FB_j: "user,pid,ppid,pgid,sess,jobc,stat,tt,time,command",
    FB_l: "uid,pid,ppid,cpu,pri,nice,vsz,rss,wchan,stat,tt,time,command",
    FB_u: "user,pid,pcpu,pmem,vsz,rss,tt,stat,start,time,command",
    FB_v: "pid,stat,time,sl,re,pagein,vsz,rss,lim,tsiz,pcpu,pmem,command",

    FD_: "pid,tty,time,comm",
    FD_f: "user,pid,ppid,start_time,tty,time,comm",
    FD_fj: "user,pid,ppid,start_time,tty,time,pgid,sid,comm",
    FD_j: "pid,tty,time,pgid,sid,comm",
    FD_l: "flags,state,uid,pid,ppid,priority,nice,vsz,wchan,tty,time,comm",
    FD_lj: "flags,state,uid,pid,ppid,priority,nice,vsz,wchan,tty,time,pgid,sid,comm",

    FL5FMT: "f,state,uid,pid,ppid,pcpu,pri,nice,rss,wchan,start,time,command",
    FLASK_context: "pid,context,command",

    HP_: "pid,tty,time,comm",
    HP_f: "user,pid,ppid,cpu,stime,tty,time,args",
    HP_fl: "flags,state,user,pid,ppid,cpu,intpri,nice,addr,sz,wchan,stime,tty,time,args",
    HP_l: "flags,state,uid,pid,ppid,cpu,intpri,nice,addr,sz,wchan,tty,time,comm",

    J390: "pid,sid,pgrp,tname,atime,args",
    JFMT: "user,pid,ppid,pgid,sess,jobc,state,tname,cputime,command",
    L5FMT: "f,state,uid,pid,ppid,c,pri,nice,addr,sz,wchan,tt,time,ucmd",
    LFMT: "uid,pid,ppid,cp,pri,nice,vsz,rss,wchan,state,tname,cputime,command",

    OL_X: "pid,start_stack,esp,eip,timeout,alarm,stat,tname,bsdtime,args",
    OL_j: "ppid,pid,pgid,sid,tname,tpgid,stat,uid,bsdtime,args",
    OL_l: "flags,uid,pid,ppid,priority,nice,vsz,rss,wchan,stat,tname,bsdtime,args",
    OL_m: "pid,tname,majflt,minflt,m_trs,m_drs,m_size,m_swap,rss,m_share,vm_lib,m_dt,args",
    OL_s: "uid,pid,pending,sig_block,sig_ignore,caught,stat,tname,bsdtime,args",
    OL_u: "user,pid,pcpu,pmem,vsz,rss,tname,stat,start_time,bsdtime,args",
    OL_v: "pid,tname,stat,bsdtime,maj_flt,m_trs,m_drs,rss,pmem,args",

    RD_: "pid,tname,state,bsdtime,comm",
    RD_f: "uid,pid,ppid,start_time,tname,bsdtime,args",
    RD_fj: "uid,pid,ppid,start_time,tname,bsdtime,pgid,sid,args",
    RD_j: "pid,tname,state,bsdtime,pgid,sid,comm",
    RD_l: "flags,state,uid,pid,ppid,priority,nice,wchan,tname,bsdtime,comm",
    RD_lj: "flags,state,uid,pid,ppid,priority,nice,wchan,tname,bsdtime,pgid,sid,comm",

    RUSAGE: "minflt,majflt,nswap,inblock,oublock,msgsnd,msgrcv,nsigs,nvcsw,nivcsw",
    SCHED: "user,pcpu,pri,usrpri,nice,psxpri,psr,policy,pset",
    SFMT: "uid,pid,cursig,sig,sigmask,sigignore,sigcatch,stat,tname,command",

    Std_f: "uid_hack,pid,ppid,c,stime,tname,time,cmd",
    Std_fl: "f,s,uid_hack,pid,ppid,c,opri,ni,addr,sz,wchan,stime,tname,time,cmd",
    Std_l: "f,s,uid,pid,ppid,c,opri,ni,addr,sz,wchan,tname,time,ucmd",

    THREAD: "user,pcpu,pri,scnt,wchan,usertime,systime",
    UFMT: "uname,pid,pcpu,pmem,vsz,rss,tt,state,start,time,command",
    VFMT: "pid,tt,state,time,sl,pagein,vsz,rss,pcpu,pmem,command",
    "~": "~",
  };

  // %-descriptors: the letter, the spec it stands for and the header it
  // gives it.  `%x` really does print TIME, not a hex number.
  var AIX = {
    C: ["pcpu", "%CPU"], G: ["group", "GROUP"], P: ["ppid", "PPID"],
    U: ["user", "USER"], a: ["args", "COMMAND"], c: ["comm", "COMMAND"],
    g: ["rgroup", "RGROUP"], n: ["nice", "NI"], p: ["pid", "PID"],
    r: ["pgid", "PGID"], t: ["etime", "ELAPSED"], u: ["ruser", "RUSER"],
    x: ["time", "TIME"], y: ["tty", "TTY"], z: ["vsz", "VSZ"],
  };

  // The letters BSD's `O` sorts by, and the spec each stands for.
  var SHORTSORT = {
    C: "pcpu", G: "tpgid", J: "cstime", M: "maj_flt", N: "cmaj_flt",
    P: "ppid", R: "resident", S: "share", T: "start_time", U: "uid",
    c: "cmd", f: "flags", g: "pgrp", j: "cutime", k: "utime",
    m: "min_flt", n: "cmin_flt", o: "session", p: "pid", r: "rss",
    s: "size", t: "tty", u: "user", v: "vsize", y: "priority",
  };

  // ---- the value routines -------------------------------------------------
  //
  // One per distinct routine in procps' format_array; COLS says which spec
  // uses which.  Each is called with the process, the run state and the
  // number of cells it may fill -- and returns the text, already cut if the
  // real routine cuts it.  The routines that use snprintf(COLWID) do not
  // cut: a column may well be wider than its declared width.
  var VAL = {};

  function isZ(e) { return !!(e.zombie || (e.stat && e.stat.charAt(0) === "Z")); }

  // What `ps args` shows.  A kernel thread's /proc/pid/cmdline is empty, so
  // procps prints [comm] instead of nothing.
  function cmdline(e) {
    if (e.args) return e.args;
    if (e.kernel) return "[" + (e.comm || "") + "]";
    return "";
  }

  // The tree glyphs a forest row leads with, four cells per level ('u' -- the
  // unixy -H style -- uses two).  Cut when they would not fit.
  function forestHelper(S, max) {
    var p = S.forestPrefix;
    if (!p) return "";
    var step = S.forestType === "u" ? 2 : 4, out = "";
    for (var i = 0; i < p.length; i++) {
      if (max - out.length < step) break;
      if (step === 2) { out += "  "; continue; }
      var c = p.charAt(i);
      out += c === "|" ? " |  " : (c === "L" || c === "+") ? " \\_ " : "    ";
    }
    return out;
  }

  // cmdline / comm plus the forest prefix and, under `ps e`, the environment.
  function cmdValue(e, S, m, useCmd) {
    var pre = forestHelper(S, m), left = m - pre.length, out = pre, t;
    if (left < 0) left = 0;
    if (useCmd) {
      out += escapeStr(cmdline(e), left); left = m - out.length;
    } else {
      out += escapeStr(e.comm || "", left); left = m - out.length;
      if (isZ(e)) { t = escapeStr(" <defunct>", Math.max(0, left)); out += t; left -= t.length; }
    }
    if (S.bsdE && left > 1 && e.env && e.env.length) {
      var env = e.env.join(" ");
      if (env && !(env.length === 1 && env === "-")) {
        t = escapeStr(" " + env, left - 1); out += t;
      }
    }
    return out;
  }

  VAL.args = function (e, S, m) { return cmdValue(e, S, m, !S.bsdC); };
  VAL.comm = function (e, S, m) { return cmdValue(e, S, m, !!S.unixF); };

  VAL.fname = function (e, S, m) {
    var pre = forestHelper(S, m), left = m - pre.length;
    if (left > 8) left = 8;
    if (left < 0) left = 0;
    return pre + escapeStr(e.comm || "", left);
  };

  // ---- identity -----------------------------------------------------------
  VAL.pid = function (e) { return String(e.pid); };
  VAL.ppid = function (e) { return String(e.ppid); };
  VAL.pgid = function (e) { return String(P.pgid(e)); };
  VAL.sid = function (e) { return String(P.sid(e)); };
  VAL.tpgid = function (e) { return String(P.tpgid(e)); };
  VAL.uid = function (e) { return String(e.uid); };
  VAL.gid = function (e) { return String(P.gid(e)); };
  VAL.uname = function (e, S, m) {
    return S.userNum ? String(e.uid) : prName(e.user, m);
  };
  VAL.gname = function (e, S, m) {
    return S.userNum ? String(P.gid(e)) : prName(P.groupName(e), m);
  };
  VAL.label = function (e, S, m) { return escapeStr(P.scontext(e), m); };

  VAL.class = function () { return "TS"; };
  VAL.state = function (e) { return P.stat(e).charAt(0); };
  VAL.stat = function (e) { return P.stat(e); };
  // flags: the kernel puts PF_ flags in the same place for every process,
  // and a kernel thread has no PF_ flags of its own -- hence the 0.
  VAL.flag = function (e) { return e.kernel ? "0" : "4"; };

  VAL.nlwp = function () { return "1"; };
  VAL.fds = function (e) { return String(P.fdCount(e)); };
  VAL.numa = function () { return "0"; };
  VAL.oom = function () { return "0"; };
  VAL.sched = function () { return "0"; };
  VAL.rtprio = function () { return "-"; };
  VAL.lim = function () { return "xx"; };
  VAL.sgip = function () { return "*"; };
  VAL.zero = function () { return "0"; };
  VAL.addr0 = function () { return "0000000000000000"; };
  VAL.cpu = function () { return "0"; };          // which processor it last ran on

  VAL.agid = function (e) { return e.kernel ? "-1" : (e.uid ? "5278" : "2"); };
  VAL.luid = function (e) { return e.uid ? String(e.uid) : "-"; };
  VAL.pcap = function (e) { return P.caps(e).prm; };
  VAL.pcaps = function (e) { return e.uid ? "-" : "full"; };
  VAL.supgid = function (e) {
    var g = P.groupList(e);
    return g ? g.replace(/\s+/g, ",") : "-";
  };
  VAL.supgrp = function (e) {
    var g = P.groupList(e);
    if (!g) return "-";
    return g.split(/\s+/).map(function (n) { return GROUPS[n] || n; }).join(",");
  };

  VAL.env = function (e, S, m) {
    var v = (e.env || []).join(" ");
    return v ? escapeStr(v, m) : "-";
  };
  VAL.exe = function (e, S, m) {
    return escapeStr(canSee(e, S) ? (e.exe || "-") : "-", m);
  };
  VAL.unit = function (e, S, m) { return escapeStr(e.unit || "-", m); };
  VAL.cgroup = function (e, S, m) { return escapeStr(P.cgroupText(e), m); };
  VAL.wchan = function (e, S, m) {
    var w = e.zombie ? "0" : (e.wchan || "0");
    if (!w || w === "0" || w === "zombie") return "-";
    return escapeStr(w, m);
  };
  VAL.tty = function (e, S, m) { return escapeStr(e.tty || "?", m); };
  VAL.tty4 = function (e) { return String(e.tty || "?"); };

  // ---- signals ------------------------------------------------------------
  VAL.blk = function () { return P.SIGMASKS.blk; };
  VAL.cgt = function () { return P.SIGMASKS.cgt; };
  VAL.ign = function () { return P.SIGMASKS.ign; };
  VAL.pnd = function () { return P.SIGMASKS.pnd; };

  // ---- times --------------------------------------------------------------
  var PRIORITY = 20, NICE = 0;
  VAL.nice = function () { return String(NICE); };
  VAL.pri = function () { return String(PRIORITY - 1); };
  VAL.priority = function () { return String(PRIORITY); };
  VAL.opri = function () { return String(PRIORITY + 60); };
  VAL.prifoo = function () { return String(PRIORITY - 20); };
  VAL.pribar = function () { return String(PRIORITY + 1); };
  VAL.pribaz = function () { return String(PRIORITY + 100); };
  VAL.priapi = function () { return String(-1 - PRIORITY); };

  function hhmmss(t) {
    var d = Math.floor(t / 86400); t -= d * 86400;
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return (d ? d + "-" : "") + two(h) + ":" + two(m) + ":" + two(s);
  }
  VAL.time = function (e) { return hhmmss(Math.floor(e.cpu)); };
  VAL.bsdtime = function (e) {
    var t = Math.floor(e.cpu);
    return pad(Math.floor(t / 60), 3) + ":" + two(t % 60);
  };
  VAL.times = function (e) { return String(Math.floor(e.cpu)); };
  VAL.etime = function (e) { return P.elapsed(e, false); };
  VAL.etimes = function (e) {
    return String(Math.max(0, Math.floor(P.uptime() - e.since)));
  };

  function withinDay(d) { return now().getTime() - d.getTime() < 86400000; }

  VAL.start = function (e) {
    var d = P.started(e);
    if (withinDay(d))
      return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + ":" +
             two(d.getUTCSeconds());
    return "  " + MON[d.getUTCMonth()] + " " + two(d.getUTCDate());
  };
  VAL.bsdstart = function (e) {
    var d = P.started(e), day = d.getUTCDate();
    if (withinDay(d))
      return " " + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes());
    return MON[d.getUTCMonth()] + " " + (day < 10 ? " " + day : day);
  };
  VAL.lstart = function (e) {
    var d = P.started(e);
    return DAY[d.getUTCDay()] + " " + MON[d.getUTCMonth()] + " " +
           pad(d.getUTCDate(), 2) + " " + two(d.getUTCHours()) + ":" +
           two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds()) + " " +
           d.getUTCFullYear();
  };
  VAL.stime = function (e) {
    var d = P.started(e), n = now();
    if (d.getUTCFullYear() !== n.getUTCFullYear()) return String(d.getUTCFullYear());
    if (d.getUTCMonth() !== n.getUTCMonth() || d.getUTCDate() !== n.getUTCDate())
      return MON[d.getUTCMonth()] + two(d.getUTCDate());
    return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes());
  };

  // ---- memory -------------------------------------------------------------
  VAL.vsz = function (e) { return String(e.vsz); };
  VAL.sz = function (e) { return String(Math.floor(e.vsz / 4)); };
  VAL.rss = function (e) { return String(e.rss); };
  // The model keeps a 1024 KB text segment, so data+stack is vsz-1024 and
  // the two add back up to vsz the way they do in /proc.
  VAL.size = function (e) { return String(e.vsz ? e.vsz - 1024 : 0); };
  VAL.drs = function (e) { return String(e.vsz ? e.vsz - 1024 : 0); };
  VAL.trs = function (e) { return e.vsz ? "1024" : "0"; };
  VAL.msize = function (e) { return String(e.vsz * 1024); };
  VAL.minflt = function (e) { return String(P.faults(e)[0]); };
  VAL.majflt = function (e) { return String(P.faults(e)[1]); };

  // ---- percentages --------------------------------------------------------
  VAL.pcpu = function (e) {
    var t = Math.floor(P.pcpu(e) * 10);
    if (t < 0) t = 0;
    if (t > 999) return String(Math.floor(t / 10));
    return Math.floor(t / 10) + "." + (t % 10);
  };
  VAL.pmem = function (e) {
    var t = Math.floor(P.pmem(e) * 10);
    if (t < 0) t = 0;
    if (t > 999) t = 999;
    return pad(Math.floor(t / 10), 2) + "." + (t % 10);
  };
  VAL.cp = function (e) { return String(Math.floor(P.pcpu(e) * 10)); };
  VAL.c = function (e) { return pad(Math.floor(P.pcpu(e) * 10), 2); };
  VAL.util = function (e) {
    var v = P.pcpu(e);
    if (v > 99.999) v = 99.999;
    if (v < 0) v = 0;
    return v.toFixed(3);
  };

  // ---- the columns procps uses to test its own renderer -------------------
  // They read lines_to_next_header, which is the row counter, so every row
  // of a header-only run gets the same one.
  VAL.tleft = function (e, S) {
    return ["tty7", "pts/9999", "iseries/vtty42", "ttySMX0", "3270/tty4"][uMod(S.lines, 5)];
  };
  VAL.tleft2 = function (e, S) {
    return ["tty7", "pts/9999", "ttySMX0", "3270/tty4"][uMod(S.lines, 4)];
  };
  VAL.tright = function (e, S) {
    return ["999-23:59:59", "99-23:59:59", "9-23:59:59", "59:59"][uMod(S.lines, 4)];
  };
  VAL.tright2 = function (e, S) {
    return ["999-23:59:59", "99-23:59:59", "9-23:59:59"][uMod(S.lines, 3)];
  };
  VAL.tunlim = function (e, S, m) {
    return escapeStr(["[123456789-12345] <defunct>", "ps", "123456789-123456"][uMod(S.lines, 3)], m);
  };
  VAL.tunlim2 = function (e, S, m) {
    return escapeStr(["[123456789-12345] <defunct>", "ps", "123456789-123456"][uMod(S.lines, 4)], m);
  };

  // A process we may not read shows a dash where its path would be, exactly
  // as it does on a real machine: that is somebody else's.
  function canSee(e, S) { return S.myUid === 0 || e.uid === S.myUid; }

  // ---- deferred -o/-O/--sort options --------------------------------------
  //
  // These are not parsed where they appear: sortformat.c saves them all and
  // parses them later, in argument order, so that `ps -o pid -o comm` and
  // `ps -o pid,comm` build the same list.

  // sf_node codes, exactly as sortformat.c numbers them.
  var SF_U_O = 1, SF_U_o = 2, SF_B_O = 3, SF_B_o = 4, SF_B_m = 5,
      SF_G_sort = 6, SF_G_format = 7;

  function catastrophic(msg) { throw new Error("ps: " + msg); }

  function sepOf(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === " " || c === "," || c === "\t" || c === "\n") return i;
    }
    return -1;
  }

  // do_one_spec(): one column from the table, or a macro expanded into the
  // columns it names -- always in the order they are written.
  function chainSpec(spec, override) {
    var e = COLS[spec];
    if (e) {
      var base = PIDMAX[spec] ? Math.max(PIDLEN, e[0].length) : e[1];
      var name = e[0], w = base;
      if (override !== null && override !== undefined) {
        w = Math.max(base, override.length);
        name = override;
      }
      return [{ spec: spec, name: name, w: w, j: e[2], val: e[3], aix: false }];
    }
    var m = MACROS[spec];
    if (m !== undefined) {
      var out = [];
      m.split(",").forEach(function (part) {
        var sub = chainSpec(part, override);
        if (!sub) catastrophic("macro column \"" + part + "\" is missing");
        out = out.concat(sub);
      });
      return out;
    }
    return null;
  }

  function oneSpec(name) { return chainSpec(name, null); }

  // format_parse()'s sanity pass.  The '\0' case only ever runs for an empty
  // string -- the do-while in C stops on the terminator without visiting it.
  function countList(s, improperMsg, emptyMsg) {
    if (s === "") return { err: improperMsg };
    var needItem = true, items = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === " " || c === "," || c === "\t" || c === "\n") {
        if (needItem) return { err: improperMsg };
        needItem = true;
      } else {
        if (needItem) items++;
        needItem = false;
      }
    }
    if (!items) return { err: emptyMsg };
    return { items: items, buf: needItem ? s.slice(0, -1) : s };
  }

  function aixFormatParse(sfn) {
    var s = sfn.sf, w = 0;

    // The sanity machine: only '%'-descriptors and the text between them,
    // and a descriptor letter may not be a space.
    var c = s.charAt(0); w = 1;
    if (c !== "%" && c !== " ") return "improper AIX field descriptor";
    for (;;) {
      if (c === "%") {
        c = s.charAt(w); w++;
        if (c && c !== " ") continue;
        return "missing AIX field descriptor";
      }
      if (!c) break;
      c = s.charAt(w); w++;
      if (c === "%") continue;
      if (c === " ") continue;
      if (c) continue;
      break;
    }

    var out = [];
    w = 0;
    for (;;) {
      if (s.charAt(w) === "%") {
        w++;
        if (s.charAt(w) === "%") return "missing AIX field descriptor";
        var ch = s.charAt(w); w++;
        var a = AIX[ch];
        if (!a) return "unknown AIX field descriptor";
        var node = chainSpec(a[0], a[1]);
        if (!node) return "AIX field descriptor processing bug";
        out = out.concat(node);
      } else {
        var len = 0;
        while (w + len < s.length && s.charAt(w + len) !== "%") len++;
        if (!len) break;
        out.push({ spec: "", name: s.substr(w, len), w: len, j: 0,
                   val: null, aix: true });
        w += len;
      }
    }
    sfn.fCooked = sfn.fCooked.concat(out);
    st.parsedFormat = 1;
    return null;
  }

  // A parse failure retries as an AIX format -- but only if the argument
  // looks like one: it has a '%', and is not %cpu, "%cpu ", "%cpu," or %m,
  // which are ordinary columns despite the '%' .
  function aixRetry(sfn, err) {
    var s = sfn.sf;
    if (s.indexOf("%") < 0) return err;
    if (s === "%cpu") return err;
    if (s.slice(0, 5) === "%cpu ") return err;
    if (s.slice(0, 5) === "%cpu,") return err;
    if (s.slice(0, 2) === "%m") return err;
    return aixFormatParse(sfn);
  }

  function formatParse(sfn) {
    var m = countList(sfn.sf, "improper format list", "empty format list");
    if (m.err) return aixRetry(sfn, m.err);
    var walk = m.buf, items = m.items;
    while (items--) {
      var sep = sepOf(walk);
      var item = (items && sep >= 0) ? walk.slice(0, sep) : walk;
      var equal = null, colon = null, at;
      at = item.indexOf("=");
      if (at >= 0) { equal = item.slice(at + 1); item = item.slice(0, at); }
      at = item.indexOf(":");
      if (at >= 0) {
        colon = item.slice(at + 1); item = item.slice(0, at);
        if (!/^[0-9]+$/.test(colon) || colon.charAt(0) === "0" ||
            colon === "" || parseInt(colon, 10) <= 0)
          return "column widths must be unsigned decimal numbers";
      }
      var fnode = chainSpec(item, equal);
      if (!fnode)
        return aixRetry(sfn, "unknown user-defined format specifier \"" + item + "\"");
      if (colon !== null) {
        if (fnode.length > 1)
          return "can not set width for a macro (multi-column) format specifier";
        fnode[0].w = parseInt(colon, 10);
      }
      sfn.fCooked = sfn.fCooked.concat(fnode);
      walk = sep >= 0 ? walk.slice(sep + 1) : null;
    }
    st.parsedFormat = 1;
    return null;
  }

  // -O wraps the user's columns in the default leading PID and a default
  // trailing STATE TTY TIME COMMAND.
  function oWrap(sfn, otype) {
    var trailer = otype === "b" ? "END_BSD" : "END_SYS5";
    sfn.fCooked = oneSpec("pid").concat(sfn.fCooked, oneSpec(trailer));
  }

  // do_one_sort_spec(): a leading '+' or '-' sets the direction.
  function doOneSortSpec(spec) {
    var rev = false;
    if (spec.charAt(0) === "-") { rev = true; spec = spec.slice(1); }
    else if (spec.charAt(0) === "+") { spec = spec.slice(1); }
    if (!COLS[spec]) return null;
    return { spec: spec, rev: rev };
  }

  function longSortParse(sfn) {
    var m = countList(sfn.sf, "improper sort list", "empty sort list");
    if (m.err) return m.err;
    var walk = m.buf, items = m.items;
    while (items--) {
      var sep = sepOf(walk);
      var item = sep >= 0 ? walk.slice(0, sep) : walk;
      var snode = doOneSortSpec(item);
      if (!snode) return "unknown sort specifier";
      sfn.sCooked.push(snode);
      walk = sep >= 0 ? walk.slice(sep + 1) : null;
    }
    st.parsedSort = 1;
    return null;
  }

  // BSD's `O` doubles as a sort option: a string of single letters, each an
  // index into shortsort_array, optionally prefixed with '+' or '-'.
  function verifyShortSort(arg) {
    var all = "CGJKMNPRSTUcfgjkmnoprstuvy+-", seen = {}, i;
    for (i = 0; i < arg.length; i++)
      if (all.indexOf(arg.charAt(i)) < 0) return "bad sorting code";
    for (i = 0; i < arg.length; i++) {
      var ch = arg.charAt(i), next = arg.charAt(i + 1);
      if (ch === "+" || ch === "-") {
        if (!next || next === "+" || next === "-") return "bad sorting code";
        continue;
      }
      if (ch === "P" && st.forestType) return "PPID sort and forest output conflict";
      if (seen[ch]) return "bad sorting code";
      seen[ch] = 1;
    }
    return null;
  }

  function shortSortParse(sfn) {
    var s = sfn.sf, dir = false, i = 0;
    for (;;) {
      if (i >= s.length) { st.parsedSort = 1; return null; }
      var ch = s.charAt(i);
      if (ch === "+") { dir = false; i++; continue; }
      if (ch === "-") { dir = true; i++; continue; }
      var spec = SHORTSORT[ch];
      if (!spec) return "unknown sort specifier";
      var snode = doOneSortSpec(spec);
      if (!snode) return "unknown sort specifier";
      snode.rev = dir;
      sfn.sCooked.push(snode);
      dir = false;
      i++;
    }
  }

  function parseOOption(sfn) {
    var err;
    switch (sfn.code) {
      case SF_U_o: case SF_G_format: case SF_B_o:
        err = formatParse(sfn);
        if (!err) st.parsedFormat = 1;
        break;
      case SF_U_O:
        if (st.parsedFormat) return "option -O can not follow other format options";
        err = formatParse(sfn);
        if (err) return err;
        st.parsedFormat = 1;
        oWrap(sfn, "u");
        break;
      case SF_B_O:
        if (st.haveGnuSort || st.parsedSort) err = "multiple sort options";
        else err = verifyShortSort(sfn.sf);
        if (!err) {
          err = shortSortParse(sfn);
          if (err) return err;
          st.parsedSort = 1;
          return null;
        }
        if (st.parsedFormat) {
          err = "option O is neither first format nor sort order";
          break;
        }
        if (!formatParse(sfn)) { st.parsedFormat = 1; oWrap(sfn, "b"); return null; }
        break;
      case SF_G_sort: case SF_B_m:
        if (st.parsedSort) err = "multiple sort options";
        else err = longSortParse(sfn);
        st.parsedSort = 1;
        break;
      default:
        catastrophic("please report this bug");
    }
    return err || null;
  }

  function deferSf(arg, code) {
    st.sf.unshift({ sf: arg, code: code, sCooked: [], fCooked: [] });
    if (code === SF_G_sort) st.haveGnuSort = 1;
  }

  // ---- building the default lists -----------------------------------------

  // do_one_spec() hands back a chain; every caller here passes a one-node
  // one, so splicing the whole array in is the same as linking the node.
  function fmtAddAfter(findme, putme) {
    var i = st.format.findIndex(function (n) { return n.name === findme; });
    if (i < 0) return false;
    st.format.splice.apply(st.format, [i + 1, 0].concat(putme));
    return true;
  }
  function fmtDelete(findme) {
    var i = st.format.findIndex(function (n) { return n.name === findme; });
    if (i < 0) return false;
    st.format.splice(i, 1);
    return true;
  }

  // generate_sysv_list(): the default column list, built backwards with
  // PUSH, so the result is the reverse of the order below.
  function generateSysvList() {
    var f = st.formatFlags, m = st.formatMods, t = st.threadFlags;
    function push(spec) {
      var node = oneSpec(spec);
      if (!node) catastrophic("macro column \"" + spec + "\" is missing");
      st.format = node.concat(st.format);
    }
    if ((m & FM_y) && !(f & FF_Ul)) return "modifier -y without format -l makes no sense";
    if (st.preferBsd) {
      push(f ? "cmd" : "args");
      push("bsdtime");
      if (!(f & FF_Ul)) push("stat");
    } else {
      push(f & FF_Uf ? "cmd" : "ucmd");
      push("time");
    }
    push("tname");
    if (f & FF_Uf) push("stime");
    if (m & FM_F) {
      if (!(m & FM_P)) push("psr");
      if (!((f & FF_Ul) && (m & FM_y))) push("rss");
    }
    if (f & FF_Ul) push("wchan");
    if ((m & FM_F) || (f & FF_Ul)) push("sz");
    if (f & FF_Ul) {
      if (m & FM_y) push("rss");
      else push("addr_1");
    }
    if (m & FM_c) { push("pri"); push("class"); }
    else if (f & FF_Ul) { push("ni"); push("opri"); }
    if ((t & TF_U_L) && (f & FF_Uf)) push("nlwp");
    if ((f & (FF_Uf | FF_Ul)) && !(m & FM_c)) push("c");
    if (m & FM_P) push("psr");
    if (t & TF_U_L) push("lwp");
    if (m & FM_j) { push("sid"); push("pgid"); }
    if (f & (FF_Uf | FF_Ul)) push("ppid");
    if (t & TF_U_T) push("spid");
    push("pid");
    if (f & FF_Uf) push("uid_hack");
    else if (f & FF_Ul) push("uid");
    if (f & FF_Ul) { push("s"); if (!(m & FM_y)) push("f"); }
    if (m & FM_M) push("label");
    return null;
  }

  function processSfOptions() {
    var i, err;
    // parse_O_option() recurses to the end of the list first, which walks
    // the deferred options in argument order.
    for (i = st.sf.length - 1; i >= 0; i--) {
      err = parseOOption(st.sf[i]);
      if (err) return err;
    }
    // Merge.  Each option's columns were kept reversed internally, so the
    // two reversals cancel and the result is simply argument order.
    var fmt = [], srt = [];
    for (i = st.sf.length - 1; i >= 0; i--) {
      fmt = fmt.concat(st.sf[i].fCooked);
      srt = srt.concat(st.sf[i].sCooked);
    }
    st.format = fmt;
    st.sortList = srt;

    if (st.sortList.length && (st.threadFlags & TF_no_sort))
      return "tell <procps@freelists.org> what you expected";

    if (!st.formatFlags && !st.formatMods && !st.format.length && st.env.PS_FORMAT) {
      var sfn = { sf: String(st.env.PS_FORMAT), fCooked: [], sCooked: [], code: SF_G_format };
      if (st.threadFlags & TF_must_use)
        return "tell <procps@freelists.org> what you want (-L/-T, -m/m/H, and $PS_FORMAT)";
      var e2 = formatParse(sfn);
      if (!e2) { st.format = st.format.concat(sfn.fCooked); return null; }
      st.err += "warning: $PS_FORMAT ignored. (" + e2 + ")\n";
    }

    if (st.format.length) {
      if (st.formatFlags) return "conflicting format options";
      if (st.formatMods) return "can not use output modifiers with user-defined output";
      if (st.threadFlags & TF_must_use)
        return "-L/-T with H/m/-m and -o/-O/o/O is nonsense";
      return null;
    }

    var spec = null, f = st.formatFlags;
    switch (f) {
      case 0: spec = null; break;
      case FF_Uf | FF_Ul: spec = st.sysvFlFormat; break;
      case FF_Uf: spec = st.sysvFFormat; break;
      case FF_Ul: spec = st.sysvLFormat; break;
      case FF_Uj: spec = st.sysvJFormat; break;
      case FF_Uj | FF_Ul: spec = "RD_lj"; break;
      case FF_Uj | FF_Uf: spec = "RD_fj"; break;
      case FF_Bj: spec = st.bsdJFormat; break;
      case FF_Bl: spec = st.bsdLFormat; break;
      case FF_Bs: spec = st.bsdSFormat; break;
      case FF_Bu: spec = st.bsdUFormat; break;
      case FF_Bv: spec = st.bsdVFormat; break;
      case FF_LX: spec = "OL_X"; break;
      case FF_Lm: spec = "OL_m"; break;
      case FF_Fc: spec = "FLASK_context"; break;
      default: return "conflicting format options";
    }
    if (!spec) return generateSysvList();
    var chain = oneSpec(spec);
    if (!chain) catastrophic("macro column \"" + spec + "\" is missing");
    st.format = st.format.concat(chain);

    // Modifiers that patch a built-in list rather than generate one.
    if (st.formatMods & FM_j) {
      var fn = oneSpec("pgid");
      if (!fmtAddAfter("PPID", fn) && !fmtAddAfter("PID", fn))
        catastrophic("internal error: no PID or PPID for -j option");
      fn = oneSpec("sid");
      if (!fmtAddAfter("PGID", fn)) return "lost my PGID";
    }
    if (st.formatMods & FM_y) {
      fmtDelete("F");
      fn = oneSpec("rss");
      if (fmtAddAfter("ADDR", fn)) fmtDelete("ADDR");
    }
    if (st.formatMods & FM_c) {
      fmtDelete("%CPU"); fmtDelete("CPU"); fmtDelete("CP"); fmtDelete("C");
      fmtDelete("NI");
      fn = oneSpec("class");
      if (!fmtAddAfter("PRI", fn))
        catastrophic("internal error: no PRI for -c option");
      fmtDelete("PRI");
      fn = oneSpec("pri");
      if (!fmtAddAfter("CLS", fn)) return "lost my CLS";
    }
    if (st.threadFlags & TF_U_T) {
      fn = oneSpec("spid");
      if (!fmtAddAfter("PID", fn) && (st.threadFlags & TF_must_use))
        return "-T with H/-m/m but no PID for SPID to follow";
    }
    if (st.threadFlags & TF_U_L) {
      fn = oneSpec("lwp");
      var placed = fmtAddAfter("SID", fn) || fmtAddAfter("SESS", fn) ||
                   fmtAddAfter("PGID", fn) || fmtAddAfter("PGRP", fn) ||
                   fmtAddAfter("PPID", fn) || fmtAddAfter("PID", fn);
      if (!placed && (st.threadFlags & TF_must_use))
        return "-L with H/-m/m but no PID/PGID/SID/SESS for NLWP to follow";
      fmtAddAfter("%CPU", oneSpec("nlwp"));
    }
    if (st.formatMods & FM_M) st.format = oneSpec("label").concat(st.format);
    return null;
  }

  // ---- option parsing ------------------------------------------------------
  //
  // parser.c.  An argument is tried as SysV first; if anything at all goes
  // wrong the whole parse is thrown away and retried as BSD.  The first
  // pass's message is the one printed -- unless the BSD pass gets all the
  // way through, in which case its success is what counts.

  var ARG_BSD = 1, ARG_PID = 2, ARG_SESS = 3, ARG_SYSV = 4, ARG_PGRP = 5,
      ARG_GNU = 6, ARG_END = 7, ARG_FAIL = 8;

  var FF_Uf = 0x0001, FF_Uj = 0x0002, FF_Ul = 0x0004, FF_Bj = 0x0008,
      FF_Bl = 0x0010, FF_Bs = 0x0020, FF_Bu = 0x0040, FF_Bv = 0x0080,
      FF_LX = 0x0100, FF_Lm = 0x0200, FF_Fc = 0x0400;
  var FM_c = 0x0001, FM_j = 0x0002, FM_y = 0x0004, FM_P = 0x0010,
      FM_M = 0x0020, FM_F = 0x0080;
  var TF_B_H = 0x0001, TF_B_m = 0x0002, TF_U_m = 0x0004, TF_U_T = 0x0008,
      TF_U_L = 0x0010, TF_show_proc = 0x0100, TF_show_task = 0x0200,
      TF_show_both = 0x0400, TF_loose_tasks = 0x0800, TF_no_sort = 0x1000,
      TF_no_forest = 0x2000, TF_must_use = 0x4000;
  var SS_B_x = 0x01, SS_B_g = 0x02, SS_U_d = 0x04, SS_U_a = 0x08, SS_B_a = 0x10;
  var PER_BROKEN_o = 0x0001, PER_BSD_h = 0x0002, PER_BSD_m = 0x0004,
      PER_IRIX_l = 0x0008, PER_FORCE_BSD = 0x0010, PER_GOOD_o = 0x0020,
      PER_OLD_m = 0x0040, PER_NO_DEFAULT_g = 0x0080, PER_ZAP_ADDR = 0x0100,
      PER_SANE_USER = 0x0200, PER_HPUX_x = 0x0400, PER_SVR4_x = 0x0800;
  var SEL_RUID = 1, SEL_EUID = 2, SEL_RGID = 5, SEL_EGID = 6, SEL_PGRP = 9,
      SEL_PID = 10, SEL_TTY = 11, SEL_SESS = 12, SEL_COMM = 13, SEL_PPID = 14,
      SEL_PID_QUICK = 15, SEL_PID_TRY_QUICK = 16;

  // The one run's state.  resetAll() takes it back to what reset_global(),
  // reset_parser() and reset_sortformat() leave behind.
  var st = null;

  function mkState(sh) {
    st = {
      sh: sh, env: sh && sh.env ? sh.env : {},
      argv: ["ps"], thisarg: 0, fpos: 0,
      forceBsd: false, preferBsd: false, personality: 0,
      formatFlags: 0, formatMods: 0, threadFlags: 0, simpleSelect: 0,
      negate: false, runningOnly: false, allProcesses: false,
      headerType: HEAD_SINGLE, headerGap: -1, linesToNext: 1,
      forestType: 0, wCount: 0, screenCols: 80, screenRows: 25,
      signalNames: false, userNum: false, wchanNum: false,
      bsdC: false, bsdE: false, unixF: false, includeDead: false,
      dateFormat: null, selectBits: 0xaa00, processes: [], quickPids: null,
      selection: [], sf: [], format: [], sortList: [],
      haveGnuSort: false, parsedSort: false, parsedFormat: false,
      out: "", err: "", code: 0,
      myUid: 0, myPid: 1, cachedTty: "",
      wideSignals: false, activeCols: 0, outbuf: OUTBUF,
      didStuff: false, forestPrefix: "", sysvFFormat: null,
      sysvLFormat: null, sysvFlFormat: null, sysvJFormat: null,
      bsdJFormat: "OL_j", bsdLFormat: "OL_l", bsdSFormat: "OL_s",
      bsdUFormat: "OL_u", bsdVFormat: "OL_v"
    };
    // UID is what login(1) put in the environment; before anyone has logged
    // in it is whoever the shell thinks it is (nobody, uid 1000).
    st.myUid = (st.env.UID !== undefined && st.env.UID !== "")
      ? num(st.env.UID, 0)
      : (st.sh && st.sh.isRoot ? 0 : 1000);
    st.myPid = (st.sh && st.sh.pid) ? st.sh.pid
             : num(st.env.$$ || st.env.BASHPID || st.env.PID, 1);
    resetAll();
    return st;
  }

  function num(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }

  function setScreenSize() {
    // The console itself is LW.TEXT_COLS by LW.TEXT_ROWS; an environment
    // variable overrides it the way the TIOCGWINSZ ioctl would.
    var c = num(st.env.COLUMNS, 0), r = num(st.env.LINES, 0);
    st.screenCols = c > 0 ? c : (LW.TEXT_COLS || 80);
    st.screenRows = r > 0 ? r : (LW.TEXT_ROWS || 25);
  }

  function resetAll() {
    st.selection = [];
    st.sf = []; st.format = []; st.sortList = [];
    st.haveGnuSort = false; st.parsedSort = false; st.parsedFormat = false;
    st.formatFlags = 0; st.formatMods = 0; st.threadFlags = 0;
    st.simpleSelect = 0; st.negate = false; st.runningOnly = false;
    st.allProcesses = false;
    st.headerType = HEAD_SINGLE; st.headerGap = -1; st.linesToNext = 1;
    st.forestType = 0; st.signalNames = false;
    st.quickPids = null;
    st.userNum = false; st.wchanNum = false;
    st.bsdC = false; st.bsdE = false; st.unixF = false;
    st.includeDead = false; st.dateFormat = null;
    st.wCount = 0; st.thisarg = 0; st.fpos = 0;
    st.forceBsd = false; st.preferBsd = false;
    // set_personality(): without PS_PERSONALITY or CMD_ENV we are "unknown",
    // which means personality 0, the old Linux BSD format names, and SysV
    // format generation left to generate_sysv_list().
    st.personality = 0;
    st.preferBsd = false;
    st.bsdJFormat = "OL_j"; st.bsdLFormat = "OL_l"; st.bsdSFormat = "OL_s";
    st.bsdUFormat = "OL_u"; st.bsdVFormat = "OL_v";
    st.sysvFFormat = null; st.sysvLFormat = null;
    st.sysvFlFormat = null; st.sysvJFormat = null;
    st.cachedTty = ttyKey(shellTty());
    setScreenSize();
  }

  function shellTty() {
    var sh = st.sh || {};
    return sh.tty || (LW.VTs ? "tty" + LW.VTs.activeVt() : "tty1");
  }

  // The kernel names a tty by its device number; ps compares and prints the
  // name under /dev.  Anything without a controlling terminal is 0/"".
  function ttyKey(name) {
    if (!name || name === "?" || name === "-" || name === "??") return "";
    if (name.slice(0, 5) === "/dev/") name = name.slice(5);
    return name;
  }

  function ttyDevice(name) {
    name = ttyKey(name);
    return name || "";
  }

  // ---- selecting -----------------------------------------------------------

  function getOptArg() {
    var rest = st.argv[st.thisarg].slice(st.fpos + 1);
    if (rest) return rest;
    if (st.thisarg + 2 > st.argv.length) return null;
    if (st.argv[st.thisarg + 1] === "") return null;
    st.thisarg++;
    return st.argv[st.thisarg];
  }

  function pushSel(type, vals) {
    if (vals && vals.length) st.selection.push({ type: type, vals: vals });
    return null;
  }

  function hexVal(c) {
    if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
    if (c >= "a" && c <= "f") return c.charCodeAt(0) - 87;
    if (c >= "A" && c <= "F") return c.charCodeAt(0) - 55;
    return -1;
  }

  // strtoul(str, &endp, 0): whitespace, an optional sign, an optional 0x
  // or octal prefix, then digits.  `rest` is what was left over; when
  // nothing converted it is the whole string, because endp goes back to the
  // start rather than to where the scan stopped.
  function basetou(str) {
    var i = 0, n = str.length, val = 0, digits = 0, neg = false, base = 10;
    while (i < n && " \t\n\r\f\v".indexOf(str.charAt(i)) >= 0) i++;
    if (i < n && (str.charAt(i) === "+" || str.charAt(i) === "-")) {
      neg = str.charAt(i) === "-"; i++;
    }
    if (str.charAt(i) === "0" && (str.charAt(i + 1) === "x" || str.charAt(i + 1) === "X")) {
      if (hexVal(str.charAt(i + 2)) >= 0) { base = 16; i += 2; }
      else base = 8;
    } else if (str.charAt(i) === "0") base = 8;
    while (i < n) {
      var d = hexVal(str.charAt(i));
      if (d < 0 || d >= base) break;
      val = val * base + d; i++; digits++;
    }
    return { val: val, neg: neg, rest: str.slice(digits ? i : 0) };
  }

  function parsePid(str) {
    var r = basetou(str);
    if (r.rest !== "") return { e: "process ID list syntax error" };
    var n = r.neg ? (r.val === 0 ? 0 : 4294967296 + 1) : r.val;
    if (n < 1 || n > 0x7fffffff) return { e: "process ID out of range" };
    return { v: n };
  }

  // /etc/passwd and /etc/group, read once.  `-u root` and `-G sudo` have to
  // resolve the same names the shell does.
  var PASSWD = null, GRNAMES = null;
  function passwdTable() {
    if (PASSWD) return PASSWD;
    PASSWD = {};
    String(LW.VFS.readFile("/etc/passwd") || "").split("\n").forEach(function (l) {
      var p = l.split(":");
      if (p.length > 2) PASSWD[p[0]] = parseInt(p[2], 10);
    });
    return PASSWD;
  }
  function groupTable() {
    if (GRNAMES) return GRNAMES;
    GRNAMES = {};
    String(LW.VFS.readFile("/etc/group") || "").split("\n").forEach(function (l) {
      var p = l.split(":");
      if (p.length > 2) GRNAMES[p[0]] = parseInt(p[2], 10);
    });
    return GRNAMES;
  }

  function parseUid(str) {
    var r = basetou(str), n;
    if (r.rest === "") n = r.neg ? (r.val === 0 ? 0 : 1e18) : r.val;
    else {
      n = passwdTable()[str];
      if (n === undefined) {
        if (!st.negate) return { e: "user name does not exist" };
        n = 4294967295;
      }
    }
    if (!st.negate && n > 0xfffffffe) return { e: "user ID out of range" };
    return { v: n };
  }

  function parseGid(str) {
    var r = basetou(str), n;
    if (r.rest === "") n = r.neg ? (r.val === 0 ? 0 : 1e18) : r.val;
    else {
      n = groupTable()[str];
      if (n === undefined) {
        if (!st.negate) return { e: "group name does not exist" };
        n = 4294967295;
      }
    }
    if (!st.negate && n > 0xfffffffe) return { e: "group ID out of range" };
    return { v: n };
  }

  // parse_tty(): try the path, then the five ways of shortening it.  A bare
  // "-" or "?" is the no-tty case, and a lone character that happens to name
  // a file in the current directory is the no-tty case too.
  function parseTty(str) {
    var V = LW.VFS, cand, i, node;
    if (str.charAt(0) === "/") {
      node = V.getNode(str);
      if (!node) return { e: "TTY could not be found" };
      return { v: ttyKey(str) || "0" };
    }
    cand = ["/dev/pts/" + str, "/dev/" + str, "/dev/tty" + str,
            "/dev/pty" + str, "/dev/" + str + "nsole"];
    for (i = 0; i < cand.length; i++) {
      if (V.getNode(cand[i])) return { v: ttyKey(cand[i]) };
    }
    if (str === "-" || str === "?") return { v: "" };
    if (str.length === 1 && V.getNode(str)) return { v: "" };
    return { e: "TTY could not be found" };
  }

  function parseList(arg, parseFn) {
    var needItem = true, items = 0, i, c;
    if (arg === "") return { e: "improper list" };
    for (i = 0; i < arg.length; i++) {
      c = arg.charAt(i);
      if (c === " " || c === "," || c === "\t") {
        if (needItem) return { e: "improper list" };
        needItem = true;
      } else {
        if (needItem) items++;
        needItem = false;
      }
    }
    if (needItem) return { e: "improper list" };
    var out = [], walk = arg;
    while (items--) {
      var sep = -1;
      for (i = 0; i < walk.length; i++) {
        c = walk.charAt(i);
        if (c === " " || c === "," || c === "\t") { sep = i; break; }
      }
      var item = sep >= 0 ? walk.slice(0, sep) : walk;
      var r = parseFn(item);
      if (r.e !== undefined) return r;
      out.push(r.v);
      walk = sep >= 0 ? walk.slice(sep + 1) : null;
    }
    return { v: out };
  }

  // ---- the three syntaxes --------------------------------------------------

  function exclusive(word) {
    if (st.argv.length !== 2 || st.argv[1] !== word)
      return "the option is exclusive: " + word;
    return null;
  }

  // A selection option that took an argument: parse its list, then hang it
  // on the selection list.
  function selParse(type, arg, fn) {
    var r = parseList(arg, fn);
    if (r.e) return r.e;
    return pushSel(type, r.v);
  }

  function parseSysv() {
    var a = st.argv[st.thisarg], arg, err;
    for (var pos = 1; pos < a.length; pos++) {
      st.fpos = pos;
      var ch = a.charAt(pos);
      switch (ch) {
        case "A": st.allProcesses = true; break;
        case "C":
          arg = getOptArg();
          if (!arg) return "list of command names must follow -C";
          return selParse(SEL_COMM, arg, function (s) { return { v: s }; });
        case "D":
          arg = getOptArg();
          if (!arg) return "date format must follow -D";
          st.dateFormat = arg;
          break;
        case "F":
          st.formatMods |= FM_F; st.formatFlags |= FF_Uf; st.unixF = true;
          break;
        case "G":
          arg = getOptArg();
          if (!arg) return "list of real groups must follow -G";
          return selParse(SEL_RGID, arg, parseGid);
        case "H": st.forestType = "u"; break;
        case "L": st.threadFlags |= TF_U_L; break;
        case "M": st.formatMods |= FM_M; break;
        case "N": st.negate = true; break;
        case "O":
          arg = getOptArg();
          if (!arg) return "format or sort specification must follow -O";
          deferSf(arg, SF_U_O);
          return null;
        case "P": st.formatMods |= FM_P; break;
        case "T": st.threadFlags |= TF_U_T; break;
        case "U":
          arg = getOptArg();
          if (!arg) return "list of real users must follow -U";
          return selParse(SEL_RUID, arg, parseUid);
        case "V":
          err = exclusive("-V");
          if (err) return err;
          st.out += verLine() + "\n";
          throw { psExit: 1, code: 0 };
        case "Z": st.formatMods |= FM_M; break;
        case "a": st.simpleSelect |= SS_U_a; break;
        case "c": st.formatMods |= FM_c; break;
        case "d": st.simpleSelect |= SS_U_d; break;
        case "e": st.allProcesses = true; break;
        case "f": st.formatFlags |= FF_Uf; st.unixF = true; break;
        case "g":
          arg = getOptArg();
          if (!arg)
            return "list of session leaders OR effective group names must follow -g";
          err = selParse(SEL_SESS, arg, parsePid);
          if (!err) return err;
          err = selParse(SEL_EGID, arg, parseGid);
          if (!err) return err;
          return "list of session leaders OR effective group IDs was invalid";
        case "j":
          if (st.sysvJFormat) st.formatFlags |= FF_Uj;
          else st.formatMods |= FM_j;
          break;
        case "l": st.formatFlags |= FF_Ul; break;
        case "m": st.threadFlags |= TF_U_m; break;
        case "o":
          arg = getOptArg();
          if (!arg) return "format specification must follow -o";
          deferSf(arg, SF_U_o);
          return null;
        case "p":
          arg = getOptArg();
          if (!arg) return "list of process IDs must follow -p";
          return selParse(SEL_PID_TRY_QUICK, arg, parsePid);
        case "q":
          arg = getOptArg();
          if (!arg) return "List of process IDs must follow -q.";
          return selParse(SEL_PID_QUICK, arg, parsePid);
        case "s":
          arg = getOptArg();
          if (!arg) return "list of session IDs must follow -s";
          return selParse(SEL_SESS, arg, parsePid);
        case "t":
          arg = getOptArg();
          if (!arg) return "list of terminals (pty, tty...) must follow -t";
          return selParse(SEL_TTY, arg, parseTty);
        case "u":
          arg = getOptArg();
          if (!arg) return "list of users must follow -u";
          return selParse(SEL_EUID, arg, parseUid);
        case "w": st.wCount++; break;
        case "x":
          if (st.personality & PER_SVR4_x) { st.formatMods |= FM_y; break; }
          if (st.personality & PER_HPUX_x) { st.wCount += 2; st.unixF = true; break; }
          return "must set personality to get -x option";
        case "y": st.formatMods |= FM_y; break;
        case "-": return "embedded '-' among SysV options makes no sense";
        default: return "unsupported SysV option";
      }
    }
    return null;
  }

  function parseBsd() {
    var a = st.argv[st.thisarg], start, arg, err;
    if (a.charAt(0) === "-") {
      if (!st.forceBsd) return "cannot happen - problem #1";
      start = 1;
    } else {
      start = 0;
      if (st.personality & PER_FORCE_BSD) {
        if (!st.forceBsd) return "cannot happen - problem #2";
      } else {
        if (st.forceBsd) return "second chance parse failed, not BSD or SysV";
      }
    }
    for (var pos = start; pos < a.length; pos++) {
      st.fpos = pos;
      var ch = a.charAt(pos);
      if (ch >= "0" && ch <= "9")
        return selParse(SEL_PID, a.slice(pos), parsePid);
      switch (ch) {
        case "H": st.threadFlags |= TF_B_H; break;
        case "L":
          err = exclusive("L");
          if (err) return err;
          st.out += (HELP.psSpec || []).join("\n") + "\n";
          throw { psExit: 1, code: 0 };
        case "M": st.threadFlags |= TF_B_m; break;
        case "O":
          arg = getOptArg();
          if (!arg) return "format or sort specification must follow O";
          deferSf(arg, SF_B_O);
          return null;
        case "S": st.includeDead = true; break;
        case "T": return pushSel(SEL_TTY, [st.cachedTty]);
        case "U":
          arg = getOptArg();
          if (!arg) return "list of users must follow U";
          return selParse(SEL_EUID, arg, parseUid);
        case "V":
          err = exclusive("V");
          if (err) return err;
          st.out += verLine() + "\n";
          throw { psExit: 1, code: 0 };
        case "W": return "obsolete W option not supported (you have a /dev/drum?)";
        case "X": st.formatFlags |= FF_LX; break;
        case "Z": st.formatMods |= FM_M; break;
        case "a": st.simpleSelect |= SS_B_a; break;
        case "c": st.bsdC = true; break;
        case "e": st.bsdE = true; break;
        case "f": st.forestType = "b"; break;
        case "g": st.simpleSelect |= SS_B_g; break;
        case "h":
          if (st.headerType) return "only one heading option may be specified";
          st.headerType = (st.personality & PER_BSD_h) ? HEAD_MULTI : HEAD_NONE;
          break;
        case "j": st.formatFlags |= FF_Bj; break;
        case "k":
          arg = getOptArg();
          if (!arg) return "long sort specification must follow 'k'";
          deferSf(arg, SF_G_sort);
          return null;
        case "l": st.formatFlags |= FF_Bl; break;
        case "m":
          if (st.personality & PER_OLD_m) { st.formatFlags |= FF_Lm; break; }
          if (st.personality & PER_BSD_m) { deferSf("pmem", SF_B_m); break; }
          st.threadFlags |= TF_B_m;
          break;
        case "n": st.wchanNum = true; st.userNum = true; break;
        case "o":
          arg = getOptArg();
          if (!arg) return "format specification must follow o";
          deferSf(arg, SF_B_o);
          return null;
        case "p":
          arg = getOptArg();
          if (!arg) return "list of process IDs must follow p";
          return selParse(SEL_PID_TRY_QUICK, arg, parsePid);
        case "q":
          arg = getOptArg();
          if (!arg) return "List of process IDs must follow q.";
          return selParse(SEL_PID_QUICK, arg, parsePid);
        case "r": st.runningOnly = true; break;
        case "s": st.formatFlags |= FF_Bs; break;
        case "t":
          arg = getOptArg();
          if (!arg) return pushSel(SEL_TTY, [st.cachedTty]);
          return selParse(SEL_TTY, arg, parseTty);
        case "u": st.formatFlags |= FF_Bu; break;
        case "v": st.formatFlags |= FF_Bv; break;
        case "w": st.wCount++; break;
        case "x": st.simpleSelect |= SS_B_x; break;
        case "-": return "embedded '-' among BSD options makes no sense";
        default: return "unsupported option (BSD syntax)";
      }
    }
    return null;
  }

  function verLine() {
    return (VER.ps && VER.ps[0]) || "ps from procps-ng 4.0.5";
  }

  // Long options.  The name stops at the first ':' or '=', which is also
  // where the argument begins; otherwise the argument is the next argv.
  // The second parameter is everything left after the name, which is what
  // an option that takes no argument complains about.
  var GNU = {
    Group: selOpt(SEL_RGID, parseGid, "list of real groups must follow --Group"),
    User: selOpt(SEL_RUID, parseUid, "list of real users must follow --User"),
    cols: sizeOpt, width: sizeOpt, columns: sizeOpt,
    cumulative: noArg("option --cumulative does not take an argument",
                       function () { st.includeDead = true; }),
    "date-format": function (a) {
      if (!a) return "date format must follow --date-format";
      st.dateFormat = a; return null;
    },
    deselect: noArg("option --deselect does not take an argument",
                     function () { st.negate = true; }),
    "no-header": noHead, "no-headers": noHead, "no-heading": noHead,
    "no-headings": noHead, noheader: noHead, noheaders: noHead,
    noheading: noHead, noheadings: noHead,
    header: headOpt, headers: headOpt, heading: headOpt, headings: headOpt,
    forest: noArg("option --forest does not take an argument",
                   function () { st.forestType = "g"; }),
    format: function (a) {
      if (!a) return "format specification must follow --format";
      deferSf(a, SF_G_format); return null;
    },
    group: selOpt(SEL_EGID, parseGid, "list of effective groups must follow --group"),
    info: function () {
      var e = exclusive("--info");
      if (e) return e;
      selfInfo();
      throw { psExit: 1, code: 0 };
    },
    rows: rowOpt, lines: rowOpt,
    pid: selOpt(SEL_PID_TRY_QUICK, parsePid, "list of process IDs must follow --pid"),
    ppid: selOpt(SEL_PPID, parsePid, "list of process IDs must follow --ppid"),
    "quick-pid": selOpt(SEL_PID_QUICK, parsePid, "List of process IDs must follow --quick-pid."),
    sid: selOpt(SEL_SESS, parsePid, "some sid thing(s) must follow --sid"),
    signames: function () { st.signalNames = true; return null; },
    sort: function (a) {
      if (!a) return "long sort specification must follow --sort";
      deferSf(a, SF_G_sort); return null;
    },
    tty: selOpt(SEL_TTY, parseTty, "list of ttys must follow --tty"),
    user: selOpt(SEL_EUID, parseUid, "list of effective users must follow --user"),
    version: function () {
      var e = exclusive("--version");
      if (e) return e;
      st.out += verLine() + "\n";
      throw { psExit: 1, code: 0 };
    },
    context: function () { st.formatFlags |= FF_Fc; return null; }
  };
  // Options that take no value must not pull the next word off the line:
  // `ps --heading x` has to see the `x`.
  ["header", "headers", "heading", "headings", "no-header", "no-headers",
   "no-heading", "no-headings", "noheader", "noheaders", "noheading",
   "noheadings", "signames", "info", "version", "context"]
    .forEach(function (k) { GNU[k].noGrab = true; });

  // An option that takes an argument, whose only other job is to hang the
  // parsed list on the selection list -- or to complain it got nothing.
  function selOpt(type, fn, msg) {
    return function (a) {
      if (!a) return msg;
      return selParse(type, a, fn);
    };
  }

  function noArg(msg, apply) {
    var f = function (a, leftover) {
      if (leftover) return msg;
      apply();
      return null;
    };
    f.noGrab = true;
    return f;
  }

  // grab_gnu_arg(): the value is either glued on with '=' / ':' or the next
  // word on the command line, and an empty one is no argument at all.
  function grabGnu(rest) {
    if (rest) return rest.slice(1) || null;
    if (st.thisarg + 2 <= st.argv.length && st.argv[st.thisarg + 1] !== "") {
      st.thisarg++;
      return st.argv[st.thisarg];
    }
    return null;
  }
  function noHead(a, leftover) {
    if (leftover) return "option --no-heading does not take an argument";
    if (st.headerType) return "only one heading option may be specified";
    st.headerType = HEAD_NONE;
    return null;
  }
  function headOpt(a, leftover) {
    if (leftover) return "option --heading does not take an argument";
    if (st.headerType) return "only one heading option may be specified";
    st.headerType = HEAD_MULTI;
    return null;
  }
  function sizeOpt(a) {
    if (a && /^[0-9]+$/.test(a)) {
      var t = parseInt(a, 10);
      if (t > 0 && t < 2000000000) { st.screenCols = t; return null; }
    }
    return "number of columns must follow --cols, --width, or --columns";
  }
  function rowOpt(a) {
    if (a && /^[0-9]+$/.test(a)) {
      var t = parseInt(a, 10);
      if (t > 0 && t < 2000000000) { st.screenRows = t; return null; }
    }
    return "number of rows must follow --rows or --lines";
  }

  function parseGnu() {
    var a = st.argv[st.thisarg];
    var s = a.slice(2), sl = 0;
    while (sl < s.length && s.charAt(sl) !== ":" && s.charAt(sl) !== "=") sl++;
    if (sl > 15) return "unknown gnu long option";
    var name = s.slice(0, sl), rest = s.slice(sl), arg = null;
    var fn = GNU[name];
    if (!fn) {
      if (name === "help") { doHelp(grabGnu(rest), 0); throw { psExit: 1, code: 0 }; }
      return "unknown gnu long option";
    }
    // Only handlers that ask for a value pull the next word off the command
    // line; grab_gnu_arg() is what C calls, and --heading never calls it.
    if (rest) arg = rest.slice(1) || null;
    else if (!fn.noGrab && st.thisarg + 2 <= st.argv.length &&
             st.argv[st.thisarg + 1] !== "") {
      st.thisarg++;
      arg = st.argv[st.thisarg];
    }
    return fn(arg, rest);
  }

  // ---- the three phases ----------------------------------------------------

  function argType(str) {
    var c = str.charAt(0);
    if (c >= "a" && c <= "z") return ARG_BSD;
    if (c >= "A" && c <= "Z") return ARG_BSD;
    if (c >= "0" && c <= "9") return ARG_PID;
    if (c === "+") return ARG_SESS;
    if (c !== "-") return ARG_FAIL;
    c = str.charAt(1);
    if (c >= "a" && c <= "z") return ARG_SYSV;
    if (c >= "A" && c <= "Z") return ARG_SYSV;
    if (c >= "0" && c <= "9") return ARG_PGRP;
    if (c !== "-") return ARG_FAIL;
    c = str.charAt(2);
    if (c >= "a" && c <= "z") return ARG_GNU;
    if (c >= "A" && c <= "Z") return ARG_GNU;
    if (c === "") return ARG_END;
    return ARG_FAIL;
  }

  function parseTrailingPids() {
    var pid = [], grp = [], sid = [], i, data, first, r;
    for (i = st.thisarg; i < st.argv.length; i++) {
      data = st.argv[i];
      first = data.charAt(0);
      r = parsePid(first === "-" || first === "+" ? data.slice(1) : data);
      if (r.e) return r.e;
      if (first === "-") grp.push(r.v);
      else if (first === "+") sid.push(r.v);
      else pid.push(r.v);
    }
    st.thisarg = st.argv.length - 1;
    pushSel(SEL_PID, pid);
    pushSel(SEL_PGRP, grp);
    pushSel(SEL_SESS, sid);
    return null;
  }

  function parseAllOptions() {
    var err = null;
    while (++st.thisarg < st.argv.length) {
      var at = argType(st.argv[st.thisarg]);
      switch (at) {
        case ARG_GNU: err = parseGnu(); break;
        case ARG_SYSV:
          // force_bsd skips the SysV parser but also skips the "way bad"
          // check below: the C label sits inside the if-body, so only an
          // argument classified ARG_BSD ever reaches it.
          if (!st.forceBsd) { err = parseSysv(); break; }
          st.preferBsd = true;
          err = parseBsd();
          break;
        case ARG_BSD:
          if (st.forceBsd && !(st.personality & PER_FORCE_BSD)) return "way bad";
          st.preferBsd = true;
          err = parseBsd();
          break;
        case ARG_PGRP:
        case ARG_SESS:
        case ARG_PID:
          st.preferBsd = true;
          err = parseTrailingPids();
          break;
        default: return "garbage option";
      }
      if (err) return err;
    }
    return null;
  }

  function chooseDimensions() {
    if (st.wCount && st.screenCols < 132) st.screenCols = 132;
    if (st.wCount > 1) st.screenCols = OUTBUF;
  }

  function threadOptionCheck() {
    var t = st.threadFlags;
    if (!t) { st.threadFlags = TF_show_proc; return null; }
    if (st.forestType) return "thread display conflicts with forest display";
    if ((t & TF_B_H) && (t & (TF_B_m | TF_U_m)))
      return "thread flags conflict; can't use H with m or -m";
    if ((t & TF_B_m) && (t & TF_U_m))
      return "thread flags conflict; can't use both m and -m";
    if ((t & TF_U_L) && (t & TF_U_T))
      return "thread flags conflict; can't use both -L and -T";
    if (t & TF_B_H) st.threadFlags |= TF_show_proc | TF_loose_tasks;
    if (t & (TF_B_m | TF_U_m))
      st.threadFlags |= TF_show_proc | TF_show_task | TF_show_both;
    if (t & (TF_U_T | TF_U_L)) {
      if (t & (TF_B_m | TF_U_m | TF_B_H)) st.threadFlags |= TF_must_use;
      else st.threadFlags |= TF_show_task;
    }
    return null;
  }

  // select_bits_setup(): the table that turns "who am I" into "is this
  // process in the default selection".
  function selectBitsSetup() {
    var bits = 0, s = st.simpleSelect;
    if (!s && !st.preferBsd) { st.selectBits = 0xaa00; return null; }
    var v = (!(st.personality & PER_NO_DEFAULT_g) && !(s & (SS_U_a | SS_U_d)))
          ? (s | SS_B_g) : s;
    switch (v) {
      case SS_U_a | SS_U_d: bits = 0x3f3f; break;
      case SS_U_a:          bits = 0x0303; break;
      case SS_U_d:          bits = 0x3333; break;
      case 0:               bits = 0x0202; break;
      case SS_B_a:          bits = 0x0303; break;
      case SS_B_x:          bits = 0x2222; break;
      case SS_B_x | SS_B_a: bits = 0x3333; break;
      case SS_B_g:          bits = 0x0a0a; break;
      case SS_B_g | SS_B_a: bits = 0x0f0f; break;
      case SS_B_g | SS_B_x: bits = 0xaaaa; break;
      case SS_B_g | SS_B_x | SS_B_a:
        st.allProcesses = true; st.simpleSelect = 0; return null;
      default: return "process selection options conflict";
    }
    st.selectBits = bits;
    return null;
  }

  function argParse(argv) {
    st.argv = argv;
    resetAll();
    var err = null, err2 = null;
    err = parseAllOptions();
    if (!err) err = threadOptionCheck();
    if (!err) err = processSfOptions();
    if (!err) err = selectBitsSetup();
    if (!err) { chooseDimensions(); return null; }

    // try_bsd
    resetAll();
    st.formatFlags = 0;
    st.forceBsd = true;
    st.preferBsd = true;
    if (!((PER_OLD_m | PER_BSD_m) & st.personality)) st.personality |= PER_OLD_m;

    err2 = parseAllOptions();
    if (!err2) err2 = threadOptionCheck();
    if (!err2) err2 = processSfOptions();
    if (!err2) err2 = selectBitsSetup();
    if (!err2) { chooseDimensions(); return null; }

    return { fatal: (st.personality & PER_FORCE_BSD) ? err2 : err };
  }

  // ---- selection ----------------------------------------------------------
  //
  // select.c.  The default selection is the four-bit table below; anything
  // given explicitly is matched against the same table ps draws /proc from.

  function hasOurEuid(e) { return (e.uid | 0) === (st.myUid | 0); }
  function sessionLeader(e) { return P.sid(e) === e.pid; }
  function withoutTty(e) { return !ttyKey(e.tty); }
  function onOurTty(e) { return ttyKey(e.tty) === st.cachedTty; }

  function tableAccept(e) {
    var idx = (hasOurEuid(e) ? 1 : 0) | (sessionLeader(e) ? 2 : 0) |
              (withoutTty(e) ? 4 : 0) | (onOurTty(e) ? 8 : 0);
    return (st.selectBits & (1 << idx)) !== 0;
  }

  function inList(vals, v) {
    for (var i = 0; i < vals.length; i++) if (vals[i] === v) return true;
    return false;
  }

  function procWasListed(e) {
    var k, sn, i, s, comm = String(e.comm || "");
    for (k = 0; k < st.selection.length; k++) {
      sn = st.selection[k];
      switch (sn.type) {
        case SEL_RUID:
        case SEL_EUID:
          if (inList(sn.vals, e.uid | 0)) return true;
          break;
        case SEL_RGID:
        case SEL_EGID:
          if (inList(sn.vals, P.gid(e) | 0)) return true;
          break;
        case SEL_PGRP:
          if (inList(sn.vals, P.pgid(e))) return true;
          break;
        case SEL_PID:
        case SEL_PID_QUICK:
          if (inList(sn.vals, e.pid)) return true;
          break;
        case SEL_PPID:
          if (inList(sn.vals, e.ppid)) return true;
          break;
        case SEL_TTY:
          if (inList(sn.vals, ttyKey(e.tty))) return true;
          break;
        case SEL_SESS:
          if (inList(sn.vals, P.sid(e))) return true;
          break;
        case SEL_COMM:
          for (i = 0; i < sn.vals.length; i++) {
            s = sn.vals[i];
            // comm is at most 15 cells; a search that long still matches a
            // 15-cell comm on its first 15 cells alone.
            if (comm.length === 15 && s.length >= 15 &&
                comm.slice(0, 15) === s.slice(0, 15)) return true;
            if (comm === s) return true;
          }
          break;
      }
    }
    return false;
  }

  function running(e) {
    var s = P.stat(e);
    return s.charAt(0) === "R" || s.charAt(0) === "D";
  }

  function wantThisProc(e) {
    var ok = false;
    if (st.allProcesses) ok = true;
    else {
      if (st.simpleSelect || !st.selection.length) if (tableAccept(e)) ok = true;
      if (!ok && procWasListed(e)) ok = true;
    }
    if (st.runningOnly && !running(e)) ok = false;
    return st.negate ? !ok : ok;
  }

  // q/-q/--quick-pid is a fast path with a list of rules about what may be
  // combined with it.  These four print their own wording, with no usage.
  function argCheckConflicts() {
    var len = st.selection.length, quick = 0, tryQuick = 0, k;
    for (k = 0; k < len; k++) {
      if (st.selection[k].type === SEL_PID_QUICK) quick++;
      else if (st.selection[k].type === SEL_PID_TRY_QUICK) tryQuick++;
    }
    if (tryQuick > 0) {
      var selPid;
      if (tryQuick > 1 || quick > 0 || len > (tryQuick + quick) ||
          st.forestType || st.sortList.length || st.negate) selPid = SEL_PID;
      else { selPid = SEL_PID_QUICK; quick += tryQuick; }
      for (k = 0; k < len; k++)
        if (st.selection[k].type === SEL_PID_TRY_QUICK)
          st.selection[k].type = selPid;
    }
    if (quick > 1) return "q/-q/--quick-pid can only be used once.";
    if (quick && len > quick)
      return "q/-q/--quick-pid cannot be combined with other selection options.";
    if (quick && st.forestType)
      return "q/-q/--quick-pid cannot be used together with forest type listings.";
    if (quick && st.sortList.length)
      return "q/-q,--quick-pid cannot be used together with sort options.";
    if (quick && st.negate)
      return "q/-q/--quick-pid cannot be used together with negation switches.";
    // A surviving quick pid short-circuits simple_spew(): procps fetches only
    // those pids, so every other process is invisible -- which is why
    // `ps --heading x -p 99999` prints a header and nothing else.
    st.quickPids = (st.selection.length && st.selection[0].type === SEL_PID_QUICK)
      ? st.selection[0].vals : null;
    return null;
  }

  // ---- the header ---------------------------------------------------------
  //
  // check_headers(): HEAD_MULTI prints one screenful at a time, HEAD_NONE
  // never prints one, and the default prints exactly one -- header_gap is
  // reset to -1 so lines_to_next_header runs off into negative infinity.

  function checkHeaders() {
    if (st.headerType === HEAD_MULTI) { st.headerGap = st.screenRows - 1; return; }
    if (st.headerType === HEAD_NONE) { st.linesToNext = -1; return; }
    var normal = 0, i, n;
    for (i = 0; i < st.format.length; i++) {
      n = st.format[i];
      if (!n.name) continue;          // an empty header name prints nothing
      if (!n.aix) normal++;           // AIX filler has no pr routine
    }
    if (!normal) st.linesToNext = -1;
  }

  // check_header_width(): how many screen cells the widest row needs, and
  // therefore how much room the renderer has to play with.  screen_cols is
  // used as the unit, so the answer is that many cells rounded up.
  function checkHeaderWidth() {
    var total = 0, wasNormal = 0, sigs = 0, i, n, cols = 1;
    for (i = 0; i < st.format.length; i++) {
      n = st.format[i];
      if (n.j === J_SIGNAL) {
        sigs++;
        if (st.signalNames) {
          if (n.w < SIGNAL_NAME_WIDTH) n.w = SIGNAL_NAME_WIDTH;
          n.j = J_UNLIMITED;
          total += (i + 1 < st.format.length) ? n.w : 3;
        } else total += n.w;
        total += wasNormal; wasNormal = 1;
      } else if (n.j === J_UNLIMITED) {
        total += (i + 1 < st.format.length) ? n.w : 3;
        total += wasNormal; wasNormal = 1;
      } else if (n.j === 0) {
        total += n.w; wasNormal = 0;
      } else {
        total += n.w;
        total += wasNormal;
        wasNormal = 1;
      }
    }
    i = 0;
    for (;;) {
      i++;
      cols = st.screenCols * i;
      if (cols >= total) break;
      if (st.screenCols * i >= OUTBUF / 2) break;
    }
    st.activeCols = cols;
    st.wideSignals = (total + sigs * 7 <= cols);
  }

  function initOutput() { checkHeaderWidth(); }

  // ---- show_one_proc ------------------------------------------------------
  //
  // output.c, verbatim.  `correct` is where the column should start, `actual`
  // is where it does start, and the difference -- plus whatever the column is
  // entitled to -- becomes the padding written in front of the text.  The
  // padding lives in the SPACE_AMOUNT spaces saved_outbuf points past.

  function padSpace(n) {
    if (n <= 0) return "";
    var s = "";
    while (s.length < n) s += " ";
    return s;
  }

  function valueOf(n, e, max) {
    if (!n.val) return n.aix ? n.name : "-";
    var f = VAL[n.val];
    if (!f) return n.aix ? n.name : "-";
    var v = f(e, st, max);
    return (v === null || v === undefined) ? "-" : String(v);
  }

  function emitRow(e) {
    if (e) {
      if (--st.linesToNext === 0) { st.linesToNext = st.headerGap; emitRow(null); }
    }
    st.didStuff = true;

    var correct = 0, actual = 0, amount, leftpad, space, dospace = 0,
        legit, sz, tmpspace, text, maxRight, i, n;
    for (i = 0; i < st.format.length; i++) {
      n = st.format[i];
      legit = 0;
      if (i + 1 < st.format.length) {
        tmpspace = 0;
        maxRight = n.w;
      } else {
        tmpspace = correct - actual;
        if (tmpspace < 1) {
          tmpspace = dospace;
          maxRight = st.activeCols - actual - tmpspace;
        } else {
          maxRight = st.activeCols - (correct > actual ? correct : actual);
        }
      }
      if (maxRight <= 0) maxRight = 0;
      else if (maxRight >= OUTBUF) maxRight = OUTBUF - 1;

      if (e && !n.aix) { text = valueOf(n, e, maxRight); amount = text.length; }
      else { text = n.name; amount = text.length; }

      switch (n.j) {
        case J_USER:
          leftpad = n.w - amount; if (leftpad < 0) leftpad = 0;
          if (!st.userNum) leftpad = 0;
          break;
        case J_LEFT: leftpad = 0; break;
        case J_RIGHT:
          leftpad = n.w - amount; if (leftpad < 0) leftpad = 0;
          break;
        case J_SIGNAL:
          if (st.wideSignals) { leftpad = 16 - amount; legit = 7; }
          else leftpad = 9 - amount;
          if (leftpad < 0) leftpad = 0;
          break;
        case J_WCHAN:
          if (st.wchanNum) {
            leftpad = n.w - amount; if (leftpad < 0) leftpad = 0;
          } else {
            if (st.activeCols - actual - tmpspace < 1) text = text.slice(0, 1);
            leftpad = 0;
          }
          break;
        case J_UNLIMITED:
          if (st.activeCols - actual - tmpspace < 1) text = text.slice(0, 1);
          leftpad = 0;
          break;
        case 0:
          leftpad = 0;
          break;
        default:
          leftpad = 0;
          break;
      }

      space = correct - actual + leftpad;
      if (space < 1) space = dospace;
      if (space > SPACE_MAX) space = SPACE_MAX;

      sz = text.length;
      if (i + 1 >= st.format.length) {
        st.out += padSpace(space) + text + "\n";
        break;
      }
      st.out += padSpace(space) + text;
      actual += space + amount;
      correct += n.w;
      correct += legit;
      if (!n.aix && !st.format[i + 1].aix) { correct++; dospace = 1; }
      else dospace = 0;
    }
  }

  // show_one_proc(NULL, format) is the header: every column prints its name
  // with no value routine and so no truncation.
  function flushEnd() {
    if (st.didStuff) return 0;
    if (--st.linesToNext === 0) { st.linesToNext = st.headerGap; emitRow(null); }
    return 1;
  }

  // ---- spew ---------------------------------------------------------------

  // Sorting: procps re-sorts once per key with a stable sort, so applying
  // reverse(written) in order leaves the first written key on top.  The list
  // is stored in written order, which is therefore the comparator order.
  function sortValue(e, key) {
    var node = null, i, id = key, f, v;
    for (i = 0; i < st.format.length; i++)
      if (st.format[i].spec === key) { node = st.format[i]; break; }
    if (node) return valueOf(node, e, COLWID);
    if (COLS[key] && COLS[key][3]) id = COLS[key][3];
    f = VAL[id];
    if (f) { v = f(e, st, COLWID); return v === null || v === undefined ? "-" : String(v); }
    return "";
  }

  function cmpCell(a, b) {
    var na = Number(a), nb = Number(b);
    if (a !== "" && b !== "" && !isNaN(na) && !isNaN(nb)) return na - nb;
    return a < b ? -1 : (a > b ? 1 : 0);
  }

  function sortProcs(list, keys) {
    var i;
    for (i = 0; i < list.length; i++) list[i].__i = i;
    list.sort(function (a, b) {
      var c, k;
      for (k = 0; k < keys.length; k++) {
        c = cmpCell(sortValue(a, keys[k]), sortValue(b, keys[k]));
        if (c) return c;
      }
      return a.__i - b.__i;
    });
    for (i = 0; i < list.length; i++) delete list[i].__i;
  }

  function simpleSpew() {
    var all = P.list(), i, q = st.quickPids;
    for (i = 0; i < all.length; i++) {
      if (q && q.indexOf(all[i].pid | 0) < 0) continue;
      if (wantThisProc(all[i])) emitRow(all[i]);
    }
  }

  function fancySpew() {
    var all = P.list(), i, n = 0, keys;
    st.processes = [];
    for (i = 0; i < all.length; i++) if (wantThisProc(all[i])) st.processes.push(all[i]);
    n = st.processes.length;
    if (!n) return;
    if (st.forestType) {
      // prep_forest_sort(): the tree needs parents grouped and, when nothing
      // else ordered them, start time underneath.
      keys = [KEY_ppid].concat(st.sortList.length ? st.sortList : [KEY_start]);
    } else keys = st.sortList;
    if (keys && keys.length) sortProcs(st.processes, keys);
    if (st.forestType) showForest(n);
    else showProcArray(n);
  }

  function showProcArray(n) {
    for (var i = 0; i < n; i++) emitRow(st.processes[i]);
  }

  var KEY_ppid = "ppid", KEY_start = "start_time";

  // show_tree(): the prefix is one cell per level; '+' / 'L' describe this
  // row's place among its siblings and become '|' / ' ' for the children.
  function showTree(self, n, level, haveSibling) {
    var i, procs = st.processes, selfPid, moreChildren, next;
    if (level) st.forestPrefix = st.forestPrefix.slice(0, level - 1) + (haveSibling ? "+" : "L");
    st.forestPrefix = st.forestPrefix.slice(0, level);
    emitRow(procs[self]);
    for (i = 0; i < n; i++) if (procs[i].ppid === procs[self].pid) break;
    if (level) st.forestPrefix = st.forestPrefix.slice(0, level - 1) + (haveSibling ? "|" : " ");
    st.forestPrefix = st.forestPrefix.slice(0, level);
    for (;;) {
      if (i >= n) break;
      selfPid = procs[self].pid;
      if (i + 1 >= n) moreChildren = false;
      else moreChildren = (procs[i + 1].ppid === selfPid);
      // ADOPTED(): pid 1 keeps its foundlings at the same depth.
      if (selfPid === 1 && st.forestType !== "u") next = level;
      else next = (level + 1 < 256) ? level + 1 : level;
      showTree(i++, n, next, moreChildren);
      if (!moreChildren) break;
    }
    st.forestPrefix = st.forestPrefix.slice(0, level);
  }

  function showForest(n) {
    var i = n, j, root;
    while (i--) {
      root = true;
      for (j = 0; j < n; j++) if (st.processes[j].pid === st.processes[i].ppid) { root = false; break; }
      if (root) showTree(i, n, 0, 0);
    }
  }

  // ---- self --info --------------------------------------------------------

  function ttyDev(name) {
    var n = ttyKey(name), m;
    if (!n) return [0, 0];
    if ((m = /^tty(\d+)$/.exec(n))) return [4, +m[1] & 0xff];
    if ((m = /^pts\/(\d+)$/.exec(n))) return [136, +m[1] & 0xff];
    if (n === "console") return [5, 1];
    return [0, 0];
  }

  function selfInfo() {
    function f(v) { return v || "(none)"; }
    var dev = ttyDev(st.cachedTty);
    st.err +=
      "BSD j    " + f(st.bsdJFormat) + "\n" +
      "BSD l    " + f(st.bsdLFormat) + "\n" +
      "BSD s    " + f(st.bsdSFormat) + "\n" +
      "BSD u    " + f(st.bsdUFormat) + "\n" +
      "BSD v    " + f(st.bsdVFormat) + "\n" +
      "SysV -f  " + f(st.sysvFFormat) + "\n" +
      "SysV -fl " + f(st.sysvFlFormat) + "\n" +
      "SysV -j  " + f(st.sysvJFormat) + "\n" +
      "SysV -l  " + f(st.sysvLFormat) + "\n" +
      "\n" +
      "procps-ng version 4.0.5\n" +
      "Compiled with: glibc 2.38, gcc 12.3\n" +
      "\n" +
      "header_gap=" + st.headerGap + " lines_to_next_header=" + st.linesToNext + "\n" +
      "screen_cols=" + st.screenCols + " screen_rows=" + st.screenRows + "\n" +
      "\n" +
      "personality=0x" + ("00000000" + st.personality.toString(16)).slice(-8) +
      " (from \"unknown\")\n" +
      "EUID=" + st.myUid + " TTY=" + dev[0] + "," + dev[1] + " page_size=4096\n" +
      "sizeof(proc_t)=8 sizeof(long)=8 sizeof(long)=8\n" +
      "archdefs:x86_64\n";
  }

  // ---- help and version ---------------------------------------------------

  var HELP_TOPIC = {
    "": "", simple: "simple", s: "simple", list: "list", l: "list",
    output: "output", o: "output", threads: "threads", t: "threads",
    misc: "misc", m: "misc", all: "all", a: "all"
  };

  // do_help() always exits: 0 puts it on stdout, anything else on stderr
  // after the "error:" line total_failure already wrote.
  function doHelp(topic, rc) {
    var key = HELP_TOPIC[topic === null || topic === undefined ? "" : String(topic)];
    if (key === undefined) key = "";
    var lines = (HELP.ps && HELP.ps[key]) || HELP.ps[""] || [];
    var text = lines.join("\n") + "\n";
    if (rc) st.err += text; else st.out += text;
    throw { psExit: 1, code: rc };
  }

  // ---- the command --------------------------------------------------------

  function runPs(args, stdin, sh) {
    mkState(sh);
    var code = 0, bad;
    try {
      bad = argParse(["ps"].concat(args));
      if (bad) {
        st.err += "error: " + bad.fatal + "\n";
        doHelp(null, 1);                      // exits 1 with the usage
      }
      bad = argCheckConflicts();
      if (bad) { st.err += bad + "\n"; throw { psExit: 1, code: 1 }; }

      initOutput();
      checkHeaders();
      if (st.forestType || st.sortList.length) fancySpew();
      else simpleSpew();
      code = flushEnd();
    } catch (x) {
      if (!x || !x.psExit) throw x;
      code = x.code | 0;
    }
    if (st.err) sh._error(st.err.replace(/\n$/, ""));
    return { out: st.out, code: code };
  }

  def("ps", runPs, "report a snapshot of current processes");
  LW.PS = { run: runPs };

  // ---- pgrep / pkill -------------------------------------------------------
  //
  // procps-ng 4.0.5's src/pgrep.c.  The part that decides what you see is
  // select_procs(): every criterion is ANDed, the pattern is an ERE searched
  // in comm (or in the whole command line with -f), and the pid of the pgrep
  // asking the question is never one of the answers.

  // usage('h') and usage('i') go to stdout and exit 0; usage('?') -- what
  // getopt reaches for when it does not recognise something -- goes to stderr
  // and exits 2.  The body is the real text procps_help.js captured.
  function usageBody(prog) { return (HELP[prog] || HELP.pgrep || []).join("\n") + "\n"; }

  function myUid(sh) {
    var env = (sh && sh.env) || {};
    if (env.UID !== undefined && env.UID !== "") {
      var n = parseInt(env.UID, 10);
      if (!isNaN(n)) return n;
    }
    return sh && sh.isRoot ? 0 : 1000;
  }

  // strict_atol(): optional sign, digits only, and an empty string is a zero.
  function strictAtol(s) {
    var i = 0, sign = 1;
    if (s.charAt(0) === "+") i++;
    else if (s.charAt(0) === "-") { i++; sign = -1; }
    if (i >= s.length) return { ok: true, n: 0 };
    for (; i < s.length; i++)
      if (s.charAt(i) < "0" || s.charAt(i) > "9") return { ok: false };
    var n = parseInt(s, 10);
    return isFinite(n) ? { ok: true, n: sign * n } : { ok: false };
  }

  function lookupId(file, name, field) {
    var t = V.readFile(file);
    if (!t) return null;
    var lines = t.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var f = lines[i].split(":");
      if (f[0] === name) return parseInt(f[field], 10);
    }
    return null;
  }

  // glibc's regerror() wording, which is all procps ever shows you.
  function regexErrText(src) {
    var depth = 0, i, c;
    for (i = 0; i < src.length; i++) {
      c = src.charAt(i);
      if (c === "\\") { i++; continue; }
      if (c === "(") depth++;
      else if (c === ")") { if (--depth < 0) return "Unmatched ) or \\)"; }
      else if (c === "[") {
        var j = i + 1;
        if (src.charAt(j) === "^") j++;
        if (src.charAt(j) === "]") j++;
        while (j < src.length && src.charAt(j) !== "]") {
          if (src.charAt(j) === "\\") j++;
          j++;
        }
        if (j >= src.length) return "Invalid regular expression";
        i = j;
      }
    }
    if (depth > 0) return "Unmatched ( or \\(";
    if (/\\$/.test(src)) return "Trailing backslash";
    return "Invalid regular expression";
  }

  function isLongMatch(str) {
    if (str === null || str === undefined || str.length <= 15) return false;
    return str.indexOf("|") < 0 && str.indexOf("[") < 0;
  }

  // short options: shared by both, plus pgrep's -l -a -d -v -w and pkill's
  // -e -q.  The value says whether the option takes an argument.
  var PG_SHORT = { L: 0, F: 1, c: 0, f: 0, i: 0, n: 0, o: 0, x: 0, P: 1,
                   O: 1, A: 0, H: 0, g: 1, s: 1, u: 1, U: 1, G: 1, t: 1,
                   r: 1, V: 0, h: 0, "?": 0 };
  var PG_ONLY = { l: 0, a: 0, d: 1, v: 0, w: 0 };
  var PK_ONLY = { e: 0, q: 1 };

  // long option -> [takes an argument, the short-equivalent code]
  var PG_LONG = {
    signal: [1, "signal"], "ignore-ancestors": [0, "A"],
    "require-handler": [0, "H"], count: [0, "c"], cgroup: [1, "cgroup"],
    delimiter: [1, "d"], "list-name": [0, "l"], "list-full": [0, "a"],
    full: [0, "f"], pgroup: [1, "g"], group: [1, "G"],
    "ignore-case": [0, "i"], newest: [0, "n"], oldest: [0, "o"],
    older: [1, "O"], parent: [1, "P"], session: [1, "s"],
    terminal: [1, "t"], euid: [1, "u"], uid: [1, "U"], inverse: [0, "v"],
    lightweight: [0, "w"], exact: [0, "x"], pidfile: [1, "F"],
    logpidfile: [0, "L"], echo: [0, "e"], ns: [1, "ns"],
    nslist: [1, "nslist"], queue: [1, "q"], runstates: [1, "r"],
    env: [1, "env"], help: [0, "h"], version: [0, "V"],
  };

  var NS_NAMES = ["ipc", "mnt", "net", "pid", "user", "uts"];

  function runPgrep(prog, args, stdin, sh) {
    var res;
    try { res = pgrepBody(prog, args, sh); }
    catch (x) { if (!x || !x.pg) throw x; res = x.pg; }
    if (res.err) sh._error(res.err.replace(/\n$/, ""));
    return { out: res.out, code: res.code };
  }

  function pgrepBody(prog, args, sh) {
    var isKill = prog === "pkill";
    var o = {
      count: 0, delim: "\n", long: 0, longlong: 0, negate: 0, exact: 0,
      threads: 0, newest: 0, oldest: 0, older: -1, full: 0, ignoreCase: 0,
      echo: 0, signal: 15, queue: -1, pattern: null, pgrp: null, rgid: null,
      pids: null, ppid: null, sid: null, term: null, euid: null, ruid: null,
      runstates: null, ignoreAncestors: 0, lock: 0, pidfile: null,
      cgroup: null, env: null, requireHandler: 0,
    };
    var criteria = 0, rest = [], errBuf = "";

    function pg(out, err, code) { return { pg: { out: out, err: err, code: code } }; }
    // xwarnx()/xerrx(): the message, the program's name, no usage text.
    function fail(msg, code) {
      throw pg("", prog + ": " + msg + "\n", code === undefined ? 2 : code);
    }
    // usage('?') on its own, and getopt's message plus usage('?').
    function usageErr() { throw pg("", usageBody(prog), 2); }
    function optFail(msg) {
      throw pg("", prog + ": " + msg + "\n" + usageBody(prog), 2);
    }
    function usageOk() { throw pg(usageBody(prog), "", 0); }

    function convNum(s) {
      var r = strictAtol(s);
      if (!r.ok) fail("not a number: " + s);
      return r.n;
    }
    function convUid(s) {
      var r = strictAtol(s);
      if (r.ok) return r.n;
      var u = lookupId("/etc/passwd", s, 2);
      if (u === null || isNaN(u)) fail("invalid user name: " + s);
      return u;
    }
    function convGid(s) {
      var r = strictAtol(s);
      if (r.ok) return r.n;
      var g = lookupId("/etc/group", s, 2);
      if (g === null || isNaN(g)) fail("invalid group name: " + s);
      return g;
    }
    function convPgrp(s) {
      var r = strictAtol(s);
      if (!r.ok) fail("invalid process group: " + s);
      if (r.n !== 0) return r.n;
      var e = sh && sh.pid ? P.get(sh.pid) : null;
      return e ? P.pgid(e) : (sh && sh.pid) || 0;
    }
    function convSid(s) {
      var r = strictAtol(s);
      if (!r.ok) fail("invalid session id: " + s);
      if (r.n !== 0) return r.n;
      var e = sh && sh.pid ? P.get(sh.pid) : null;
      return e ? P.sid(e) : (sh && sh.pid) || 0;
    }
    // split_list(): an empty list is not a list, and a member that will not
    // convert has already said so and left.
    function splitList(str, conv) {
      if (str === "") return null;
      var parts = str.split(","), out = [], i;
      for (i = 0; i < parts.length; i++) out.push(conv(parts[i]));
      return out.length ? out : null;
    }
    function needList(value, conv, code) {
      var l = splitList(value, conv);
      if (l === null) usageErr();
      return l;
    }

    function setOpt(ch, val) {
      var n;
      switch (ch) {
        case "h": usageOk();
        case "V": throw pg((VER[prog] || []).join("\n") + "\n", "", 0);
        case "c": o.count = 1; return;
        case "f": o.full = 1; return;
        case "x": o.exact = 1; return;
        case "w": o.threads = 1; return;
        case "e": o.echo = 1; return;
        case "q": o.queue = parseInt(val, 10); return;
        case "l": o.long = 1; return;
        case "a": o.longlong = 1; return;
        case "d": o.delim = val; return;
        case "A": o.ignoreAncestors = 1; return;
        case "H": o.requireHandler = 1; criteria++; return;
        case "L": o.lock++; return;
        case "F": o.pidfile = val; criteria++; return;
        case "O": o.older = parseInt(val, 10); criteria++; return;
        case "r": o.runstates = val; criteria++; return;
        case "n":
          if (o.oldest || o.negate || o.newest) usageErr();
          o.newest = 1; criteria++; return;
        case "o":
          if (o.oldest || o.negate || o.newest) usageErr();
          o.oldest = 1; criteria++; return;
        case "v":
          if (o.oldest || o.negate || o.newest) usageErr();
          o.negate = 1; return;
        case "i":
          if (o.ignoreCase) usageOk();
          o.ignoreCase = "i"; return;
        case "P": o.ppid = needList(val, convNum); criteria++; return;
        case "g": o.pgrp = needList(val, convPgrp); criteria++; return;
        case "s": o.sid = needList(val, convSid); criteria++; return;
        case "t": o.term = needList(val, function (s) { return s; }); criteria++; return;
        case "u": o.euid = needList(val, convUid); criteria++; return;
        case "U": o.ruid = needList(val, convUid); criteria++; return;
        case "G": o.rgid = needList(val, convGid); criteria++; return;
        case "cgroup": o.cgroup = needList(val, function (s) { return s; }); criteria++; return;
        case "env": o.env = needList(val, function (s) { return s; }); criteria++; return;
        case "signal":
          n = P.signalNumber(val);
          if (n === null) {
            if (/^[0-9]/.test(val)) n = parseInt(val, 10);
            else throw pg("", 'Unknown signal "' + val + '".' + usageBody(prog), 2);
          }
          o.signal = n; return;
        case "ns":
          if ((parseInt(val, 10) || 0) === 0) { o.runstates = val; criteria++; return; }
          /* not a number: the C falls into the --nslist handler below */
          /* falls through */
        case "nslist":
          if (NS_NAMES.indexOf(val) < 0) throw pg("", "", 2);
          return;
        default: optFail("invalid option -- '" + ch + "'");
      }
    }

    // pkill reads its signal as a bare -<sig> anywhere on the line, before
    // getopt ever gets to look at it.
    if (isKill) {
      for (var k = 0; k < args.length; k++) {
        if (args[k].charAt(0) === "-") {
          var sg = P.signalNumber(args[k].slice(1));
          if (sg !== null) {
            o.signal = sg;
            args = args.slice(0, k).concat(args.slice(k + 1));
            break;
          }
        }
      }
    }

    var table = {}, key;
    for (key in PG_SHORT) table[key] = PG_SHORT[key];
    var extra = isKill ? PK_ONLY : PG_ONLY;
    for (key in extra) table[key] = extra[key];

    var i = 0, a, j, pos, ch, v, body, eq, name, entry;
    while (i < args.length) {
      a = args[i];
      if (a === "--") { rest = rest.concat(args.slice(i + 1)); break; }
      if (a.slice(0, 2) === "--") {
        body = a.slice(2); eq = -1;
        for (j = 0; j < body.length; j++)
          if (body.charAt(j) === "=" || body.charAt(j) === ":") { eq = j; break; }
        name = eq >= 0 ? body.slice(0, eq) : body;
        if (!Object.prototype.hasOwnProperty.call(PG_LONG, name))
          optFail("unrecognized option '--" + name + "'");
        entry = PG_LONG[name];
        v = eq >= 0 ? body.slice(eq + 1) : null;
        if (entry[0]) {
          if (v === null || v === "") {
            if (i + 1 < args.length && args[i + 1] !== "") v = args[++i];
            else optFail("option '--" + name + "' requires an argument");
          }
        } else if (v !== null) {
          optFail("option '--" + name + "' doesn't allow an argument");
        }
        setOpt(entry[1], v);
        i++;
        continue;
      }
      if (a.length > 1 && a.charAt(0) === "-") {
        pos = 1;
        while (pos < a.length) {
          ch = a.charAt(pos);
          if (!Object.prototype.hasOwnProperty.call(table, ch))
            optFail("invalid option -- '" + ch + "'");
          pos++;
          v = null;
          if (table[ch]) {
            if (pos < a.length) { v = a.slice(pos); pos = a.length; }
            else if (i + 1 < args.length) v = args[++i];
            else optFail("option requires an argument -- '" + ch + "'");
          }
          setOpt(ch, v);
        }
        i++;
        continue;
      }
      rest.push(a);
      i++;
    }

    if (o.lock && !o.pidfile)
      fail("-L without -F makes no sense\nTry `" + prog + " --help' for more information.");
    if (o.pidfile) {
      var pf = V.readFile(o.pidfile);
      var nums = pf === null ? [] : pf.split(/\s+/)
        .filter(function (s) { return s !== ""; })
        .map(function (s) { var r = strictAtol(s); return r.ok ? r.n : null; })
        .filter(function (n) { return n !== null; });
      if (!nums.length)
        fail("pidfile not valid\nTry `" + prog + " --help' for more information.", 1);
      o.pids = nums;
    }
    if (rest.length === 1) o.pattern = rest[0];
    else if (rest.length > 1)
      fail("only one pattern can be provided\nTry `" + prog + " --help' for more information.");
    else if (criteria === 0)
      fail("no matching criteria specified\nTry `" + prog + " --help' for more information.");

    // ---- select_procs() ----------------------------------------------------
    var re = null;
    if (o.pattern !== null) {
      var src = o.exact ? "^(" + o.pattern + ")$" : o.pattern;
      try { re = LW.ere(src, o.ignoreCase ? "i" : "", true); }
      catch (e0) { fail("regex error: " + regexErrText(o.pattern)); }
    }

    function inList(value, list) {
      if (!list) return true;
      for (var q = 0; q < list.length; q++) if (list[q] === value) return true;
      return false;
    }
    function cgroupPath(e) {
      var t = P.cgroupText(e) || "";
      return t.slice(0, 3) === "0::" ? t.slice(3) : null;
    }
    function envMatches(e, list) {
      var env = e.env;
      if (!env) return false;
      for (var q = 0; q < list.length; q++) {
        for (var w = 0; w < env.length; w++) {
          if (list[q].indexOf("=") < 0) {
            if (env[w].slice(0, list[q].length) === list[q]) return true;
          } else if (env[w] === list[q]) return true;
        }
      }
      return false;
    }
    // Every process in this world was installed with the same signal masks,
    // so -H asks the one question it can: does the caught mask have the bit?
    function handlerFor(sig) {
      var mask = P.SIGMASKS && P.SIGMASKS.cgt;
      if (!mask || sig < 1) return false;
      var b = sig - 1;
      var digit = mask.charAt(mask.length - 1 - Math.floor(b / 4));
      if (!digit) return false;
      return (parseInt(digit, 16) & (1 << (b % 4))) !== 0;
    }
    function ancestorsOf(pid) {
      var set = {}, n = 0, e;
      while (pid && n++ < 128) {
        set[pid] = 1;
        e = P.get(pid);
        if (!e) break;
        pid = e.ppid;
      }
      return set;
    }

    var anc = o.ignoreAncestors ? ancestorsOf(sh && sh._cmdPid) : null;
    var me = (sh && sh._cmdPid) || 0;
    var all = P.list(), hits = [], e, match;
    for (i = 0; i < all.length; i++) {
      e = all[i];
      if (e.pid === me) continue;
      if (anc && anc[e.pid]) continue;
      match = true;
      if (o.ppid && !inList(e.ppid, o.ppid)) match = false;
      else if (o.pids && !inList(e.pid, o.pids)) match = false;
      else if (o.pgrp && !inList(P.pgid(e), o.pgrp)) match = false;
      else if (o.euid && !inList(e.uid, o.euid)) match = false;
      else if (o.ruid && !inList(e.uid, o.ruid)) match = false;
      else if (o.rgid && !inList(P.gid(e), o.rgid)) match = false;
      else if (o.sid && !inList(P.sid(e), o.sid)) match = false;
      else if (o.older >= 0 &&
               Math.max(0, (LW.uptime ? LW.uptime() : 0) - e.since) < o.older)
        match = false;
      else if (o.term && !inList(e.tty, o.term)) match = false;
      else if (o.runstates &&
               o.runstates.indexOf((e.zombie ? "Z" : (e.stat || "S").charAt(0))) < 0)
        match = false;
      else if (o.cgroup && o.cgroup.indexOf(cgroupPath(e)) < 0) match = false;
      else if (o.env && !envMatches(e, o.env)) match = false;
      else if (o.requireHandler && !handlerFor(o.signal)) match = false;
      if (match && o.pattern) {
        var hay = o.full ? (e.args || "") : (e.comm || "");
        if (!re.test(hay)) match = false;
      }
      if (match !== !!o.negate) hits.push(e);
    }

    // -n and -o each leave exactly one process: the newest or the oldest,
    // ties broken by the lower pid.
    if (o.newest || o.oldest) {
      hits.sort(function (x, y) { return (x.since - y.since) || (x.pid - y.pid); });
      hits = hits.length ? [o.newest ? hits[hits.length - 1] : hits[0]] : [];
    }

    if (!hits.length && !o.full && isLongMatch(o.pattern)) {
      errBuf += prog +
        ": pattern that searches for process name longer than 15 characters" +
        " will result in zero matches\nTry `" + prog +
        " -f' option to match against the complete command line.\n";
    }

    // ---- the output --------------------------------------------------------
    if (isKill) {
      var outBuf = "", killed = 0, uid = myUid(sh);
      for (i = 0; i < hits.length; i++) {
        e = hits[i];
        // EPERM unless we own it or are root; ESRCH (gone already) is not
        // a failure at all.
        if (!(e.uid === 0 && uid !== 0) && P.kill(e.pid, o.signal)) {
          if (o.echo)
            outBuf += (o.longlong ? (e.args || "") : (e.comm || "")) +
                      " killed (pid " + e.pid + ")\n";
          killed++;
          continue;
        }
        if (!P.get(e.pid) || e.zombie) continue;
        errBuf += prog + ": killing pid " + e.pid + " failed\n";
      }
      if (o.count) outBuf += hits.length + "\n";
      return { out: outBuf, err: errBuf, code: killed ? 0 : 1 };
    }

    var out;
    if (o.count) out = hits.length + "\n";
    else if (o.long || o.longlong) {
      var strs = hits.map(function (x) {
        return x.pid + " " + (o.longlong ? (x.args || "") : (x.comm || ""));
      });
      out = strs.length ? strs.join(o.delim) + "\n" : "";
    } else {
      var nums2 = hits.map(function (x) { return String(x.pid); });
      out = nums2.length ? nums2.join(o.delim) + "\n" : "";
    }
    return { out: out, err: errBuf, code: hits.length ? 0 : 1 };
  }

  // ---- pidof ---------------------------------------------------------------
  //
  // sysvinit's pidof(1) (the host's /usr/bin/pidof is a link to killall5).
  // A program name is matched against the name the process was started with
  // and against the binary it is running; a name given as a path is matched
  // as a path, so ./bash is not /usr/bin/bash.  Anything getopt dislikes is
  // silently a failure: no message, exit 1.

  function baseOf(p) { var i = String(p).lastIndexOf("/"); return i < 0 ? String(p) : String(p).slice(i + 1); }
  function dirOf(p) { var i = String(p).lastIndexOf("/"); return i <= 0 ? "/" : String(p).slice(0, i); }

  function normPath(p) {
    var abs = p.charAt(0) === "/", parts = p.split("/"), out = [], x;
    for (var i = 0; i < parts.length; i++) {
      x = parts[i];
      if (x === "" || x === ".") continue;
      if (x === "..") out.pop();
      else out.push(x);
    }
    return (abs ? "/" : "") + out.join("/");
  }

  var PATH_ALIAS = { "/bin": "/usr/bin", "/usr/bin": "/bin",
                     "/sbin": "/usr/sbin", "/usr/sbin": "/sbin" };

  function sameFile(a, b) {
    if (!b) return false;
    a = normPath(a); b = normPath(b);
    if (a === b) return true;
    var da = dirOf(a), db = dirOf(b);
    return !!PATH_ALIAS[da] && PATH_ALIAS[da] === db && baseOf(a) === baseOf(b);
  }

  function runPidof(args, stdin, sh) {
    var sep = " ", quiet = 0, one = 0, withX = 0, zombies = 0, omit = [], names = [];
    var i = 0, p, ch, v;
    while (i < args.length) {
      var a = args[i++];
      if (a === "--") { names = names.concat(args.slice(i)); break; }
      if (a.length > 1 && a.charAt(0) === "-") {
        for (p = 1; p < a.length; p++) {
          ch = a.charAt(p);
          if (ch === "h") return { out: (HELP.pidof || []).join("\n") + "\n", code: 0 };
          if (ch === "c" || ch === "n") continue;
          if (ch === "q") { quiet = 1; continue; }
          if (ch === "s") { one = 1; continue; }
          if (ch === "x") { withX = 1; continue; }
          if (ch === "z") { zombies = 1; continue; }
          if (ch === "d" || ch === "o") {
            if (p + 1 < a.length) { v = a.slice(p + 1); p = a.length; }
            else if (i < args.length) v = args[i++];
            else return { out: "", code: 1 };
            if (ch === "d") sep = v;
            else {
              var n = strictAtol(v);
              if (!n.ok) return { out: "", code: 1 };
              omit.push(n.n);
            }
            continue;
          }
          return { out: "", code: 1 };       // getopt says nothing, pidof says less
        }
        continue;
      }
      names.push(a);
    }
    if (!names.length) return { out: "", code: 1 };

    var prog = names[0], me = (sh && sh._cmdPid) || 0;
    var withPath = prog.indexOf("/") >= 0;
    var want = withPath ? normPath(prog) : prog;
    var hits = [], all = P.list();
    for (i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.pid === me) continue;
      if (!zombies && (e.zombie || (e.stat || "").charAt(0) === "Z")) continue;
      if (omit.indexOf(e.pid) >= 0) continue;
      var argv0 = String(e.args || "").split(" ")[0];
      var words = String(e.args || "").split(" ");
      if (!withPath) {
        if (baseOf(argv0) === want || baseOf(e.exe || "") === want) hits.push(e);
        else if (withX && words.length > 1 && baseOf(words[1]) === want) hits.push(e);
      } else if (want.charAt(0) === "/" &&
                 (sameFile(want, e.exe) || sameFile(want, argv0))) hits.push(e);
    }
    hits.sort(function (x, y) { return y.pid - x.pid; });
    if (one) hits = hits.slice(0, 1);
    if (!hits.length) return { out: "", code: 1 };
    if (quiet) return { out: "", code: 0 };
    return { out: hits.map(function (e) { return e.pid; }).join(sep) + "\n", code: 0 };
  }

  def("pgrep", function (a, i2, s) { return runPgrep("pgrep", a, i2, s); },
      "list processes matching a pattern");
  def("pkill", function (a, i2, s) { return runPgrep("pkill", a, i2, s); },
      "kill processes matching a pattern");
  def("pidof", runPidof, "find the pid of a running program");

  // ---- pstree -------------------------------------------------------------
  //
  // psmisc 23.7's src/pstree.c.  read_proc() walks the process table and
  // builds a tree of PROC nodes, add_child() orders the siblings by name (or
  // by pid with -n), fix_orphans() hangs everything else off the root, and
  // dump_tree() draws it: the tree-equal collapsing, the two different child
  // loops (-a and the plain case) and out_char()'s truncation at the
  // terminal width.
  //
  // Three parts of the program this machine cannot exercise, all three
  // because of what is (not) under /proc here:
  //
  //   * one process, one thread -- there is no /proc/pid/task, so -t and -T
  //     parse and do nothing, and no {name} child ever reaches the THREAD
  //     half of the -a loop;
  //   * no /proc/pid/ns, so -N always answers "not available" and -S never
  //     finds a namespace to disagree about;
  //   * kthreads hang off the pid-0 placeholder, which fix_orphans() leaves
  //     alone, so -- exactly as in v23.7 without -k -- they show up only
  //     under `pstree 0`.
  var PSTREE_SYM = {
    ascii: { empty: "  ", branch: "|-", vert: "| ", last: "`-",
             single: "---", first: "-+-" },
    utf: { empty: "  ", branch: "\u251c\u2500", vert: "\u2502 ",
           last: "\u2514\u2500", single: "\u2500\u2500\u2500",
           first: "\u2500\u252c\u2500" },
    // VT_BEG shifts the line-drawing character set into use, VT_END shifts
    // the normal one back.  psmisc only reaches these with -G; its automatic
    // choice is UTF-8 or ASCII, never VT100.
    vt100: { empty: "  ",
             branch: "\u001b(0\u000ftq\u001b(B",
             vert: "\u001b(0\u000fx\u001b(B ",
             last: "\u001b(0\u000fmq\u001b(B",
             single: "\u001b(0\u000fqqq\u001b(B",
             first: "\u001b(0\u000fqwq\u001b(B" },
  };

  // getopt_long()'s short options exactly as main() declares them, colons
  // and all: a colon makes the option take an argument, the rest of the word
  // if there is any and the next word if there is not.  `?` is not on the
  // list, which is why `pstree -?` complains.
  var PSTREE_SHORT = "aAcC:GhH:nN:pglsStTuUVZ";
  var PSTREE_LONG = {
    arguments: "a", ascii: "A", "compact-not": "c", color: "C",
    vt100: "G", "highlight-all": "h", "highlight-pid": "H", long: "l",
    "numeric-sort": "n", "ns-sort": "N", "show-pids": "p",
    "show-pgids": "g", "show-parents": "s", "ns-changes": "S",
    "thread-names": "t", "hide-threads": "T", "uid-changes": "u",
    unicode: "U", version: "V", "security-context": "Z",
  };
  var PSTREE_OPT = (function () {
    var takes = {}, valid = {};
    for (var i = 0; i < PSTREE_SHORT.length; i++) {
      var k = PSTREE_SHORT.charAt(i);
      if (k === ":") continue;
      valid[k] = 1;
      if (PSTREE_SHORT.charAt(i + 1) === ":") takes[k] = 1;
    }
    return { takes: takes, valid: valid };
  })();
  var PSTREE_NS = { cgroup: 1, ipc: 1, mnt: 1, net: 1, pid: 1,
                    time: 1, user: 1, uts: 1 };

  function runPstree(args, stdin, sh) {
    var V = LW.VFS, P = LW.proc;
    var T = {
      env: (sh && sh.env) ? sh.env : {},
      // main()'s own variables
      printArgs: 0, compact: 1, userChange: 0, pids: 0, pgids: 0,
      showParents: 0, byPid: 0, trunc: 1, nsChange: 0, threadNames: 0,
      hideThreads: 0, showScontext: 0, colorAge: 0, sym: PSTREE_SYM.ascii,
      highlight: 0, md: "", me: "", cols: 80, nsid: "",
      // the tree and the line being drawn
      nodes: [], out: "", err: "", curX: 1, charLen: 0, lastChar: "",
      widths: [], mores: [], dumped: 0,
    };

    function bail(code) { throw { pstreeExit: true, code: code }; }
    function usage() {
      T.err += LW.PSHELP.pstreeUsage.join("\n") + "\n";
      bail(1);
    }

    // ---- the byte-at-a-time writer ---------------------------------------
    //
    // out_char() charges one column for the first byte of a character and
    // lets the rest ride along, which is how a UTF-8 tree still lines up on
    // an 80-column screen.  `glyph` is what goes out when the byte fits --
    // null for continuation bytes, whose glyph left with the first one --
    // and `bytes` is that character's length in UTF-8 bytes.
    function outChar(glyph, bytes) {
      if (T.charLen === 0) { T.charLen = bytes; T.curX++; }
      T.charLen--;
      if (!T.trunc || T.curX <= T.cols) { if (glyph !== null) T.out += glyph; }
      else if (T.curX === T.cols + 1) T.out += "+";
    }
    function outStr(s) {
      for (var i = 0; i < s.length; i++) {
        var cp = s.charCodeAt(i), glyph = s.charAt(i), bytes;
        if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < s.length) {
          i++; glyph += s.charAt(i); bytes = 4;
        } else if (cp >= 0x800) bytes = 3;
        else if (cp >= 0x80) bytes = 2;
        else bytes = 1;
        outChar(glyph, bytes);
        for (var b = 1; b < bytes; b++) outChar(null, 0);
      }
    }
    // Non-negative integers only, and 0 comes out as nothing at all -- the
    // returned count still says one, because psmisc's arithmetic says so.
    function outInt(x) {
      var digits = 0, div;
      for (div = 1; Math.floor(x / div); div *= 10) digits++;
      if (!digits) digits = 1;
      for (div = Math.floor(div / 10); div; div = Math.floor(div / 10))
        outChar(String(Math.floor(x / div) % 10), 1);
      return digits;
    }
    function outNewline() {
      // last_char is never assigned in psmisc 23.7, so the flush above it
      // never fires; it is here because the code is.
      if (T.lastChar && T.curX === T.cols) T.out += T.lastChar;
      T.lastChar = "";
      T.out += "\n";
      T.curX = 1;
    }
    function utf8(s) {
      var out = [];
      for (var i = 0; i < s.length; i++) {
        var cp = s.charCodeAt(i);
        if (cp >= 0xd800 && cp < 0xdc00 && i + 1 < s.length) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
          i++;
        }
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000)
          out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                      0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
      return out;
    }
    // out_args(): a name, with every byte that is not printable ASCII spelled
    // out the way C spells it -- one backslash-escape per byte -- and the
    // count it hands back is how many columns that took.
    function outArgs(s) {
      var bytes = utf8(s), count = 0;
      for (var i = 0; i < bytes.length; i++) {
        var b = bytes[i];
        if (b === 0x5c) { outStr("\\\\"); count += 2; }
        else if (b >= 0x20 && b <= 0x7e) { outChar(String.fromCharCode(b), 1); count++; }
        else { outStr("\\" + ("000" + b.toString(8)).slice(-3)); count += 4; }
      }
      return count;
    }

    // ---- reading the table ------------------------------------------------
    function node(comm, pid, uid) {
      return { comm: comm, pid: pid, uid: uid, pgid: 0, age: 0,
               argv: null, argc: 0, flags: 0, parent: null, children: [] };
    }
    function findProc(pid) {
      for (var i = 0; i < T.nodes.length; i++)
        if (T.nodes[i].pid === pid) return T.nodes[i];
      return null;
    }
    // Siblings sit in name order, or pid order with -n; on a name tie the
    // lower uid goes first.  strcmp reads names as unsigned bytes, which for
    // the names a process has is what JavaScript's < on strings does.
    function addChild(parent, child) {
      var list = parent.children, i = 0;
      for (; i < list.length; i++) {
        if (T.byPid) { if (list[i].pid > child.pid) break; }
        else if (list[i].comm > child.comm) break;
        else if (list[i].comm === child.comm && list[i].uid > child.uid) break;
      }
      list.splice(i, 0, child);
      child.parent = parent;
    }
    // A process first met as somebody's parent arrives as a "?" and is
    // renamed when the real one turns up; the parent's list, which was
    // sorted for "?", then gets one pass of the same comparison.
    function renameProc(self, comm, uid) {
      self.comm = comm; self.uid = uid;
      if (T.byPid || !self.parent) return;
      var pl = self.parent.children;
      for (var i = 0; i + 1 < pl.length; i++)
        if (pl[i].comm > pl[i + 1].comm) {
          var t = pl[i]; pl[i] = pl[i + 1]; pl[i + 1] = t;
        }
    }
    function addProc(comm, pid, ppid, pgid, uid, argv, argc, age) {
      var self = findProc(pid), parent;
      if (!self) { self = node(comm, pid, uid); T.nodes.push(self); }
      else renameProc(self, comm, uid);
      if (argv) { self.argv = argv; self.argc = argc; }
      if (pid === ppid) ppid = 0;
      self.pgid = pgid;
      self.age = age;
      parent = findProc(ppid);
      if (!parent) { parent = node("?", ppid, 0); T.nodes.push(parent); }
      if (pid !== 0) addChild(parent, self);
    }
    // hidepid on /proc, or a parent that has already gone: everything with
    // nobody to hang off is moved under the root, which is why a stray
    // daemon turns up at the top level instead of vanishing.  Pid 0 is left
    // alone, so the kernel threads stay with the placeholder and stay out of
    // every tree but `pstree 0`.
    function fixOrphans(rootPid) {
      var root = findProc(rootPid);
      if (!root) { root = node("?", rootPid, 0); T.nodes.push(root); }
      T.nodes.slice().forEach(function (w) {
        if (w.pid === 1 || w.pid === 0) return;
        if (w.parent === null) addChild(root, w);
      });
    }
    function readProc(rootPid) {
      var all = P.list();
      if (!all.length) { T.err += "/proc is empty (not mounted ?)\n"; bail(1); }
      // psmisc reads only as much cmdline as the line it is drawing can
      // hold: width + 1 bytes when it is going to truncate, BUFSIZ + 1 when
      // it is not.
      var bufSize = T.trunc ? T.cols + 1 : 8193;
      all.forEach(function (e) {
        // /proc/pid/cmdline: argv joined by NULs and terminated by one
        // more, empty for a kernel thread.  set_args() reads it back by
        // counting the NULs before the last byte -- the number of
        // arguments -- and throws argv[0] away, which the name printed
        // beside it already says.
        var cmd = e.args ? e.args.replace(/ /g, "\0") + "\0" : "";
        var argv = null, argc = -1;
        if (T.printArgs && cmd) {
          var buf = cmd.length >= bufSize
            ? cmd.slice(0, bufSize - 1) + "\0" : cmd + "\0";
          var fields = buf.split("\0");
          argc = buf.slice(0, -1).split("\0").length - 1;
          argv = fields.slice(1, 1 + argc);
        }
        addProc(e.comm, e.pid, e.ppid, P.pgid(e), e.uid, argv, argc,
                Math.max(0, P.uptime() - e.since));
      });
      fixOrphans(rootPid);
    }

    // ---- drawing ----------------------------------------------------------
    function treeEqual(a, b) {
      if (a.comm !== b.comm) return false;
      if (T.userChange && a.uid !== b.uid) return false;
      // -S compares namespace inodes, and skips any that are unset; this
      // /proc has none, so there is never a difference to find.
      if (a.children.length !== b.children.length) return false;
      for (var i = 0; i < a.children.length; i++)
        if (!treeEqual(a.children[i], b.children[i])) return false;
      return true;
    }
    function printColor(age) {
      if (!T.colorAge) return;
      outRaw(age < 60 ? "\u001b[32m" : age < 3600 ? "\u001b[33m" : "\u001b[31m");
    }
    function resetColor() { if (T.colorAge) outRaw("\u001b[0m"); }
    // tputs() and the age colours both reach the terminal with a plain
    // putchar() in psmisc: they never pass through out_char(), so unlike
    // everything else they do not cost a column.  Routing them through
    // out_char() would stretch every width[level] after a highlighted or
    // coloured process, which is why here they append straight to the line.
    function outRaw(s) { T.out += s; }
    function outScontext(pid) {
      outStr("`");
      // libapparmor hands back the same text this file holds, so read the
      // file the way out_scontext() falls back to doing.  Pid 0 has no
      // directory of its own, and comes out with nothing in between.
      var text = V.readFile("/proc/" + pid + "/attr/current");
      if (text !== null && text !== undefined) outStr(String(text).replace(/\n$/, ""));
      outStr("'");
    }
    // Returns how the caller's -N argument should bucket pid `n`: the
    // kernel hands every process in this CT its namespaces from the
    // initial set, so every process shares one inode per type -- until a
    // non-root caller asks about a process it does not own.  Like the
    // real /proc/<pid>/ns of a foreign process, stat(2) then fails with
    // EPERM, which psmisc stores as a 0 and which consequently never
    // matches anything real.
    var NS_INODES = { cgroup: 4026531835, ipc: 4026531842, mnt: 4026531841,
                      net: 4026531840, pid: 4026531836, time: 4026531843,
                      user: 4026531838, uts: 4026531839 };
    function nsVal(n) {
      if (n.pid === 0) return 0;                 // the "?" node, never owned
      var o = NS_INODES[T.nsid];
      if (!o) return 0;
      var v = sh.isRoot ? 0 : ((sh.env && sh.env.UID) ? parseInt(sh.env.UID, 10) : 1000);
      if (v === 0 || n.uid === v) return o;
      return 0;
    }
    // A node belongs under the namespace umbrella when it has no parent, or
    // when its parent answers for a different namespace.  Everyone else
    // stays put and belongs in no umbrella at all.
    function detachTo(root, groups) {
      if (!root) return;
      if (root.parent === null || root.parent.nsVal !== root.nsVal) {
        var g = null, i;
        for (i = 0; i < groups.length; i++)
          if (groups[i].number === root.nsVal) { g = groups[i]; break; }
        if (!g) { g = { number: root.nsVal, roots: [] }; groups.push(g); }
        g.roots.push(root);
        if (root.parent) {
          var pl = root.parent.children;
          for (i = 0; i < pl.length; i++)
            if (pl[i] === root) { pl.splice(i, 1); break; }
          root.parent = null;
        }
      }
      root.children.slice().forEach(function (c) { detachTo(c, groups); });
    }
    function dumpTree(cur, level, rep, leaf, last, prevUid, closing) {
      if (!cur) return;
      var sym = T.sym, lvl, i, add, offset, swapped, info, count, commLen,
          first, idx, scan, nextIdx, child, hasNext, word, len, wb, who, q;
      if (!leaf) {
        for (lvl = 0; lvl < level; lvl++) {
          for (i = T.widths[lvl] + 1; i; i--) outChar(" ", 1);
          outStr(lvl === level - 1
                 ? (last ? sym.last : sym.branch)
                 : (T.mores[lvl + 1] ? sym.vert : sym.empty));
        }
      }
      if (rep < 2) add = 0;
      else { add = outInt(rep) + 2; outStr("*["); }
      printColor(cur.age);
      if (cur.flags & 1) outRaw(T.md);
      swapped = info = T.printArgs ? 1 : 0;
      if (swapped && cur.argc < 0) outChar("(", 1);
      commLen = outArgs(cur.comm);
      offset = T.curX;
      if (T.pids) { outChar(info++ ? "," : "(", 1); outInt(cur.pid); }
      if (T.pgids) { outChar(info++ ? "," : "(", 1); outInt(cur.pgid); }
      if (T.userChange && prevUid !== cur.uid) {
        outChar(info++ ? "," : "(", 1);
        who = userForUid(cur.uid);
        if (who) outStr(who); else outInt(cur.uid);
      }
      if (T.showScontext) { outChar(info++ ? "," : "(", 1); outScontext(cur.pid); }
      if ((swapped && T.printArgs && cur.argc < 0) || (!swapped && info))
        outChar(")", 1);
      if (cur.flags & 1) outRaw(T.me);
      if (T.printArgs) {
        for (i = 0; i < cur.argc; i++) {
          if (i < cur.argc - 1) outChar(" ", 1);   // spaces between words
          word = cur.argv[i] === undefined ? "" : cur.argv[i];
          wb = utf8(word);
          len = 0;
          for (q = 0; q < wb.length; q++)
            len += (wb[q] >= 0x20 && wb[q] <= 0x7e) ? 1 : 4;
          if (T.curX + len <= T.cols - (i === cur.argc - 1 ? 0 : 4) || !T.trunc)
            outArgs(word);
          else { outStr("..."); break; }
        }
      }
      resetColor();
      if (T.showScontext || T.printArgs || !cur.children.length) {
        while (closing-- > 0) outChar("]", 1);
        outNewline();
      }
      T.mores[level] = !last;

      if (T.showScontext || T.printArgs) {
        // With arguments on show every node owns its line, and each child
        // writes the spaces and the vertical rule it needs before its name.
        T.widths[level] = swapped + (commLen > 1 ? 0 : -1);
        idx = 0;
        while (idx < cur.children.length) {
          child = cur.children[idx];
          nextIdx = idx + 1;
          count = 0;
          if (T.compact && (child.flags & 2)) {
            scan = idx + 1;
            while (scan < cur.children.length) {
              if (!treeEqual(child, cur.children[scan])) { scan++; continue; }
              if (nextIdx === scan) nextIdx = scan + 1;
              count++;
              cur.children.splice(scan, 1);
            }
            hasNext = nextIdx < cur.children.length;
            dumpTree(child, level + 1, count + 1, 0, !hasNext, cur.uid,
                     closing + (count ? 1 : 0));
          } else {
            hasNext = idx + 1 < cur.children.length;
            dumpTree(child, level + 1, 1, 0, !hasNext, cur.uid, 0);
          }
          idx = nextIdx;
        }
        return;
      }
      // Without arguments the name is only the start of the line: the first
      // child's branch goes right after it and the newline arrives at the
      // end of that child's subtree.
      T.widths[level] = commLen + T.curX - offset + add;
      if (T.curX >= T.cols && T.trunc) {
        outStr(sym.first); outStr("+"); outNewline();
        return;
      }
      first = 1;
      idx = 0;
      while (idx < cur.children.length) {
        child = cur.children[idx];
        nextIdx = idx + 1;
        count = 0;
        if (T.compact) {
          scan = idx + 1;
          while (scan < cur.children.length) {
            if (!treeEqual(child, cur.children[scan])) { scan++; continue; }
            if (nextIdx === scan) nextIdx = scan + 1;
            count++;
            cur.children.splice(scan, 1);
          }
        }
        hasNext = nextIdx < cur.children.length;
        if (first) { outStr(hasNext ? sym.first : sym.single); first = 0; }
        // psmisc's source passes `closing + (count ? 2 : 1)` on the -a path
        // and `count ? 1 : 0` on the plain one, but the 23.7 binary adds
        // exactly one bracket for a collapsed run and none for a lone
        // process on both, which is what pstree -a on a real machine shows.
        // Follow the binary.
        dumpTree(child, level + 1, count + 1, idx === 0, !hasNext, cur.uid,
                 closing + (count ? 1 : 0));
        idx = nextIdx;
      }
    }
    function dumpByUser(cur, uid) {
      if (!cur) return;
      if (cur.uid === uid) {
        if (T.dumped) T.out += "\n";       // putchar, so it costs no column
        dumpTree(cur, 0, 1, 1, 1, uid, 0);
        T.dumped = 1;
        return;
      }
      cur.children.forEach(function (c) { dumpByUser(c, uid); });
    }
    // -s with a pid: show that process and the line of ancestors above it by
    // throwing its siblings away at every level up to the root.
    function trimByParent(self) {
      if (!self) return;
      var parent = self.parent;
      if (!parent) return;
      parent.children = [];
      addChild(parent, self);
      trimByParent(parent);
    }

    // ---- names ------------------------------------------------------------
    function passwdRows() {
      var text = V.readFile("/etc/passwd") || "";
      return String(text).split("\n").map(function (line) {
        var f = line.split(":");
        return f.length >= 3 ? { name: f[0], uid: +f[2] } : null;
      }).filter(function (r) { return !!r; });
    }
    function userForUid(uid) {
      var rows = passwdRows();
      for (var i = 0; i < rows.length; i++) if (rows[i].uid === uid) return rows[i].name;
      return null;
    }

    // tgetent() against the one terminal this console is: TERM=linux, whose
    // enter-bold is ESC[1m and whose leave-bold is ESC[m followed by
    // shift-in, which is exactly what `pstree -h` prints on a real box with
    // this TERM.  Nothing else here speaks termcap.
    function caps() { T.md = "\u001b[1m"; T.me = "\u001b[m\u000f"; }
    function termcap() { return !!(T.env.TERM && T.env.TERM.length); }
    function myPid() { return (sh && sh._cmdPid) || (sh && sh.pid) || 1; }

    // ---- options ----------------------------------------------------------
    // getopt_long() as psmisc calls it: GNU's complaints, and GNU's
    // permutation of the words, so `pstree 1 -p` is `pstree -p 1`.
    function complaint(msg) {
      T.err += "pstree: " + msg + "\n";
      usage();
    }
    function apply(c, arg) {
      switch (c) {
        case "a": T.printArgs = 1; break;
        case "A": T.sym = PSTREE_SYM.ascii; break;
        case "c": T.compact = 0; break;
        case "C":
          if (String(arg) === "age") T.colorAge = 1;
          else usage();
          break;
        case "G": T.sym = PSTREE_SYM.vt100; break;
        case "h":
          if (T.highlight) usage();
          // tgetent() runs only here and in -H; without it tgetstr() has
          // nothing to hand back and the highlight prints no escape at all.
          if (termcap()) { caps(); T.highlight = myPid(); }
          break;
        case "H":
          if (T.highlight) usage();
          if (!T.env.TERM) { T.err += "TERM is not set\n"; bail(1); }
          if (!termcap()) { T.err += "Can't get terminal capabilities\n"; bail(1); }
          if (!parseInt(arg, 10)) usage();
          caps();
          T.highlight = parseInt(arg, 10);
          break;
        case "l": T.trunc = 0; break;
        case "n": T.byPid = 1; break;
        case "N":
          if (!PSTREE_NS.hasOwnProperty(String(arg))) usage();
          T.nsid = String(arg);
          break;
        case "p": T.pids = 1; T.compact = 0; break;
        case "g": T.pgids = 1; break;
        case "s": T.showParents = 1; break;
        case "S": T.nsChange = 1; break;
        case "t": T.threadNames = 1; break;
        case "T": T.hideThreads = 1; break;
        case "u": T.userChange = 1; break;
        case "U": T.sym = PSTREE_SYM.utf; break;
        case "V":
          T.err += LW.PSVER.pstree.join("\n") + "\n";
          bail(0);
          break;
        case "Z": T.showScontext = 1; break;
        default: usage();
      }
    }
    function parseOptions() {
      var operands = [], i = 0;
      while (i < args.length) {
        var w = args[i];
        if (w === "--") { i++; while (i < args.length) operands.push(args[i++]); break; }
        if (w.length > 1 && w.charAt(0) === "-") {
          if (w.charAt(1) === "-") {
            var body = w.slice(2), eq = body.indexOf("="),
                name = eq >= 0 ? body.slice(0, eq) : body,
                inline = eq >= 0 ? body.slice(eq + 1) : null,
                ch = PSTREE_LONG.hasOwnProperty(name) ? PSTREE_LONG[name] : null;
            if (ch === null) complaint("unrecognized option '--" + name + "'");
            var arg = null;
            if (PSTREE_OPT.takes[ch]) {
              if (inline !== null) arg = inline;
              else if (i + 1 < args.length) arg = args[++i];
              else complaint("option '--" + name + "' requires an argument");
            } else if (inline !== null) {
              complaint("option '--" + name + "' doesn't allow an argument");
            }
            apply(ch, arg);
            i++;
          } else {
            var j = 1;
            while (j < w.length) {
              var c = w.charAt(j), a = null;
              if (!PSTREE_OPT.valid[c]) complaint("invalid option -- '" + c + "'");
              if (PSTREE_OPT.takes[c]) {
                if (j + 1 < w.length) { a = w.slice(j + 1); j = w.length; }
                else if (i + 1 < args.length) { a = args[++i]; j = w.length; }
                else complaint("option requires an argument -- '" + c + "'");
              } else j++;
              apply(c, a);
            }
            i++;
          }
        } else { operands.push(w); i++; }
      }
      return operands;
    }

    // ---- main -------------------------------------------------------------
    var code = 0;
    try {
      // get_output_width(): COLUMNS, then the terminal, then 132 -- what
      // psmisc falls back to when stdout is a pipe.
      var ce = T.env.COLUMNS;
      if (ce && /^\d+$/.test(String(ce)) && +ce > 0 && +ce < 0x7fffffff) T.cols = +ce;
      else T.cols = LW.TEXT_COLS || 80;
      // find_root_pid(): pid 0 exists in a container, otherwise it is 1.
      var rootPid = P.get(0) ? 0 : 1;
      // psmisc picks its line-drawing set from the locale: UTF-8 symbols when
      // stdout is a terminal speaking UTF-8, ASCII otherwise.  The shell's
      // output is the terminal, and LANG here is C.UTF-8.
      var cs = T.env.LC_ALL || T.env.LC_CTYPE || T.env.LANG || "";
      T.sym = (cs && /UTF-?8/i.test(cs)) ? PSTREE_SYM.utf : PSTREE_SYM.ascii;

      var operands = parseOptions();
      var pid = rootPid, pidSet = false, pw = null;
      if (operands.length === 1) {
        var op = operands[0];
        if (/^\d/.test(op)) {
          var m = /^\d+/.exec(op);
          pid = +m[0];
          pidSet = true;
          if (op.length !== m[0].length) usage();   // strtol left endptr behind
        } else {
          pw = passwdRows().filter(function (r) { return r.name === op; })[0];
          if (!pw) { T.err += "No such user name: " + op + "\n"; bail(1); }
        }
      }
      if (operands.length > 1) usage();

      readProc(rootPid);
      for (var cur = findProc(T.highlight); cur; cur = cur.parent) cur.flags |= 1;

      if (T.showParents && pidSet) {
        var picked = findProc(pid);
        if (!picked) { T.err += "Process " + pid + " not found.\n"; bail(1); }
        trimByParent(picked);
        pid = rootPid;
      }

      if (T.nsid) {
        T.nodes.forEach(function (n) { n.nsVal = nsVal(n); });
        var groups = [];
        detachTo(findProc(1), groups);
        groups.forEach(function (g) {
          outStr("[" + g.number + "]"); T.out += "\n"; T.curX = 1;
          g.roots.forEach(function (r) { dumpTree(r, 0, 1, 1, 1, 0, 0); });
        });
      } else if (!pw) dumpTree(findProc(pid), 0, 1, 1, 1, 0, 0);
      else {
        dumpByUser(findProc(rootPid), pw.uid);
        if (!T.dumped) { T.err += "No processes found.\n"; bail(1); }
      }
    } catch (x) {
      if (!x || !x.pstreeExit) throw x;
      code = x.code | 0;
    }
    if (T.err && sh && sh._error) sh._error(T.err.replace(/\n$/, ""));
    return { out: T.out, code: code };
  }

  def("pstree", runPstree, "display a tree of processes");
})(window.LW);
