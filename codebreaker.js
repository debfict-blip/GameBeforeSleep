(() => {
  const FRUITS = ['🍎', '🍋', '🫐', '🍇', '🥝', '🍊', '🍑', '🍉'];
  const START_HINTS = 2;
  const KEYS = { level: 'cb-level', stars: 'cb-stars', hints: 'cb-hints' };

  const $ = (id) => document.getElementById(id);
  const rowsEl = $('cbRows');
  const paletteEl = $('cbPalette');
  const messageEl = $('cbMessage');
  const overlay = $('cbOverlay');
  const overlayMsg = $('cbOverlayMsg');
  const overlayBtn = $('cbOverlayBtn');
  const hintBtn = $('cbHintBtn');
  const submitBtn = $('cbSubmitBtn');

  function loadInt(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (e) { /* not persisted */ }
  }

  let level = Math.max(1, loadInt(KEYS.level, 1));
  let stars = loadInt(KEYS.stars, 0);
  let hints = loadInt(KEYS.hints, START_HINTS);

  let cfg, secret, guesses, current, revealed, over;

  // Difficulty ramps: more fruits to choose from, then a longer code.
  // Repeats in the code only appear from level 3.
  function levelConfig(l) {
    const pegs = Math.min(3 + Math.floor((l - 1) / 4), 5);
    const colors = Math.min(4 + Math.floor((l - 1) / 2), FRUITS.length);
    return { pegs, colors, tries: pegs + 5, repeats: l >= 3 };
  }

  function makeSecret(c) {
    const pool = FRUITS.slice(0, c.colors);
    const out = [];
    const bag = pool.slice();
    for (let i = 0; i < c.pegs; i++) {
      if (c.repeats) {
        out.push(pool[Math.floor(Math.random() * pool.length)]);
      } else {
        out.push(bag.splice(Math.floor(Math.random() * bag.length), 1)[0]);
      }
    }
    return out;
  }

  function score(code, guess) {
    let exact = 0;
    const left = {};
    const mine = {};
    code.forEach((c, i) => {
      if (guess[i] === c) { exact++; return; }
      left[c] = (left[c] || 0) + 1;
      mine[guess[i]] = (mine[guess[i]] || 0) + 1;
    });
    let near = 0;
    Object.keys(mine).forEach((k) => { near += Math.min(mine[k], left[k] || 0); });
    return { exact, near };
  }

  function newGame() {
    cfg = levelConfig(level);
    secret = makeSecret(cfg);
    guesses = [];
    current = Array(cfg.pegs).fill(null);
    revealed = [];
    over = false;
    overlay.classList.add('hidden');
    buildPalette();
    render();
    setMessage(cfg.repeats
      ? 'Fruits can repeat. ● right spot · ○ right fruit, wrong spot'
      : 'No repeats yet. ● right spot · ○ right fruit, wrong spot');
  }

  function setMessage(text) { messageEl.textContent = text; }

  function buildPalette() {
    paletteEl.innerHTML = '';
    FRUITS.slice(0, cfg.colors).forEach((f) => {
      const b = document.createElement('button');
      b.className = 'cbColor';
      b.textContent = f;
      b.setAttribute('aria-label', 'Pick ' + f);
      b.addEventListener('click', () => pick(f));
      paletteEl.appendChild(b);
    });
  }

  function pick(f) {
    if (over) return;
    const i = current.indexOf(null);
    if (i === -1) return;
    current[i] = f;
    render();
  }

  function clearSlot(i) {
    if (over) return;
    current[i] = null;
    render();
  }

  function back() {
    if (over) return;
    for (let i = current.length - 1; i >= 0; i--) {
      if (current[i] !== null) { current[i] = null; break; }
    }
    render();
  }

  function submit() {
    if (over || current.includes(null)) return;
    const guess = current.slice();
    const result = score(secret, guess);
    guesses.push({ guess, result });
    current = Array(cfg.pegs).fill(null);

    if (result.exact === cfg.pegs) return win();
    if (guesses.length >= cfg.tries) return lose();
    render();
  }

  function win() {
    over = true;
    const used = guesses.length;
    const bonus = used <= Math.ceil(cfg.tries / 2) ? 1 : 0;
    stars += 1 + bonus;
    hints += 1;
    save(KEYS.stars, stars);
    save(KEYS.hints, hints);
    render();
    overlayMsg.textContent = `Cracked in ${used} ${used === 1 ? 'try' : 'tries'} ✨` + (bonus ? ' +bonus ⭐' : '');
    overlayBtn.textContent = 'Next level';
    overlayBtn.onclick = () => { level += 1; save(KEYS.level, level); newGame(); };
    overlay.classList.remove('hidden');
  }

  function lose() {
    over = true;
    render();
    overlayMsg.textContent = 'The code was ' + secret.join(' ');
    overlayBtn.textContent = 'Try again';
    overlayBtn.onclick = () => newGame();
    overlay.classList.remove('hidden');
  }

  function useHint() {
    if (over || hints <= 0) return;
    const hidden = secret.map((_, i) => i).filter((i) => !revealed.includes(i));
    if (!hidden.length) return;
    const i = hidden[Math.floor(Math.random() * hidden.length)];
    revealed.push(i);
    hints -= 1;
    save(KEYS.hints, hints);
    const known = revealed.slice().sort((a, b) => a - b).map((p) => `#${p + 1} is ${secret[p]}`);
    setMessage('💡 ' + known.join(' · '));
    render();
  }

  function makePeg(value, onClick) {
    const el = document.createElement('div');
    el.className = 'cbPeg' + (value ? ' filled' : '');
    el.textContent = value || '';
    if (onClick) el.addEventListener('click', onClick);
    return el;
  }

  function render() {
    $('cbLevel').textContent = String(level);
    $('cbStars').textContent = String(stars);
    $('cbTries').textContent = String(cfg.tries - guesses.length);
    $('cbHintCount').textContent = String(hints);
    hintBtn.disabled = over || hints <= 0 || revealed.length >= cfg.pegs;
    submitBtn.disabled = over || current.includes(null);

    rowsEl.innerHTML = '';
    for (let r = 0; r < cfg.tries; r++) {
      const row = document.createElement('div');
      const num = document.createElement('span');
      num.className = 'cbNum';
      num.textContent = String(r + 1);
      const pegs = document.createElement('div');
      pegs.className = 'cbPegs';
      const fb = document.createElement('div');
      fb.className = 'cbFeedback';
      fb.style.gridTemplateColumns = `repeat(${Math.ceil(cfg.pegs / 2)}, 1fr)`;

      if (r < guesses.length) {
        row.className = 'cbRow done';
        const { guess, result } = guesses[r];
        guess.forEach((g) => pegs.appendChild(makePeg(g)));
        for (let i = 0; i < cfg.pegs; i++) {
          const d = document.createElement('span');
          d.className = 'cbDot' + (i < result.exact ? ' exact' : i < result.exact + result.near ? ' near' : '');
          fb.appendChild(d);
        }
      } else if (r === guesses.length && !over) {
        row.className = 'cbRow current';
        current.forEach((g, i) => pegs.appendChild(makePeg(g, g ? () => clearSlot(i) : null)));
      } else {
        row.className = 'cbRow';
        for (let i = 0; i < cfg.pegs; i++) pegs.appendChild(makePeg(null));
      }
      row.append(num, pegs, fb);
      rowsEl.appendChild(row);
    }
    const cur = rowsEl.querySelector('.cbRow.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  $('cbRestart').addEventListener('click', newGame);
  $('cbBackBtn').addEventListener('click', back);
  submitBtn.addEventListener('click', submit);
  hintBtn.addEventListener('click', useHint);

  newGame();
})();
