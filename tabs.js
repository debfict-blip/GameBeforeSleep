(() => {
  const KEY = 'gbs-tab';
  const buttons = Array.from(document.querySelectorAll('.tabBtn'));

  function show(id) {
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== id));
    try { localStorage.setItem(KEY, id); } catch (e) { /* not persisted */ }
  }

  buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* ignore */ }
  if (saved && document.getElementById(saved)) show(saved);
})();
