const fs = require("fs"), vm = require("vm"), path = require("path");

function Term() { this.cols = 80; this.rows = 25; this.col = 0; this.row = 0; this.text = ""; }
Term.prototype.write = function (s) { this.text += s; };
Term.prototype.putChar = function (c) { this.text += String.fromCharCode(c); };
Term.prototype.setCursor = function () {};
Term.prototype.render = function () {};
Term.prototype.clear = function () { this.text = ""; };

const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, atob, window: {} };
vm.createContext(ctx);
const dir = path.join(__dirname, "..");
for (const f of ["src/bash.data.js", "src/help.js", "src/vfs.js", "src/bash.js"]) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
}
const LW = ctx.window.LW;
LW.clock = () => "09:14:03";
LW.stampedLog = "[    0.000000] Linux version 7.2.8\n[    0.950000] Run /sbin/init as init process\n";
LW.plainLog = LW.stampedLog;

const term = new Term();
const sh = new LW.Shell(term);

let pass = 0, fail = 0;
function run(cmd) { sh.runLine(cmd, false); return sh.lastOut; }
function check(name, cmd, want) {
  let got;
  try { got = run(cmd); } catch (e) { got = "THREW: " + e.message; }
  const ok = typeof want === "function" ? want(got) : got === want;
  if (ok) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + "\n       cmd: " + cmd + "\n       got: " + JSON.stringify(got) + "\n      want: " + JSON.stringify(want)); }
}

console.log("--- builtins / expansion ---");
check("echo", "echo hello world", "hello world\n");
check("vars", "USER=root; echo $USER", "root\n");
check("braces", "export FOO=bar; echo ${FOO}baz", "barbaz\n");
check("status", "true; echo $?", "0\n");
check("status err", "false; echo $?", "1\n");
check("subst", "echo $(uname -s)", "Linux\n");
check("andor", "true && echo yes", "yes\n");
check("andor2", "false || echo fallback", "fallback\n");
check("seq/pipe", "seq 1 5 | wc -l", "      5\n");

console.log("--- coreutils ---");
check("pwd", "pwd", "/home/linuxweb\n");
check("cd + pwd", "cd /etc; pwd", "/etc\n");
check("cd back", "cd ~; pwd", "/home/linuxweb\n");
check("cat", "cat /etc/hostname", "linuxweb\n");
check("head", "seq 1 100 | head -n 3", "1\n2\n3\n");
check("tail", "seq 1 100 | tail -n 2", "99\n100\n");
check("grep", "grep -i debian /etc/os-release", (o) => o.includes("PRETTY_NAME"));
check("cut", "echo a:b:c | cut -d: -f2", "b\n");
check("tr", "echo abc | tr a-z A-Z", "ABC\n");
check("sort", "printf 'b\\na\\nc\\n' | sort", "a\nb\nc\n");
check("uniq", "printf 'a\\na\\nb\\n' | uniq", "a\nb\n");
check("sed", "echo hello | sed s/l/L/g", "heLLo\n");
check("wc", "printf 'a b c\\n' | wc -w", "      3\n");
check("glob", "echo /etc/host*", "/etc/hostname /etc/hosts\n");
check("ls", "ls /etc", (o) => o.includes("os-release") && o.includes("hostname"));
check("uname", "uname -s", "Linux\n");
check("dmesg", "dmesg | tail -1", "[    0.950000] Run /sbin/init as init process\n");
check("type", "type cd", "cd is a shell builtin\n");

console.log("--- redirection (goes through the VFS) ---");
check("write", "echo hello > /tmp/x; cat /tmp/x", "hello\n");
check("append", "echo world >> /tmp/x; cat /tmp/x", "hello\nworld\n");
check("pipe file", "cat /tmp/x | tr a-z A-Z", "HELLO\nWORLD\n");
check("read redirect", "wc -l < /tmp/x", "      2\n");

console.log("--- control flow ---");
check("for", "for i in a b c; do echo $i; done", "a\nb\nc\n");
check("if true", "if [ -f /etc/hostname ]; then echo yes; fi", "yes\n");
check("if false", "if [ -f /nope ]; then echo yes; fi", "");
check("while", "N=0; while [ $N -lt 3 ]; do echo $N; N=$((N+1)); done", (o) => o === "" || o === "0\n1\n2\n");

console.log("--- vfs mutation + aliases ---");
check("mkdir/touch", "mkdir -p /tmp/a/b && touch /tmp/a/b/f && ls /tmp/a/b", "f\n");
check("rm", "rm /tmp/a/b/f && ls /tmp/a/b", "");
check("alias", "alias hi='echo hey'; hi", "hey\n");
check("command not found -> Debian handler", "definitely_not_a_command 2>&1",
  (o) => o.indexOf("not found, but can be installed with") >= 0 && o.indexOf("apt install definitely_not_a_command") >= 0);
