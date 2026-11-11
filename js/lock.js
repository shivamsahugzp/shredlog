// Optional 4-digit PIN lock. The PIN is stored as a hash; forgetting it means resetting the app.
import { state, resetAll } from './state.js';
import { h, icon, confirmSheet, clear, haptic } from './ui.js';

export async function hashPin(pin) {
  const data = new TextEncoder().encode('shredlog:' + pin);
  if (crypto.subtle) { const buf = await crypto.subtle.digest('SHA-256', data); return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
  let hsh = 2166136261; for (const b of data) { hsh ^= b; hsh = Math.imul(hsh, 16777619) >>> 0; } return 'fnv' + hsh.toString(16); // insecure fallback for http contexts
}

// Renders a keypad into container; resolves when the correct PIN is entered.
// opts.wrongMsg: line shown after a wrong PIN. opts.sub: line under the title (defaults to a welcome-back line on the real lock screen).
export function renderLock(container, { title = 'Enter your PIN', verifyHash = state.settings.pinHash, allowForgot = true, wrongMsg = 'Wrong PIN. Try again.', sub } = {}) {
  return new Promise((resolve) => {
    let entered = '', busy = false;
    const name = (state.profile && state.profile.name || '').trim();
    const dots = h('div', { class: 'lock-dots', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => h('i')));
    const msg = h('div', { class: 'lock-msg', role: 'status', 'aria-live': 'polite' }, sub != null ? sub : (allowForgot && verifyHash ? (name ? `Welcome back, ${name}` : 'Welcome back') : ''));
    const base = msg.textContent;
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    const root = h('div', { class: 'lock' },
      h('div', { class: 'boot-mark lock-mark' }, 'S'),
      h('h2', null, title), msg, dots,
      h('div', { class: 'lock-pad' }, ...keys.map((k) => k === '' ? h('span', { class: 'lock-gap' }) : h('button', { class: 'lock-key' + (k === '⌫' ? ' lock-del' : ''), type: 'button', 'aria-label': k === '⌫' ? 'Delete' : k, onClick: () => press(k) }, k === '⌫' ? icon('left', 22) : k))),
      allowForgot ? h('button', { class: 'btn ghost sm lock-forgot', onClick: forgot }, 'Forgot PIN?') : null);
    clear(container); container.append(root);
    const paint = () => [...dots.children].forEach((d, i) => d.classList.toggle('on', i < entered.length));
    // Physical keyboard (desktop, iPad). Stops itself when the lock leaves the page so it never steals keys from other screens.
    const onKey = (e) => {
      if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
      if (/^[0-9]$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('⌫');
    };
    document.addEventListener('keydown', onKey);
    async function press(k) {
      if (busy) return;
      haptic('tap');
      if (msg.classList.contains('bad')) { msg.classList.remove('bad'); msg.textContent = base; }
      if (k === '⌫') { entered = entered.slice(0, -1); paint(); return; }
      if (entered.length >= 4) return;
      entered += k; paint();
      if (entered.length === 4) {
        busy = true;
        const hsh = await hashPin(entered);
        if (!verifyHash || hsh === verifyHash) {
          root.classList.add('ok'); haptic('success');
          setTimeout(() => { document.removeEventListener('keydown', onKey); resolve(entered); }, 150);
          return;
        }
        haptic('warn');
        root.classList.add('shake'); msg.textContent = wrongMsg; msg.classList.add('bad');
        setTimeout(() => { root.classList.remove('shake'); entered = ''; paint(); busy = false; }, 450);
      }
    }
    async function forgot() {
      const ok = await confirmSheet('There is no way to recover a PIN: nothing is stored anywhere but this phone. The only way back in is to delete all data and start again. If you have a backup file you can import it afterwards.', { ok: 'Delete everything', danger: true, title: 'Forgot your PIN?' });
      if (ok) { await resetAll(); location.reload(); }
    }
  });
}
