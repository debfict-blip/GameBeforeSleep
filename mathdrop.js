(() => {
  const BEST_KEY = 'md-best';
  const LANES = 3;
  const CHIP_H = 38;
  const MAX_LIVES = 3;
  const SOLVES_PER_LEVEL = 8;

  const $ = (id) => document.getElementById(id);
  const view = $('mathView');
  const field = $('mdField');
  const answerEl = $('mdAnswer');
  const overlay = $('mdOverlay');
  const overlayMsg = $('mdOverlayMsg');
  const overlayBtn = $('mdOverlayBtn');
  const toast = $('mdToast');

  let best = 0;
  try { best = Number(localStorage.getItem(BEST_KEY)) || 0; } catch (e) { /* ignore */ }

  let eqs = [];
  let lives, score, level, typed, running, lastTs, spawnIn, nextId, raf = null;

  function cfg(l) {
    return {
      fall: Math.min(26 + l * 6, 110),        // px/sec
      spawn: Math.max(3.4 - l * 0.22, 1.2),   // sec between drops
    };
  }

  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  // Operations unlock as levels rise: + and − first, × at 3, ÷ at 6.
  // All answers are whole, non-negative numbers.
  function makeEquation(l) {
    const ops = ['+', '−'];
    if (l >= 3) ops.push('×');
    if (l >= 6) ops.push('÷');
    const op = ops[rnd(0, ops.length - 1)];
    const add = Math.min(5 + l * 3, 50);
    const mul = Math.min(4 + Math.floor(l / 2), 12);
    let a, b, answer;
    if (op === '+') { a = rnd(1, add); b = rnd(1, add); answer = a + b; }
    else if (op === '−') { a = rnd(2, add); b = rnd(1, a - 1); answer = a - b; }
    else if (op === '×') { a = rnd(2, mul); b = rnd(2, mul); answer = a * b; }
    else { b = rnd(2, mul); answer = rnd(2, mul); a = b * answer; }
    return { text: `${a} ${op} ${b}`, answer };
  }

  function fieldH() { return field.clientHeight; }

  function spawn() {
    const free = [];
    for (let lane = 0; lane < LANES; lane++) {
      if (!eqs.some((q) => q.lane === lane && q.y < CHIP_H + 14)) free.push(lane);
    }
    if (!free.length) return false;
    const lane = free[rnd(0, free.length - 1)];
    const { text, answer } = makeEquation(level);
    const el = document.createElement('div');
    el.className = 'mdEq';
    el.textContent = text;
    el.style.left = `${lane * 33.3 + 2}%`;
    field.appendChild(el);
    eqs.push({ id: nextId++, lane, text, answer, y: -CHIP_H, el });
    return true;
  }

  function renderTyped() {
    answerEl.textContent = typed === '' ? ' ' : typed;
  }

  function renderHud() {
    $('mdLevel').textContent = String(level);
    $('mdScore').textContent = String(score);
    $('mdBest').textContent = String(best);
    $('mdLives').textContent = '❤️'.repeat(lives) + '🖤'.repeat(MAX_LIVES - lives);
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');
  }

  function startGame() {
    eqs.forEach((q) => q.el.remove());
    eqs = [];
    lives = MAX_LIVES;
    score = 0;
    level = 1;
    typed = '';
    nextId = 1;
    spawnIn = 0.4;
    running = true;
    lastTs = null;
    overlay.classList.add('hidden');
    renderTyped();
    renderHud();
    if (raf === null) raf = requestAnimationFrame(step);
  }

  function gameOver() {
    running = false;
    if (score > best) {
      best = score;
      try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) { /* ignore */ }
    }
    renderHud();
    overlayMsg.textContent = `Game over — you solved ${score}${score === best && score > 0 ? ' (new best!)' : ''}`;
    overlayBtn.textContent = 'Play again';
    overlay.classList.remove('hidden');
  }

  function step(ts) {
    raf = null;
    if (!running) return;
    raf = requestAnimationFrame(step);

    // Pause while this tab isn't showing.
    if (view.classList.contains('hidden')) { lastTs = null; return; }
    if (lastTs === null) { lastTs = ts; return; }
    const dt = Math.min((ts - lastTs) / 1000, 0.1);
    lastTs = ts;

    const { fall, spawn: every } = cfg(level);
    const h = fieldH();

    spawnIn -= dt;
    if (spawnIn <= 0 && spawn()) spawnIn = every;

    for (const q of eqs.slice()) {
      q.y += fall * dt;
      q.el.style.transform = `translateY(${q.y}px)`;
      q.el.classList.toggle('low', q.y > h * 0.65);
      if (q.y + CHIP_H >= h - 4) {
        remove(q);
        lives -= 1;
        field.classList.remove('hit');
        void field.offsetWidth;
        field.classList.add('hit');
        renderHud();
        if (lives <= 0) { gameOver(); return; }
      }
    }
  }

  function remove(q, popped) {
    eqs = eqs.filter((x) => x !== q);
    if (popped) {
      q.el.classList.add('pop');
      setTimeout(() => q.el.remove(), 260);
    } else {
      q.el.remove();
    }
  }

  function submit() {
    if (!running || typed === '') return;
    const value = Number(typed);
    // Lowest matching equation first — the most urgent one.
    const hit = eqs.filter((q) => q.answer === value).sort((a, b) => b.y - a.y)[0];
    typed = '';
    renderTyped();
    if (!hit) {
      answerEl.classList.remove('shake');
      void answerEl.offsetWidth;
      answerEl.classList.add('shake');
      return;
    }
    remove(hit, true);
    score += 1;
    if (score % SOLVES_PER_LEVEL === 0) {
      level += 1;
      showToast(`Level ${level}!`);
    }
    renderHud();
  }

  function press(k) {
    if (!running) return;
    if (k === 'ok') return submit();
    if (k === 'back') typed = typed.slice(0, -1);
    else if (typed.length < 4) typed += k;
    renderTyped();
  }

  $('mdPad').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) press(b.dataset.k);
  });

  window.addEventListener('keydown', (e) => {
    if (view.classList.contains('hidden') || !running) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
    else if (e.key === 'Enter') press('ok');
  });

  overlayBtn.addEventListener('click', startGame);
  $('mdRestart').addEventListener('click', startGame);

  lives = MAX_LIVES; score = 0; level = 1; typed = '';
  renderHud();
})();
