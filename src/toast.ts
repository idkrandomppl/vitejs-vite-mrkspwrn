export function toast(message: string, bad = false) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = bad ? 'toast bad' : 'toast';
  el.textContent = message;
  host.append(el);
  setTimeout(() => el.remove(), 4200);
}
