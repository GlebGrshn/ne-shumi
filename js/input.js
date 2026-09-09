// Клавиатура (WASD/стрелки + Shift) и тач-джойстик:
// палец ставится где угодно, вектор от точки касания, дальний край = бег.

export const Input = {
  keys: {},
  touch: null,        // {sx,sy, x,y}
  moveX: 0, moveY: 0, // -1..1
  running: false,
  interactPressed: false,
  pausePressed: false,
  isTouchDevice: false,

  init(canvas) {
    window.addEventListener('keydown', e => {
      if (e.repeat) return;
      this.keys[e.code] = true;
      if (e.code === 'KeyE' || e.code === 'Space') this.interactPressed = true;
      if (e.code === 'Escape') this.pausePressed = true;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', e => { this.keys[e.code] = false; });
    window.addEventListener('blur', () => { this.keys = {}; this.touch = null; });

    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') return;
      this.isTouchDevice = true;
      if (!this.touch) {
        this.touch = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY };
        canvas.setPointerCapture(e.pointerId);
      }
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', e => {
      if (this.touch && e.pointerId === this.touch.id) {
        this.touch.x = e.clientX; this.touch.y = e.clientY;
      }
    });
    const endTouch = e => {
      if (this.touch && e.pointerId === this.touch.id) this.touch = null;
    };
    canvas.addEventListener('pointerup', endTouch);
    canvas.addEventListener('pointercancel', endTouch);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  },

  update() {
    let mx = 0, my = 0, run = false;
    const k = this.keys;
    if (k['KeyW'] || k['ArrowUp']) my -= 1;
    if (k['KeyS'] || k['ArrowDown']) my += 1;
    if (k['KeyA'] || k['ArrowLeft']) mx -= 1;
    if (k['KeyD'] || k['ArrowRight']) mx += 1;
    run = !!(k['ShiftLeft'] || k['ShiftRight']);

    if (this.touch) {
      const dx = this.touch.x - this.touch.sx;
      const dy = this.touch.y - this.touch.sy;
      const d = Math.hypot(dx, dy);
      const dead = 14, runDist = 78;
      if (d > dead) {
        const m = Math.min(1, (d - dead) / 50);
        mx = (dx / d) * m; my = (dy / d) * m;
        run = d > runDist;
      }
    }

    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    this.moveX = mx; this.moveY = my;
    this.running = run && len > 0.05;
  },

  consumeInteract() { const v = this.interactPressed; this.interactPressed = false; return v; },
  consumePause() { const v = this.pausePressed; this.pausePressed = false; return v; },
};
