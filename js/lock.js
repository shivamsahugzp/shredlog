// Optional 4-digit PIN lock. The PIN is stored as a hash; forgetting it means resetting the app.
import { state, resetAll } from './state.js';
import { h, icon, confirmSheet, clear } from './ui.js';

export async function hashPin(pin) {
  const data = new TextEncoder().encode('shredlog:' + pin);
  if (crypto.subtle) { const buf = await crypto.subtle.digest('SHA-256', data); return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
  let hsh = 2166136261; for (const b of data) { hsh ^= b; hsh = Math.imul(hsh, 16777619) >>> 0; } return 'fnv' + hsh.toString(16); // insecure fallback for http contexts
}

// Renders a keypad into container; resolves when the correct PIN is entered.
export function renderLock(container, { title = 'Enter your PIN', verifyHash = state.settings.pinHash, allowForgot = true } = {}) {
  return new Promise((resolve) => {
    let entered = '';
    const dots = h('div', { class: 'lock-dots' }, [0, 1, 2, 3].map(() => h('i')));
    const msg = h('div', { class: 'small muted', style: { minHeight: '20px', textAlign: 'center' } });
    const root = h('div', { class: 'lock' },
      h('div', { class: 'boot-mark' }, 'S'),
      h('h2', null, title), dots, msg,
      h('div', { class: 'lock-pad' }, ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) => k === '' ? h('span') : h('button', { class: 'lock-key', 'aria-label': k === '⌫' ? 'Delete' : k, onClick: () => press(k) }, k === '⌫' ? icon('left', 22) : k))),
      allowForgot ? h('button', { class: 'btn ghost sm', style: { marginTop: '18px' }, onClick: forgot }, 'Forgot PIN?') : null);
    clear(container); container.append(root);
    const paint = () => [...dots.children].forEach((d, i) => d.classList.toggle('on', i < entered.length));
    async function press(k) {
      if (k === '⌫') { entered = entered.slice(0, -1); paint(); return; }
      if (entered.length >= 4) return;
      entered += k; paint();
      if (entered.length === 4) {
        const hsh = await hashPin(entered);
        if (!verifyHash || hsh === verifyHash) { resolve(entered); return; }
        root.classList.add('shake'); msg.textContent = 'Wrong PIN. Try again.'; setTimeout(() => { root.classList.remove('shake'); entered = ''; paint(); }, 450);
      }
    }
    async function forgot() {
      const ok = await confirmSheet('There is no way to recover a PIN: nothing is stored anywhere but this phone. The only way back in is to delete all data and start again. If you have a backup file you can import it afterwards.', { ok: 'Delete everything', danger: true, title: 'Forgot your PIN?' });
      if (ok) { await resetAll(); location.reload(); }
    }
  });
}
