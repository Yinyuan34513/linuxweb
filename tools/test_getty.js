// Tests for: SHA-256, the getty/login flow, and the IDBFS round-trip.
const fs = require("fs"), vm = require("vm"), path = require("path");

const dir = path.join(__dirname, "..");

function Term() { this.cols = 80; this.rows = 25; this.col = 0; this.row = 0; this.text = ""; }
Term.prototype.write = function (s) { this.text += s; };
Term.prototype.putChar = function (c) { this.text += String.fromCharCode(c); };
Term.prototype.setCursor = function () {};
Term.prototype.render = function () {};
Term.prototype.clear = function () { this.text = ""; };

// --- a small synchronous-ish IndexedDB stand-in -----------------------------
function FakeIDB() {
  const data = new Map();
  const stores = new Set();
  return {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n) => stores.add(n),
          close() {},
          transaction() {
            const tx = { oncomplete: null, onabort: null, onerror: null };
            const os = {
              transaction: tx,
              put(r) { data.set(r.path, JSON.parse(JSON.stringify(r))); return {}; },
              delete_(k) { data.delete(k); },
              delete(k) { data.delete(k); return {}; },
              getAll() {
                const r = {};
                setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0);
                r.result = [...data.values()];
                return r;
              },
              clear() {
                data.clear();
                const r = {};
                setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0);
                return r;
              },
            };
            tx.objectStore = () => os;
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
            return tx;
          },
        };
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
    _data: data,
  };
}

const idb = FakeIDB();
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Date, atob, indexedDB: idb, window: {} };
vm.createContext(ctx);
for (const f of ["src/bash.data.js", "src/help.js", "src/sha256.js", "src/vfs.js", "src/bash.js", "src/getty.js"]) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), "utf8"), ctx, { filename: f });
}
const LW = ctx.window.LW;
LW.clock = () => "09:14:03";
LW.stampedLog = "";
const V = LW.VFS;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " -- " + extra : "")); }
}

console.log("--- complete Ctrl+ tables ---");
const ALL_CTRL = "abcdefghijklmnopqrstuvwxyz@[\\]^_?".split("");
function fullTable(tbl, label) {
  const missing = ALL_CTRL.filter((c) => !Object.prototype.hasOwnProperty.call(tbl, c));
  check(label + " has all " + ALL_CTRL.length + " Ctrl+ bindings", missing.length === 0,
    "missing: " + JSON.stringify(missing));
}
fullTable(LW.SHELL_CTRL, "shell");
fullTable(LW.GETTY_CTRL, "getty");

console.log("--- sha256 ---");
check("sha256('')", LW.sha256("") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
check("sha256('abc')", LW.sha256("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
check("linuxweb password", LW.checkPassword("$sha256$linuxweb$181e95d0a42855bc2196f21b072655a998d9f4bb2f73f94a3d2ae3e55f095c79", "linuxweb"));
check("wrong password rejected", !LW.checkPassword("$sha256$linuxweb$181e95d0a42855bc2196f21b072655a998d9f4bb2f73f94a3d2ae3e55f095c79", "nope"));

function keys(term, g, s) {
  for (const ch of s) g.onKey({ key: ch, ctrlKey: false, altKey: false, metaKey: false });
  g.onKey({ key: "Enter", ctrlKey: false, altKey: false, metaKey: false });
}

function scenario(name, user, password, expectSuccess) {
  const term = new Term();
  let loggedIn = null;
  const g = new LW.Getty(term, (u) => { loggedIn = u; });
  g.start();
  g.onKey({ key: "Enter", ctrlKey: false, altKey: false });      // blank -> re-prompt
  keys(term, g, user);
  keys(term, g, password);
  // fail() delays the next prompt, so drain timers via a synchronous check
  check(name, expectSuccess ? loggedIn === user : loggedIn === null,
    "loggedIn=" + loggedIn + " output=" + JSON.stringify(term.text.slice(-80)));
  return term;
}

console.log("--- getty / login ---");
scenario("correct login", "linuxweb", "linuxweb", true);
scenario("wrong password", "linuxweb", "hunter2", false);
scenario("unknown user", "nobody", "x", false);
scenario("root login", "root", "root", true);

console.log("--- IDBFS ---");
V.open({}, function (okd) {
  check("open seeds the store", okd === true, "okd=" + okd);
  V.writeFile("/tmp/persist.txt", "hello idbfs\n", false);
  V.mkdirp("/tmp/deep/er");
  V.writeFile("/tmp/deep/er/f.txt", "nested\n", false);
  V.syncfs(false, function (ok) {
    check("syncfs flush", ok === true);
    const s1 = V.stats();
    check("stats counts files", s1.files > 5 && s1.dirs > 3, JSON.stringify(s1));

    // Simulate a reload: rebuild the in-memory tree from the store only.
    V.syncfs(true, function (ok2) {
      check("syncfs populate", ok2 === true);
      check("file survived reload", V.readFile("/tmp/persist.txt") === "hello idbfs\n");
      check("nested dir survived", V.readFile("/tmp/deep/er/f.txt") === "nested\n");
      check("generated /proc still there", (V.readFile("/proc/version") || "").indexOf("Linux version") === 0);

      V.unlink("/tmp/deep/er/f.txt");
      V.syncfs(false, function () {
        V.syncfs(true, function () {
          check("delete survives reload", V.readFile("/tmp/deep/er/f.txt") === null);
          const s2 = V.stats();
          check("pending drained", s2.pending === 0, JSON.stringify(s2));

          // A retry after a failed login must behave exactly like the first try.
          const term = new Term();
          let loggedIn = null;
          const g = new LW.Getty(term, (u) => { loggedIn = u; });
          g.start();
          keys(term, g, "linuxweb");
          keys(term, g, "hunter2");            // wrong password
          check("first attempt failed", loggedIn === null);
          setTimeout(() => {
            const before = term.text.length;
            keys(term, g, "root");             // must echo, like the first attempt
            const echoed = term.text.slice(before);
            check("retry echoes the username", echoed.indexOf("root") >= 0, JSON.stringify(echoed));
            keys(term, g, "root");
            check("retry login succeeds as root", loggedIn === "root");

            // Regression: a store seeded by an older version lacks /etc/shadow.
            // Reloading must merge missing defaults, otherwise correct
            // credentials are rejected forever.
            V.unlink("/etc/shadow");
            V.syncfs(false, function () {
              check("shadow really gone from the store", V.readFile("/etc/shadow") === null);
              V.syncfs(true, function () {
                check("missing default re-merged on load", V.readFile("/etc/shadow") !== null);
                const t2 = new Term();
                let who = null;
                const g2 = new LW.Getty(t2, (u) => { who = u; });
                g2.start();
                keys(t2, g2, "linuxweb");
                keys(t2, g2, "linuxweb");
                check("login works after the merge", who === "linuxweb", "who=" + who);

                console.log("\n" + pass + " passed, " + fail + " failed");
                process.exit(fail ? 1 : 0);
              });
            });
          }, 1300);
        });
      });
    });
  });
});