check("path-shaped miss: no such file", "nosuchdir/x 2>&1",
  "bash: nosuchdir/x: No such file or directory\n");
check("dir as command exit code", "nosuchdir/x >/dev/null 2>&1; ./Documents >/dev/null 2>&1; echo $?", "126\n");
check("directory as command", "./Documents 2>&1", "bash: ./Documents: Is a directory\n");
check("missing path exit code 127", "nosuchdir/x >/dev/null 2>&1; echo $?", "127\n");
check("Permission denied", "/etc/passwd 2>&1", "bash: /etc/passwd: Permission denied\n");
check("plain miss exit code", "definitely_not_a_command >/dev/null; echo $?", "127\n");
check("tree", "tree /etc | head -n 1", "/etc\n");

console.log("--- help ---");
check("help -s cd (bash 5.3 wording)", "help -s cd", "cd: cd [-L|[-P [-e]]] [-@] [dir]\n");
check("help -d cd", "help -d cd", "cd - Change the shell working directory.\n");
check("help cd has description", "help cd", (o) => o.indexOf("cd: cd [") === 0 && o.indexOf("Change the current directory to DIR") > 0);
check("help cd is long", "help | wc -l", (o) => parseInt(o, 10) > 20);
check("help -m cd is man shaped", "help -m cd", (o) => o.indexOf("NAME\n") === 0 && o.indexOf("SYNOPSIS") > 0 && o.indexOf("DESCRIPTION") > 0);
check("help glob", "help 'pw*' -s", "pwd: pwd [-LP]\n");
check("help echo usage", "help echo", (o) => o.indexOf("echo: echo [-neE] [arg ...]") === 0);
check("help echo escape table", "help echo", (o) => o.indexOf("  -e\tenable interpretation") > 0 && o.indexOf("\\0nnn\tthe character") > 0);
check("help : (null command)", "help :", ":: :\n    Null command.\n    \n    No effect; the command does nothing.\n    \n    Exit Status:\n    Always succeeds.\n");
check("help true", "help true", "true: true\n    Return a successful result.\n    \n    Exit Status:\n    Always succeeds.\n");
check("help unknown topic -> stderr", "help nosuchtopic", "");
check("help unknown topic (merged, real wording)", "help nosuchtopic 2>&1",
  "bash: help: no help topics match `nosuchtopic'.  Try `help help' or `man -k nosuchtopic' or `info nosuchtopic'.\n");
check("set -o first line", "set -o | head -1", "allexport      \toff\n");
check("set -o emacs", "set -o | grep --color=never emacs", "emacs          \ton\n");
check("set +o first line", "set +o | head -1", "set +o allexport\n");
check("bind -P line count (leading blank included)", "bind -P | wc -l", "    174\n");
check("bind -P abort line", "bind -P | grep --color=never '^abort '", 'abort can be found on "\\C-g", "\\C-x\\C-g", "\\M-\\C-g".\n');

console.log("--- functions ---");
check("function definition", "f() { echo hi; }; f", "hi\n");
check("function args", "g() { echo \"$1-$2\"; }; g a b", "a-b\n");
check("function return code", "f() { return 7; }; f; echo $?", "7\n");
check("$# inside function", "h() { echo $#; }; h a b c", "3\n");
check("type function", "f() { echo hi; }; type f", "f is a function\n");
check("type builtin", "type echo", "echo is a shell builtin\n");
check("which finds builtins", "which echo", "/usr/bin/echo\n");

console.log("--- help listing: bash's complete list ---");
check("listing row count (8 header + 38)", "help | wc -l", "     46\n");
check("first cell is job_spec", "help | sed -n '9p' | cut -c1-13", " job_spec [&");
check("right column top is history", "help | head -n 9 | tail -n 1 | cut -c41-47", "history");
check("left column bottom is help", "help | tail -1 | cut -c1-5", " help");
check("right column bottom is { COMMANDS ; }", "help | tail -1 | cut -c41-54", "{ COMMANDS ; }");
check("includes mapfile", "help | grep --color=never -c mapfile", "1\n");
check("includes coproc", "help | grep --color=never -c coproc", "1\n");
check("includes for ((", "help | grep --color=never -c 'for (('", "1\n");
check("includes variables", "help | grep --color=never -c variables", "1\n");
check("5.3 usage: source -p", "help -s source", "source: source [-p path] filename [arguments]\n");
check("5.3 usage: cd", "help -s cd", "cd: cd [-L|[-P [-e]]] [-@] [dir]\n");
check("5.3 usage: compgen -V", "help -s compgen", (o) => o.indexOf("[-V varname]") > 0);
check("5.3 usage: read -Eers", "help -s read", (o) => o.indexOf("[-Eers]") > 0);
check("our own builtins are documented", "help -s clear", "clear: clear\n");
check("...but not in bash's listing", "help | grep --color=never -c 'clear'", "0\n");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
