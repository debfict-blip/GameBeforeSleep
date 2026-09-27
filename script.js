(() => {
  const ITEM_TYPES = ['🧸', '🎈', '🍦', '🎁', '🧦', '🪀'];
  const COUNT_PER_TYPE = 3;
  const TRAY_SLOTS = 7;

  const shelfEl = document.getElementById('shelf');
  const trayEl = document.getElementById('tray');
  const winOverlay = document.getElementById('winOverlay');
  const restartBtn = document.getElementById('restartBtn');
  const playAgainBtn = document.getElementById('playAgainBtn');

  let shelf = [];
  let tray = [];
  let nextId = 1;
  let drag = null;

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function newLevel() {
    const pool = [];
    ITEM_TYPES.forEach((type) => {
      for (let i = 0; i < COUNT_PER_TYPE; i++) pool.push(type);
    });
    shuffle(pool);
    shelf = pool.map((type) => ({ id: nextId++, type }));
    tray = new Array(TRAY_SLOTS).fill(null);
    winOverlay.classList.add('hidden');
    render();
  }

  function render() {
    shelfEl.innerHTML = '';
    shelf.forEach((cell, index) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.zone = 'shelf';
      slot.dataset.index = String(index);
      if (cell) slot.appendChild(makeItemEl(cell, 'shelf', index));
      shelfEl.appendChild(slot);
    });

    trayEl.innerHTML = '';
    tray.forEach((cell, index) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.zone = 'tray';
      slot.dataset.index = String(index);
      if (cell) slot.appendChild(makeItemEl(cell, 'tray', index));
      trayEl.appendChild(slot);
    });
  }

  function makeItemEl(cell, zone, index) {
    const el = document.createElement('div');
    el.className = 'item';
    el.textContent = cell.type;
    el.dataset.zone = zone;
    el.dataset.index = String(index);
    el.dataset.id = String(cell.id);
    el.addEventListener('pointerdown', onPointerDown);
    return el;
  }

  function onPointerDown(e) {
    if (drag) return;
    const el = e.currentTarget;
    const zone = el.dataset.zone;
    const index = Number(el.dataset.index);
    const cell = zone === 'shelf' ? shelf[index] : tray[index];
    if (!cell) return;

    e.preventDefault();
    el.setPointerCapture(e.pointerId);

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = cell.type;
    ghost.style.left = e.clientX + 'px';
    ghost.style.top = e.clientY + 'px';
    document.body.appendChild(ghost);

    el.classList.add('dragging-source');

    drag = {
      pointerId: e.pointerId,
      sourceZone: zone,
      sourceIndex: index,
      el,
      ghost,
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;

    const dropTarget = document.elementFromPoint(e.clientX, e.clientY);
    const slotEl = dropTarget && dropTarget.closest('.slot');
    if (slotEl) {
      const targetZone = slotEl.dataset.zone;
      const targetIndex = Number(slotEl.dataset.index);
      attemptMove(drag.sourceZone, drag.sourceIndex, targetZone, targetIndex);
    }

    endDrag();
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    endDrag();
  }

  function endDrag() {
    drag.ghost.remove();
    drag.el.classList.remove('dragging-source');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    drag = null;
    render();
  }

  function attemptMove(sourceZone, sourceIndex, targetZone, targetIndex) {
    if (targetZone === 'shelf') return; // items never move back onto the shelf

    if (sourceZone === 'shelf') {
      if (sourceZone === targetZone && sourceIndex === targetIndex) return;
      if (tray[targetIndex]) return; // shelf items only land in an empty tray slot
      tray[targetIndex] = shelf[sourceIndex];
      shelf[sourceIndex] = null;
    } else if (sourceZone === 'tray') {
      if (sourceIndex === targetIndex) return;
      const temp = tray[targetIndex];
      tray[targetIndex] = tray[sourceIndex];
      tray[sourceIndex] = temp; // swap; moving into a hole leaves target's old spot empty
    }

    resolveTriples();
    checkWin();
  }

  function resolveTriples() {
    let cleared = true;
    while (cleared) {
      cleared = false;
      for (let i = 0; i <= tray.length - 3; i++) {
        const a = tray[i], b = tray[i + 1], c = tray[i + 2];
        if (a && b && c && a.type === b.type && c.type === b.type) {
          tray[i] = tray[i + 1] = tray[i + 2] = null;
          cleared = true;
          break;
        }
      }
    }
  }

  function checkWin() {
    const shelfEmpty = shelf.every((c) => c === null);
    const trayEmpty = tray.every((c) => c === null);
    if (shelfEmpty && trayEmpty) {
      winOverlay.classList.remove('hidden');
    }
  }

  restartBtn.addEventListener('click', newLevel);
  playAgainBtn.addEventListener('click', newLevel);

  newLevel();
})();
