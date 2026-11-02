'use strict';

// Modal confirm / alert / progress boxes in the editor's own style, replacing
// the browser's bare confirm(). Built on <dialog>, so Esc, focus trapping and
// the backdrop come for free.

const Ask = (() => {
  const ICONS = {
    warning: '<path class="ask-stroke" d="M32 18v18"/><circle class="ask-dot" cx="32" cy="45" r="2.6"/>',
    danger: '<path class="ask-stroke" d="M32 18v18"/><circle class="ask-dot" cx="32" cy="45" r="2.6"/>',
    question: '<path class="ask-stroke" d="M24.5 25a7.5 7.5 0 1 1 11 6.6c-2.4 1.3-3.5 2.7-3.5 5.4v1"/><circle class="ask-dot" cx="32" cy="46" r="2.6"/>',
    success: '<path class="ask-stroke" d="M21 33l7.5 7.5L43.5 25"/>',
    error: '<path class="ask-stroke" d="M23 23l18 18M41 23L23 41"/>',
    busy: '',
  };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function build({ icon = 'warning', title, text }) {
    const dlg = el('dialog', `ask ask-${icon}`);
    const badge = el('div', 'ask-icon');
    badge.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle class="ask-ring" cx="32" cy="32" r="28"/>${ICONS[icon]}</svg>`;
    dlg.append(badge, el('h2', 'ask-title', title));
    // Plain text only; each line of `text` becomes its own paragraph.
    for (const line of [].concat(text || [])) dlg.append(el('p', 'ask-text', line));
    document.body.append(dlg);
    return dlg;
  }

  function close(dlg) {
    dlg.inert = true; // no more clicks while it fades out
    dlg.classList.add('ask-out');
    setTimeout(() => { dlg.close(); dlg.remove(); }, 150);
  }

  // Resolves true for the confirm button, false for cancel / Esc / backdrop click.
  // cancelText: null makes it a one-button alert.
  function confirm({ confirmText = 'OK', cancelText = 'Cancel', danger = false, ...opts }) {
    const dlg = build(opts);
    const actions = el('div', 'ask-actions');
    const ok = el('button', `btn ${danger ? 'danger' : 'primary'}`, confirmText);
    ok.type = 'button';
    if (cancelText !== null) {
      const cancel = el('button', 'btn', cancelText);
      cancel.type = 'button';
      cancel.addEventListener('click', () => finish(false));
      actions.append(cancel);
    }
    actions.append(ok);
    dlg.append(actions);

    let resolve;
    const finish = answer => {
      if (!resolve) return; // already answered, the box is fading out
      close(dlg);
      resolve(answer);
      resolve = null;
    };
    ok.addEventListener('click', () => finish(true));
    dlg.addEventListener('cancel', e => { e.preventDefault(); finish(false); });
    dlg.addEventListener('click', e => { if (e.target === dlg) finish(false); }); // backdrop
    dlg.showModal();
    // A dangerous action should not be one Enter press away.
    (danger && cancelText !== null ? actions.firstChild : ok).focus();
    return new Promise(r => { resolve = r; });
  }

  const alert = opts => confirm({ cancelText: null, ...opts });

  // A box with a progress bar that the user can't dismiss; returns { update, close }.
  function progress({ title, text, icon = 'busy' }) {
    const dlg = build({ icon, title, text });
    dlg.classList.add('ask-busy');
    const bar = el('div', 'ask-bar');
    const fill = el('span');
    const status = el('p', 'ask-status');
    bar.append(fill);
    dlg.append(bar, status);
    dlg.addEventListener('cancel', e => e.preventDefault());
    dlg.showModal();
    return {
      update(fraction, message = '') {
        fill.style.width = `${Math.round(fraction * 100)}%`;
        status.textContent = message;
      },
      close: () => close(dlg),
    };
  }

  return { confirm, alert, progress };
})();
