'use strict';

// 1. Publication tabs
window.openTab = (tabId) => {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');
  const btn = document.querySelector(`[onclick="openTab('${tabId}')"]`);
  if (btn) btn.classList.add('active');
};

// 2. Mobile menu
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('mobile-menu');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('active-menu');
    toggle.classList.toggle('is-active', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && links.classList.contains('active-menu')) {
      links.classList.remove('active-menu');
      toggle.classList.remove('is-active');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }
  });
});

// 3. Readability without boxes: the lattice fades back while the cursor rests on text
(() => {
  const TEXT = 'main h1, main h2, main h3, main p, main li, main address, main .pub-row, main .ribbon, .ribbon';
  let reading = false;
  document.addEventListener('pointerover', (e) => {
    const on = !!(e.target.closest && e.target.closest(TEXT));
    if (on !== reading) { reading = on; document.body.classList.toggle('reading', on); }
  }, { passive: true });
})();
