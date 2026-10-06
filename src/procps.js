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
  // enough for a seven-digit pid.
  var PIDMAX = {
    cputime: 1, cutime: 1, pgid: 1, ppid: 1, pid: 1, sess: 1, spid: 1,
    taskid: 1, tgid: 1, tid: 1, lwp: 1, tpgid: 1, pr26_pmapx: 1,
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
  VAL.label = function (e, S, m) { return escapeStr("unconfined", m); };

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
    return String(Math.max(0, Math.floor(LW.uptime() - e.since)));
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

  // @MORE@
})(window.LW = window.LW || {});
