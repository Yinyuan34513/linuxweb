// The login flow: /etc/issue, the prompts, a wrong password, and the
// "Last login" line -- which has to be generated at runtime rather than being
// a fixed string, and has to move on to the *previous* login each time.
//
//   node tools/test_getty.js
const { loadShell } = require("./shell_harness.js");

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; console.log("  ok   " + name); return; }
  fail++;
  console.log("  FAIL " + name + "\n       got  " + JSON.stringify(got) +
              "\n       want " + JSON.stringify(want));
}
function checkThat(name, got, re) {
  if (re.test(got)) { pass++; console.log("  ok   " + name); return; }
  fail++;
  console.log("  FAIL " + name + "\n       got  " + JSON.stringify(got) +
              "\n       want a match for " + re);
}

// A terminal that records what was written, standing in for the VT canvas.
function Screen(vt) {
  this.cols = 80; this.rows = 25; this.text = ""; this.vt = vt || 1;
}
Screen.prototype.write = function (s) { this.text += s; };
Screen.prototype.putChar = function () {};
Screen.prototype.setCursor = function () {};
Screen.prototype.render = function () {};
Screen.prototype.clear = function () { this.text = ""; };

// Drive the getty the way a person would: type, then press Enter.
function type(g, text) {
  for (const ch of text) {
    g.buf += ch;
    g.cursor = g.buf.length;
  }
  g.accept();
}

// One console for the whole run, so /var/log/lastlogin survives from one
// login to the next the way it does on a real machine.
const world = loadShell();
let clockMs = Date.now();
world.LW.now = function () { return new Date(clockMs); };
world.LW.bootTime = function () { return new Date(clockMs - 3600 * 1000); };
world.LW.uptime = function () { return 3600; };

function login(password, whenMs, vt) {
  if (whenMs !== undefined) clockMs = whenMs;
  const screen = new Screen(vt || 1);
  let user = null;
  const g = new world.LW.Getty(screen, function (u) { user = u; });
  g.start();
  type(g, "linuxweb");
  type(g, password === undefined ? "linuxweb" : password);
  return { screen: screen, getty: g, LW: world.LW, user: user };
}

// the record is a real file, so clear it before the first-login case
try { world.LW.VFS.writeFile("/var/log/lastlogin", "", false); } catch (e) { /* fresh */ }

console.log("--- the login prompts ---");
{
  const r = login();
  checkThat("the host's issue banner appears",
    r.screen.text, /login: /);
  check("a good password starts a shell", r.user, "linuxweb");
  checkThat("Last login is printed", r.screen.text,
    /Last login: [A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d UTC \d{4} on tty1/);
}

console.log("--- the Last login line is generated, not fixed ---");
{
  // no record at all: login falls back to the time this boot started
  try { world.LW.VFS.writeFile("/var/log/lastlogin", "", false); } catch (e) { /* fresh */ }
  const first = login(undefined, Date.UTC(2024, 0, 15, 10, 30, 0));
  checkThat("the boot time is used when there is no record",
    first.screen.text, /Last login: Mon Jan 15 09:30:00 UTC 2024 on tty1/);

  // log in again later: the line must report the *earlier* login
  const second = login(undefined, Date.UTC(2024, 0, 16, 8, 5, 0));
  checkThat("a later login reports the earlier one",
    second.screen.text, /Last login: Mon Jan 15 10:30:00 UTC 2024 on tty1/);

  // and the record moves on
  const third = login(undefined, Date.UTC(2024, 0, 17, 22, 15, 30));
  checkThat("the newest login is remembered",
    third.screen.text, /Last login: Tue Jan 16 08:05:00 UTC 2024 on tty1/);
}

console.log("--- the terminal's own name ---");
{
  // login(1) reports the tty the *previous* session used, and records the one
  // this login came in on
  const r = login(undefined, Date.UTC(2024, 0, 15, 10, 30, 0), 3);
  checkThat("the line keeps the previous tty", r.screen.text, /on tty1/);
  checkThat("the record names the tty just used",
    String(r.LW.VFS.readFile("/var/log/lastlogin")), / tty3\n$/);
}

console.log("--- a wrong password ---");
{
  const r = login("nope");
  checkThat("Login incorrect is reported", r.screen.text, /Login incorrect/);
  check("and no shell is started", r.user, null);
}

console.log("--- the record lives in the filesystem ---");
{
  const r = login(undefined, Date.UTC(2024, 0, 15, 10, 30, 0));
  const raw = r.LW.VFS.readFile("/var/log/lastlogin");
  checkThat("/var/log/lastlogin holds the time and the tty",
    String(raw), /^\d{13} tty1\n$/);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);