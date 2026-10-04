// Boot the console: replay the kernel log on tty1 (stamping each line with the
// real elapsed time, measured at runtime), then hand every virtual terminal to
// getty.  Ctrl+Alt+F1..F6 switches VTs, like the Linux console.
(function (LW) {
  "use strict";

  var canvas = document.getElementById("screen");
  // Palette: "xterm" (modern-terminal systemd look, default) or "vga" (the
  // Linux console/vgacon palette).  Override with ?palette=vga.
  var palette = /[?&]palette=vga\b/.test(location.search) ? "vga" : "xterm";

  var VT_COUNT = 6;
  var screens = LW.VTs.init(canvas, { cursor: true, palette: palette }, VT_COUNT);
  var term = screens[0];                 // the boot log goes to tty1

  var lines = LW.KLOG || [];
  var wantInstant = /[?&]instant=1\b/.test(location.search);
  var noShell = /[?&]shell=0\b/.test(location.search);
  var resetFs = /[?&]fs=reset\b/.test(location.search);

  function num(name, def) {
    var m = new RegExp("[?&]" + name + "=([0-9.]+)").exec(location.search);
    return m ? parseFloat(m[1]) : def;
  }
  var minDelay = num("minDelay", 24);
  var timeScale = num("timeScale", 1800);

  // Wall-clock string for the shell prompt (\t).
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  LW.clock = function () {
    var d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  };

  // Scale the 640x400 canvas by the largest integer factor that fits.
  function fit() {
    var s = Math.max(1, Math.min(
      Math.floor(window.innerWidth / term.W),
      Math.floor(window.innerHeight / term.H)));
    canvas.style.width = term.W * s + "px";
    canvas.style.height = term.H * s + "px";
  }
  fit();
  window.addEventListener("resize", fit);

  // ---- runtime klog timestamps -------------------------------------------
  // The generated data carries only a planned delay per line; the timestamp is
  // measured here, so it reflects how long this boot actually took.
  function stamp(sec) {
    var s = Math.floor(sec), u = Math.round((sec - s) * 1e6);
    if (u >= 1e6) { s++; u -= 1e6; }
    return "[" + String(s).padStart(5, " ") + "." + String(u).padStart(6, "0") + "] ";
  }

  var stamped = "";
  function emit(line, elapsed) {
    var text = (line.raw ? "" : stamp(elapsed)) + line.t;
    stamped += text + "\n";
    term.write(text);
    term.write("\n");
  }

  // ---- per-VT sessions ----------------------------------------------------
  var handlers = [];                     // one console layer per VT

  function startShell(i, user) {
    var sh = new LW.Shell(screens[i]).applyUser(user);
    handlers[i] = sh;
    sh.start(false);                     // login(1) already printed the motd
  }

  function startGetty(i) {
    if (!LW.Getty) { handlers[i] = null; return; }
    var g = new LW.Getty(screens[i], function (user) { startShell(i, user); });
    handlers[i] = g;
    g.start();
  }

  function finish() {
    booting = false;
    term.render();
    LW.stampedLog = stamped;
    LW.plainLog = lines.map(function (l) { return l.t; }).join("\n") + "\n";
    // Drop the boot log where a real system keeps it (and thus into IndexedDB).
    try { LW.VFS.writeFile("/var/log/dmesg", stamped, false); } catch (e) { /* ignore */ }
    if (noShell) return;
    for (var i = 0; i < VT_COUNT; i++) startGetty(i);   // gettys on every VT
    var want = num("vt", 1);                            // ?vt=N starts on ttyN
    if (want > 1) LW.VTs.switchTo(Math.min(VT_COUNT, want));
  }

  function play() {
    term.clear();
    stamped = "";
    if (wantInstant) {
      var t = 0;
      lines.forEach(function (l) { if (!l.raw) t += l.d; emit(l, t); });
      finish();
      return;
    }
    var t0 = performance.now(), i = 0;
    (function step() {
      if (i >= lines.length) { finish(); return; }
      var line = lines[i++];
      var wait = skip ? 0 : (line.raw ? 18 : Math.max(minDelay, line.d * timeScale));
      setTimeout(function () {
        emit(line, (performance.now() - t0) / 1000);
        term.render();
        step();
      }, wait);
    })();
  }

  // Click or press a key to fast-forward the boot.
  var skip = false, booting = true;
  function hurry() { if (booting) skip = true; }
  window.addEventListener("click", hurry);

  // ---- keyboard: VT switching, then the active session --------------------
  window.addEventListener("keydown", function (e) {
    if (e.ctrlKey && e.altKey && !e.metaKey) {
      var m = /^F([1-9]|1[0-2])$/.exec(e.key);
      if (m) { LW.VTs.switchTo(parseInt(m[1], 10)); e.preventDefault(); return; }
    }
    if (e.metaKey) return;
    if (booting) { hurry(); return; }
    var h = handlers[LW.VTs.activeIndex()];
    if (!h) return;
    if (h.onKey(e)) e.preventDefault();
    // a login shell that exits drops us back to getty, like a real console
    if (h instanceof LW.Shell && !h.running) startGetty(LW.VTs.activeIndex());
  });

  // `chvt N` from the shell re-renders the newly active screen.
  LW.VTs.onSwitch = function () { LW.VTs.active().render(); };

  // Wait for the filesystem (IndexedDB) before booting; the shell needs it.
  LW.VFS.open({ reset: resetFs }, function () { play(); });
})(window.LW);
