// Multiple virtual terminals on one canvas, switched with Ctrl+Alt+F1..F6 or
// `chvt`, exactly like the Linux console.  Only the active VT is composited and
// only it blinks, so the inactive screens cost nothing but their buffers.
(function (LW) {
  "use strict";

  var VTs = {
    screens: [],
    index: 0,
    count: 6,
    canvas: null,
    onSwitch: null,
  };

  VTs.init = function (canvas, opts, count) {
    VTs.canvas = canvas;
    VTs.count = count || 6;
    VTs.screens = [];
    for (var i = 0; i < VTs.count; i++) {
      var term = new LW.VGAText(canvas, opts);
      term.vt = i + 1;                       // tty1..tty6
      VTs.screens.push(term);
    }
    VTs.index = 0;
    // Every VGAText starts its own blink timer; only the active one may run.
    VTs.screens.forEach(function (s, i) {
      s.stopBlink();
      s.paintEnabled = (i === 0);
    });
    VTs.screens[0].startBlink();
    VTs.screens[0].render();
    return VTs.screens;
  };

  VTs.active = function () { return VTs.screens[VTs.index]; };
  VTs.activeIndex = function () { return VTs.index; };
  VTs.activeVt = function () { return VTs.index + 1; };
  VTs.screen = function (vt) { return VTs.screens[vt - 1]; };

  // vt is 1-based, as in /dev/ttyN.
  VTs.switchTo = function (vt) {
    var i = vt - 1;
    if (i < 0 || i >= VTs.count) return false;
    if (i === VTs.index) return true;
    var old = VTs.screens[VTs.index];
    old.stopBlink();
    old.paintEnabled = false;
    VTs.index = i;
    var t = VTs.screens[i];
    t.paintEnabled = true;
    t.startBlink();
    t.render();
    if (VTs.onSwitch) VTs.onSwitch(i);
    return true;
  };

  LW.VTs = VTs;
})(window.LW);
