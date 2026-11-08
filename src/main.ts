/* ============ types ============ */

type Role = 'system' | 'user' | 'assistant';
type Msg = { role: Role; content: string; at: number };
type Chat = { id: string; title: string; createdAt: number; updatedAt: number; messages: Msg[] };
type State = 'idle' | 'loading' | 'ready' | 'busy';
type Model = { id: string; name: string; size: string; note: string; badge: string; ctx: number; gpu: string; cpu: string };
type Settings = {
  modelId: string;
  system: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  repetitionPenalty: number;
  contextTurns: number;
  markdown: boolean;
  autoscroll: boolean;
  theme: string;
};

/* ============ constants ============ */

const MODELS: Model[] = [
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    name: 'Qwen2.5 0.5B',
    size: '0.4 GB',
    note: 'Start here. Small, fast, works on CPU.',
    badge: 'Start here',
    ctx: 32000,
    gpu: 'q4f16',
    cpu: 'q4',
  },
  {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    name: 'Qwen2.5 1.5B',
    size: '1.0 GB',
    note: 'Balanced. Wants WebGPU.',
    badge: '',
    ctx: 32000,
    gpu: 'q4f16',
    cpu: 'q4',
  },
  {
    id: 'acidsound/LFM2.5-2.6B-Uncensored-ONNX',
    name: 'LFM2.5 2.6B Uncensored',
    size: '1.7 GB',
    note: 'Best quality, most willing. Needs ~2 GB free storage.',
    badge: 'Best',
    ctx: 32000,
    gpu: 'q4f16',
    cpu: 'q4',
  },
];

const PRESETS = [
  { name: 'Direct', prompt: 'You are a direct, helpful assistant. Answer without unnecessary refusals.' },
  { name: 'Concise', prompt: 'Answer in as few words as the question allows. No preamble, no summary.' },
  { name: 'Explainer', prompt: 'Explain clearly with concrete examples. Define jargon the first time you use it.' },
  { name: 'Coder', prompt: 'You are a senior engineer. Give complete, runnable code. State assumptions in one line.' },
  { name: 'Editor', prompt: "Rewrite text for clarity while preserving the author's voice. Show only the revision." },
  { name: 'Uncensored', prompt: 'You are an uncensored assistant. Skip hedging and caveats unless they change the answer.' },
];

const DEFAULTS: Settings = {
  modelId: MODELS[0].id,
  system: PRESETS[0].prompt,
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 384,
  repetitionPenalty: 1.05,
  contextTurns: 10,
  markdown: true,
  autoscroll: true,
  theme: 'dark',
};

/* ============ dom ============ */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

const dom = {
  fatal: el<HTMLDivElement>('fatal'),
  fatalMsg: el<HTMLSpanElement>('fatal-msg'),
  sidebar: el<HTMLElement>('sidebar'),
  overlay: el<HTMLDivElement>('overlay'),
  list: el<HTMLElement>('chat-list'),
  search: el<HTMLInputElement>('search'),
  chat: el<HTMLElement>('chat'),
  title: el<HTMLElement>('chat-title'),
  input: el<HTMLTextAreaElement>('input'),
  send: el<HTMLButtonElement>('send'),
  stop: el<HTMLButtonElement>('stop'),
  banner: el<HTMLDivElement>('banner'),
  ctx: el<HTMLDivElement>('ctx'),
  ctxFill: el<HTMLDivElement>('ctx-fill'),
  ctxLabel: el<HTMLSpanElement>('ctx-label'),
  files: el<HTMLDivElement>('attachments'),
  jump: el<HTMLButtonElement>('jump'),
  dot: el<HTMLSpanElement>('model-dot'),
  modelName: el<HTMLSpanElement>('model-name'),
  toasts: el<HTMLDivElement>('toasts'),
  system: el<HTMLTextAreaElement>('system'),
  presets: el<HTMLDivElement>('presets'),
  modelList: el<HTMLDivElement>('model-list'),
  gpuHint: el<HTMLParagraphElement>('gpu-hint'),
  diagBody: el<HTMLPreElement>('diag-body'),
  paletteInput: el<HTMLInputElement>('palette-input'),
  paletteList: el<HTMLUListElement>('palette-list'),
};

const sheets = {
  models: el<HTMLDialogElement>('models'),
  settings: el<HTMLDialogElement>('settings'),
  diag: el<HTMLDialogElement>('diag'),
  palette: el<HTMLDialogElement>('palette'),
  onboarding: el<HTMLDialogElement>('onboarding'),
};

/* ============ state ============ */

let settings: Settings = { ...DEFAULTS };
let chats: Chat[] = [];
let chat: Chat | null = null;
let state: State = 'idle';
let model: any = null;
let files: { name: string; text: string }[] = [];
let follow = true;
let booted = false;

/* ============ errors ============ */

function crash(message: string) {
  console.error('[localchat]', message);
  dom.fatal.hidden = false;
  dom.fatalMsg.textContent = message || 'Unknown error';
}

el<HTMLButtonElement>('fatal-copy').addEventListener('click', () => {
  void navigator.clipboard.writeText(dom.fatalMsg.textContent ?? '');
});

el<HTMLButtonElement>('fatal-reset').addEventListener('click', async () => {
  try {
    for (const name of await caches.keys()) await caches.delete(name);
    indexedDB.deleteDatabase('localchat');
  } catch {
    /* ignore */
  }
  localStorage.clear();
  location.reload();
});

el<HTMLButtonElement>('fatal-close').addEventListener('click', () => {
  dom.fatal.hidden = true;
});

window.addEventListener('error', (event) => {
  if (event.message) crash(event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  if (!text) return;
  if (booted) toast(text.slice(0, 150), true);
  else crash(text);
});

function toast(message: string, bad = false) {
  const node = document.createElement('div');
  node.className = bad ? 'toast bad' : 'toast';
  node.textContent = message;
  dom.toasts.append(node);
  setTimeout(() => node.remove(), 5000);
}

/* ============ indexdb ============ */

const DB = 'localchat';
let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return opening;
}

function idb<T>(name: 'chats' | 'kv', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction(name, mode).objectStore(name));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

const saveChat = (c: Chat) => idb('chats', 'readwrite', (s) => s.put(c));
const loadChats = () => idb<Chat[]>('chats', 'readonly', (s) => s.getAll());
const dropChat = (id: string) => idb('chats', 'readwrite', (s) => s.delete(id));
const setKV = (k: string, v: unknown) => idb('kv', 'readwrite', (s) => s.put(v, k));
const getKV = (k: string) => idb<unknown>('kv', 'readonly', (s) => s.get(k));

/* ============ markdown ============ */

const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENT[c]);

function markdown(src: string): string {
  const blocks: string[] = [];
  const codes: string[] = [];

  let text = src.replace(/```([\w+-]*)\r?\n?([\s\S]*?)```/g, (_a, lang: string, code: string) => {
    blocks.push(`<pre data-lang="${esc(lang || 'code')}"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `@@B${blocks.length - 1}@@`;
  });

  text = esc(text);
  text = text.replace(/`([^`\n]+)`/g, (_a, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `@@C${codes.length - 1}@@`;
  });

  text = text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');

  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const closePara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      closePara();
      closeList();
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closePara();
      closeList();
      const n = Math.min(h[1].length + 1, 6);
      out.push(`<h${n}>${h[2]}</h${n}>`);
      continue;
    }

    const ul = /^[-*+]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      closePara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) {
        closeList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${(ul ?? ol)![1]}</li>`);
      continue;
    }

    if (line.startsWith('> ')) {
      closePara();
      closeList();
      out.push(`<blockquote>${line.slice(2)}</blockquote>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      closePara();
      closeList();
      out.push('<hr>');
      continue;
    }

    closeList();
    para.push(line);
  }
  closePara();
  closeList();

  return out
    .join('\n')
    .replace(/@@C(\d+)@@/g, (_a, i: string) => codes[Number(i)] ?? '')
    .replace(/@@B(\d+)@@/g, (_a, i: string) => blocks[Number(i)] ?? '');
}

/* ============ settings ============ */

let saveTimer = 0;

function saveSettings() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void setKV('settings', settings), 250);
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme === 'light' ? 'light' : 'dark';
}

/* ============ status ============ */

function setState(next: State) {
  state = next;
  dom.dot.className = `dot ${next === 'ready' ? 'ready' : next === 'busy' ? 'busy' : ''}`;
  const current = MODELS.find((m) => m.id === settings.modelId);
  dom.modelName.textContent =
    next === 'ready' ? (current?.name ?? 'Model') : next === 'loading' ? 'Loading…' : next === 'busy' ? 'Thinking…' : 'No model';
  dom.send.disabled = next !== 'ready';
  dom.send.hidden = next === 'busy';
  dom.stop.hidden = next !== 'busy';
  if (next === 'idle') drawChat();
}

async function webgpu(): Promise<boolean> {
  const nav = navigator as any;
  if (!nav.gpu) return false;
  try {
    return Boolean(await nav.gpu.requestAdapter());
  } catch {
    return false;
  }
}

async function freeMB(): Promise<number | null> {
  try {
    const est = await navigator.storage.estimate();
    return ((est.quota ?? 0) - (est.usage ?? 0)) / 1e6;
  } catch {
    return null;
  }
}

/* ============ model ============ */

function paintBanner(html: string) {
  dom.banner.hidden = false;
  dom.banner.innerHTML = html;
}

async function loadModel(modelId: string, attempt = 0) {
  const target = MODELS.find((m) => m.id === modelId);
  if (!target) return;

  try {
    await navigator.storage.persist();
  } catch {
    /* ignore */
  }

  const need = parseFloat(target.size) * 1000;
  const free = await freeMB();
  if (free !== null && free < need * 1.2) {
    toast(`Only ${Math.round(free)} MB free, ${target.name} needs about ${Math.round(need)} MB`, true);
  }

  settings.modelId = modelId;
  saveSettings();
  setState('loading');

  const gpu = await webgpu();
  const dtype = attempt === 0 ? (gpu ? target.gpu : target.cpu) : 'q4';

  paintBanner(
    `<b>Downloading ${target.name}${attempt ? ' (safe format)' : ''}</b><span class="track"><i id="bar"></i></span><span id="pct"></span>`,
  );

  const bar = document.getElementById('bar');
  const pct = document.getElementById('pct');

  try {
    const lib = await import('@huggingface/transformers');
    lib.env.allowLocalModels = false;

    model = await lib.pipeline('text-generation', target.id, {
      device: gpu ? 'webgpu' : 'wasm',
      dtype: dtype as any,
      progress_callback: (p: any) => {
        if (p.status === 'progress' && p.total) {
          const ratio = (p.loaded ?? 0) / p.total;
          if (bar) bar.style.width = `${Math.min(ratio, 1) * 100}%`;
          if (pct) pct.textContent = `${Math.round(ratio * 100)}%`;
        }
      },
    } as any);

    dom.banner.hidden = true;
    setState('ready');
    toast(`${target.name} ready`);
    if (!gpu) toast('No WebGPU, running on CPU. Replies will be slow.', true);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error('[localchat] load failed', error);

    if (attempt === 0) {
      toast('First attempt failed, retrying with a safer format…', true);
      return loadModel(modelId, 1);
    }

    setState('idle');
    paintBanner(`<b>Download failed.</b><span style="flex:1">${esc(message)}</span>`);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn-ghost';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => void loadModel(modelId));

    const smaller = document.createElement('button');
    smaller.type = 'button';
    smaller.className = 'btn-ghost';
    smaller.textContent = 'Use 0.5B';
    smaller.addEventListener('click', () => void loadModel(MODELS[0].id));

    dom.banner.append(retry, smaller);
  }
}

async function unloadModel() {
  try {
    await model?.dispose?.();
  } catch {
    /* ignore */
  }
  model = null;
  setState('idle');
  toast('Model unloaded');
}

/* ============ chats ============ */

function newChat(): Chat {
  const fresh: Chat = { id: crypto.randomUUID(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  chats.unshift(fresh);
  chat = fresh;
  void saveChat(fresh);
  drawList();
  drawChat();
  dom.input.focus();
  return fresh;
}

function openChat(id: string) {
  const found = chats.find((c) => c.id === id);
  if (!found) return;
  chat = found;
  drawList();
  drawChat();
  closeMenu();
}

function deleteChat(id: string) {
  chats = chats.filter((c) => c.id !== id);
  void dropChat(id);
  if (chat?.id === id) {
    if (chats.length) openChat(chats[0].id);
    else newChat();
  } else drawList();
}

function touch() {
  if (!chat) return;
  chat.updatedAt = Date.now();
  void saveChat(chat);
}

function drawList(filter = '') {
  const q = filter.trim().toLowerCase();
  dom.list.replaceChildren();

  const visible = q
    ? chats.filter((c) => (c.messages ?? []).some((m) => m.content.toLowerCase().includes(q)) || c.title.toLowerCase().includes(q))
    : chats;

  for (const item of visible) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'chat-row';
    row.setAttribute('aria-current', String(item.id === chat?.id));

    const label = document.createElement('span');
    label.textContent = item.title;
    row.append(label);

    const kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'kill';
    kill.innerHTML = '<svg><use href="#i-trash"/></svg>';
    kill.setAttribute('aria-label', `Delete ${item.title}`);
    kill.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteChat(item.id);
    });
    row.append(kill);

    row.addEventListener('click', () => openChat(item.id));
    dom.list.append(row);
  }
}

function drawChat() {
  dom.chat.replaceChildren();
  dom.title.textContent = chat?.title ?? 'New chat';

  if (!chat || !chat.messages || chat.messages.length === 0) {
    const box = document.createElement('div');
    box.className = 'empty';

    const h = document.createElement('h2');
    h.textContent = 'Nothing here yet';
    const p = document.createElement('p');
    p.textContent = 'Ask anything. The model runs locally, so there is no quota and no logging.';
    box.append(h, p);

    if (state === 'idle') {
      const load = document.createElement('button');
      load.type = 'button';
      load.className = 'btn-primary';
      load.style.marginTop = '12px';
      load.textContent = 'Load 0.5B model';
      load.addEventListener('click', () => void loadModel(MODELS[0].id));
      box.append(load);
    }

    dom.chat.append(box);
  } else {
    for (const message of chat.messages) drawMessage(message);
  }

  drawCtx();
  scrollDown();
}

/* ============ messages ============ */

function body(text: string, asMarkdown: boolean): HTMLElement {
  const node = document.createElement('div');
  if (asMarkdown && settings.markdown) {
    node.className = 'body md';
    node.innerHTML = markdown(text);
  } else {
    node.className = 'body';
    node.textContent = text;
  }
  return node;
}

function drawMessage(message: Msg): HTMLElement {
  dom.chat.querySelector('.empty')?.remove();

  const wrap = document.createElement('article');
  wrap.className = `msg ${message.role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.append(body(message.content, message.role === 'assistant'));
  wrap.append(bubble);

  const acts = document.createElement('div');
  acts.className = 'acts';

  const add = (icon: string, label: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<svg><use href="#i-${icon}"/></svg>`;
    b.addEventListener('click', run);
    acts.append(b);
  };

  add('copy', 'Copy', () => void navigator.clipboard.writeText(message.content).then(() => toast('Copied')));

  if (message.role === 'assistant') {
    add('redo', 'Regenerate', () => regenerate(message));
    add('speak', 'Read aloud', () => {
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(message.content));
    });
  } else {
    add('edit', 'Edit and resend', () => editMessage(wrap, message));
  }

  wrap.append(acts);
  dom.chat.append(wrap);
  return wrap;
}

function editMessage(wrap: HTMLElement, message: Msg) {
  if (!chat || state === 'busy') return;

  const box = document.createElement('div');
  box.className = 'edit';
  const area = document.createElement('textarea');
  area.value = message.content;
  area.rows = Math.min(12, message.content.split('\n').length + 2);

  const row = document.createElement('div');
  row.className = 'row';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', drawChat);

  const resend = document.createElement('button');
  resend.type = 'button';
  resend.className = 'btn-primary';
  resend.textContent = 'Resend';
  resend.addEventListener('click', () => {
    const next = area.value.trim();
    if (!next || !chat) return;
    const index = chat.messages.indexOf(message);
    chat.messages = chat.messages.slice(0, index);
    void saveChat(chat);
    drawChat();
    void submit(next);
  });

  row.append(cancel, resend);
  box.append(area, row);
  wrap.replaceChildren(box);
  area.focus();
}

function regenerate(message: Msg) {
  if (!chat || state !== 'ready') return;
  const index = chat.messages.indexOf(message);
  if (index < 0) return;
  chat.messages = chat.messages.slice(0, index);
  void saveChat(chat);
  drawChat();
  void run();
}

/* ============ context ============ */

function contextSlice(): Msg[] {
  if (!chat || !chat.messages) return [];
  const limit = Math.max(0, settings.contextTurns);
  if (limit === 0) return [];

  const current = MODELS.find((m) => m.id === settings.modelId);
  const budget = (current?.ctx ?? 8000) * 0.7 * 3.5;

  let slice = chat.messages.slice(-limit * 2);
  while (slice.length > 1 && slice.reduce((n, m) => n + m.content.length, 0) > budget) slice = slice.slice(1);
  return slice;
}

function drawCtx() {
  const current = MODELS.find((m) => m.id === settings.modelId);
  if (!current || !chat || !chat.messages || chat.messages.length === 0) {
    dom.ctx.hidden = true;
    return;
  }

  const used = (contextSlice().reduce((n, m) => n + m.content.length, 0) + settings.system.length) / 3.5;
  const ratio = Math.min(used / current.ctx, 1);

  dom.ctx.hidden = false;
  dom.ctxFill.style.width = `${ratio * 100}%`;
  dom.ctxLabel.textContent = `${Math.round(used)} / ${current.ctx}`;
  dom.ctx.className = ratio > 0.9 ? 'ctx over' : ratio > 0.75 ? 'ctx warn' : 'ctx';
}

/* ============ streaming ============ */

let liveWrap: HTMLElement | null = null;
let liveBody: HTMLElement | null = null;
let liveText = '';
let paintQueued = false;
let lastPaint = 0;

function onToken(text: string) {
  liveText += text;
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (!liveBody) return;
    const now = performance.now();
    if (now - lastPaint < 80) return;
    lastPaint = now;

    const stick = follow && settings.autoscroll;
    if (settings.markdown) liveBody.innerHTML = markdown(liveText);
    else liveBody.textContent = liveText;
    if (stick) scrollDown();
  });
}

function endStream() {
  if (!chat) return;

  const final = liveText.trim();
  liveWrap?.classList.remove('streaming');

  if (final) {
    chat.messages.push({ role: 'assistant', content: final, at: Date.now() });
    touch();
    liveWrap?.remove();
    drawMessage(chat.messages[chat.messages.length - 1]);
  } else {
    liveWrap?.remove();
  }

  liveWrap = null;
  liveBody = null;
  liveText = '';
  setState('ready');
  drawCtx();
  scrollDown();
  dom.input.focus();
}

function scrollDown() {
  dom.chat.scrollTop = dom.chat.scrollHeight;
}

/* ============ generation ============ */

async function run() {
  if (!chat || !model || state !== 'ready') return;

  const history = contextSlice().map((m) => ({ role: m.role, content: m.content }));
  const messages = settings.system.trim() ? [{ role: 'system', content: settings.system.trim() }, ...history] : history;
  if (!messages.length) return;

  setState('busy');
  liveText = '';
  liveWrap = document.createElement('article');
  liveWrap.className = 'msg assistant streaming';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  liveBody = body('', settings.markdown);
  bubble.append(liveBody);
  liveWrap.append(bubble);
  dom.chat.append(liveWrap);
  scrollDown();

  const lib = await import('@huggingface/transformers');

  const stopper: any = lib.InterruptableStoppingCriteria
    ? new lib.InterruptableStoppingCriteria()
    : { interrupted: false, _call: () => stopper.interrupted };

  dom.stop.onclick = () => {
    if (typeof stopper.interrupt === 'function') stopper.interrupt();
    else stopper.interrupted = true;
  };

  try {
    await model(messages, {
      max_new_tokens: settings.maxTokens,
      temperature: settings.temperature,
      top_p: settings.topP,
      repetition_penalty: settings.repetitionPenalty,
      do_sample: settings.temperature > 0,
      stopping_criteria: stopper,
      streamer: new lib.TextStreamer(model.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: onToken,
      }),
    } as any);
  } catch (error) {
    toast(error instanceof Error ? error.message.slice(0, 150) : 'Generation failed', true);
  } finally {
    if (liveBody) {
      if (settings.markdown) liveBody.innerHTML = markdown(liveText);
      else liveBody.textContent = liveText;
    }
    endStream();
  }
}

async function submit(text: string) {
  if (!chat) newChat();
  if (!chat) return;

  const payload = files.length
    ? `${text}\n\n${files.map((f) => `<file name="${f.name}">\n${f.text}\n</file>`).join('\n\n')}`
    : text;

  chat.messages.push({ role: 'user', content: payload, at: Date.now() });
  if (chat.title === 'New chat') chat.title = text.slice(0, 46) || 'New chat';
  touch();
  drawChat();
  drawList();

  files = [];
  drawFiles();
  await run();
}

/* ============ composer ============ */

function resize() {
  dom.input.style.height = 'auto';
  dom.input.style.height = `${Math.min(dom.input.scrollHeight, 200)}px`;
}

function drawFiles() {
  dom.files.replaceChildren();
  dom.files.hidden = files.length === 0;

  files.forEach((file, index) => {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = file.name;

    const kill = document.createElement('button');
    kill.type = 'button';
    kill.innerHTML = '<svg><use href="#i-x"/></svg>';
    kill.setAttribute('aria-label', `Remove ${file.name}`);
    kill.addEventListener('click', () => {
      files.splice(index, 1);
      drawFiles();
    });

    pill.append(kill);
    dom.files.append(pill);
  });
}

el<HTMLFormElement>('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = dom.input.value.trim();
  if (!text || state !== 'ready') return;
  dom.input.value = '';
  resize();
  void submit(text);
});

dom.input.addEventListener('input', resize);
dom.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    el<HTMLFormElement>('composer').requestSubmit();
  }
});

el<HTMLButtonElement>('attach-btn').addEventListener('click', () => el<HTMLInputElement>('file').click());

el<HTMLInputElement>('file').addEventListener('change', async (event) => {
  const picked = (event.target as HTMLInputElement).files;
  if (!picked) return;
  for (const file of Array.from(picked).slice(0, 4)) {
    files.push({ name: file.name, text: (await file.text()).slice(0, 20000) });
  }
  drawFiles();
  (event.target as HTMLInputElement).value = '';
});

const micBtn = el<HTMLButtonElement>('mic-btn');
const Speech = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
let listening: any = null;

if (Speech) {
  micBtn.hidden = false;
  micBtn.addEventListener('click', () => {
    if (listening) {
      listening.stop();
      return;
    }
    const rec = new Speech();
    rec.lang = navigator.language;
    rec.interimResults = true;
    rec.onresult = (event: any) => {
      dom.input.value = event.results[0][0].transcript;
      resize();
    };
    rec.onend = () => {
      listening = null;
      micBtn.classList.remove('on');
    };
    rec.start();
    listening = rec;
    micBtn.classList.add('on');
  });
}

/* ============ navigation ============ */

function openMenu() {
  dom.sidebar.classList.add('open');
  dom.overlay.hidden = false;
}

function closeMenu() {
  dom.sidebar.classList.remove('open');
  dom.overlay.hidden = true;
}

el<HTMLButtonElement>('new-chat').addEventListener('click', () => newChat());
el<HTMLButtonElement>('open-sidebar').addEventListener('click', openMenu);
el<HTMLButtonElement>('close-sidebar').addEventListener('click', closeMenu);
dom.overlay.addEventListener('click', closeMenu);
dom.search.addEventListener('input', () => drawList(dom.search.value));

dom.title.addEventListener('click', () => {
  if (!chat) return;
  const next = prompt('Chat title', chat.title);
  if (!next || !next.trim()) return;
  chat.title = next.trim();
  touch();
  drawList();
  dom.title.textContent = chat.title;
});

el<HTMLButtonElement>('export-btn').addEventListener('click', () => {
  if (!chat || !chat.messages || chat.messages.length === 0) return toast('Nothing to export');
  const text = [`# ${chat.title}`, '']
    .concat(chat.messages.map((m) => `**${m.role === 'user' ? 'You' : 'Model'}**\n\n${m.content}\n`))
    .join('\n');
  download(`${chat.title.replace(/\W+/g, '-').slice(0, 40) || 'chat'}.md`, text, 'text/markdown');
});

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

dom.chat.addEventListener('scroll', () => {
  follow = dom.chat.scrollHeight - dom.chat.scrollTop - dom.chat.clientHeight < 90;
  dom.jump.hidden = follow;
});

dom.jump.addEventListener('click', () => {
  follow = true;
  scrollDown();
});

dom.chat.addEventListener('click', (event) => {
  const pre = (event.target as HTMLElement).closest('pre');
  if (!pre) return;
  void navigator.clipboard.writeText(pre.textContent ?? '').then(() => toast('Code copied'));
});

/* ============ settings ============ */

const tempIn = el<HTMLInputElement>('temp');
const tempOut = el<HTMLOutputElement>('temp-out');
const toppIn = el<HTMLInputElement>('topp');
const toppOut = el<HTMLOutputElement>('topp-out');
const maxIn = el<HTMLInputElement>('max');
const maxOut = el<HTMLOutputElement>('max-out');
const repIn = el<HTMLInputElement>('rep');
const repOut = el<HTMLOutputElement>('rep-out');
const turnsIn = el<HTMLInputElement>('turns');
const turnsOut = el<HTMLOutputElement>('turns-out');
const mdCheck = el<HTMLInputElement>('markdown');
const autoCheck = el<HTMLInputElement>('autoscroll');

function wireRange(input: HTMLInputElement, out: HTMLOutputElement, digits: number, get: () => number, set: (v: number) => void) {
  const paint = () => {
    out.textContent = digits ? get().toFixed(digits) : String(get());
  };
  input.value = String(get());
  paint();
  input.addEventListener('input', () => {
    set(Number(input.value));
    paint();
    saveSettings();
    drawCtx();
  });
}

function wireSettings() {
  wireRange(tempIn, tempOut, 2, () => settings.temperature, (v) => { settings.temperature = v; });
  wireRange(toppIn, toppOut, 2, () => settings.topP, (v) => { settings.topP = v; });
  wireRange(maxIn, maxOut, 0, () => settings.maxTokens, (v) => { settings.maxTokens = v; });
  wireRange(repIn, repOut, 2, () => settings.repetitionPenalty, (v) => { settings.repetitionPenalty = v; });
  wireRange(turnsIn, turnsOut, 0, () => settings.contextTurns, (v) => { settings.contextTurns = v; });

  dom.system.value = settings.system;
  dom.system.addEventListener('input', () => {
    settings.system = dom.system.value;
    saveSettings();
    drawPresets();
    drawCtx();
  });

  mdCheck.checked = settings.markdown;
  mdCheck.addEventListener('change', () => {
    settings.markdown = mdCheck.checked;
    saveSettings();
    drawChat();
  });

  autoCheck.checked = settings.autoscroll;
  autoCheck.addEventListener('change', () => {
    settings.autoscroll = autoCheck.checked;
    saveSettings();
  });
}

function drawPresets() {
  dom.presets.replaceChildren();
  for (const preset of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = preset.name;
    b.setAttribute('aria-pressed', String(settings.system === preset.prompt));
    b.addEventListener('click', () => {
      settings.system = preset.prompt;
      dom.system.value = preset.prompt;
      saveSettings();
      drawPresets();
      drawCtx();
    });
    dom.presets.append(b);
  }
}

el<HTMLButtonElement>('settings-btn').addEventListener('click', () => sheets.settings.showModal());

el<HTMLButtonElement>('reset').addEventListener('click', () => {
  const modelId = settings.modelId;
  settings = { ...DEFAULTS, modelId };
  saveSettings();
  dom.system.value = settings.system;
  drawPresets();
  tempIn.value = String(settings.temperature);
  toppIn.value = String(settings.topP);
  maxIn.value = String(settings.maxTokens);
  repIn.value = String(settings.repetitionPenalty);
  turnsIn.value = String(settings.contextTurns);
  tempOut.textContent = settings.temperature.toFixed(2);
  toppOut.textContent = settings.topP.toFixed(2);
  maxOut.textContent = String(settings.maxTokens);
  repOut.textContent = settings.repetitionPenalty.toFixed(2);
  turnsOut.textContent = String(settings.contextTurns);
  mdCheck.checked = settings.markdown;
  autoCheck.checked = settings.autoscroll;
  applyTheme();
  toast('Settings reset');
});

el<HTMLButtonElement>('export-all').addEventListener('click', () => {
  download('local-chat.json', JSON.stringify({ version: 1, chats }, null, 2), 'application/json');
});

el<HTMLButtonElement>('import-btn').addEventListener('click', () => el<HTMLInputElement>('import-file').click());

el<HTMLInputElement>('import-file').addEventListener('change', async (event) => {
  const picked = (event.target as HTMLInputElement).files?.[0];
  if (!picked) return;
  try {
    const parsed = JSON.parse(await picked.text()) as { chats?: Chat[] };
    const incoming = (parsed.chats ?? []).map((c) => ({ ...c, id: crypto.randomUUID(), messages: c.messages ?? [] }));
    chats = [...incoming, ...chats];
    for (const c of incoming) void saveChat(c);
    drawList();
    toast(`Imported ${incoming.length}`);
  } catch {
    toast('Bad file', true);
  }
});

el<HTMLButtonElement>('wipe').addEventListener('click', async () => {
  if (!confirm('Delete every chat and setting?')) return;
  await idb('chats', 'readwrite', (s) => s.clear());
  await idb('kv', 'readwrite', (s) => s.clear());
  chats = [];
  settings = { ...DEFAULTS };
  newChat();
  dom.system.value = settings.system;
  applyTheme();
  toast('Deleted');
});

/* ============ models sheet ============ */

async function drawModels() {
  dom.modelList.replaceChildren();
  const gpu = await webgpu();
  dom.gpuHint.textContent = gpu ? 'WebGPU found, models run on your GPU.' : 'No WebGPU, CPU only. Pick a small model.';

  let cached: string[] = [];
  try {
    const cache = await caches.open('transformers-cache');
    cached = (await cache.keys()).map((r) => r.url);
  } catch {
    cached = [];
  }

  for (const m of MODELS) {
    const card = document.createElement('div');
    card.className = m.id === settings.modelId ? 'model-card active' : 'model-card';

    const top = document.createElement('div');
    top.className = 'top';
    const name = document.createElement('strong');
    name.textContent = m.name;
    top.append(name);
    if (m.badge) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = m.badge;
      top.append(badge);
    }
    card.append(top);

    const meta = document.createElement('p');
    meta.textContent = `${m.size} · ${m.note}`;
    card.append(meta);

    const row = document.createElement('div');
    row.className = 'acts-row';

    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'btn-ghost';
    use.textContent = m.id === settings.modelId && state === 'ready' ? 'Loaded' : 'Load';
    use.disabled = m.id === settings.modelId && (state === 'ready' || state === 'loading');
    use.addEventListener('click', () => {
      sheets.models.close();
      void loadModel(m.id);
    });
    row.append(use);

    if (m.id === settings.modelId && state === 'ready') {
      const off = document.createElement('button');
      off.type = 'button';
      off.className = 'btn-ghost';
      off.textContent = 'Unload';
      off.addEventListener('click', async () => {
        await unloadModel();
        void drawModels();
      });
      row.append(off);
    }

    if (cached.some((url) => url.includes(m.id))) {
      const tag = document.createElement('span');
      tag.className = 'cached';
      tag.textContent = 'cached';
      row.append(tag);

      const purge = document.createElement('button');
      purge.type = 'button';
      purge.className = 'btn-ghost danger';
      purge.textContent = 'Remove';
      purge.addEventListener('click', async () => {
        const cache = await caches.open('transformers-cache');
        for (const req of await cache.keys()) {
          if (req.url.includes(m.id)) await cache.delete(req);
        }
        toast('Removed');
        void drawModels();
      });
      row.append(purge);
    }

    card.append(row);
    dom.modelList.append(card);
  }
}

el<HTMLButtonElement>('models-btn').addEventListener('click', async () => {
  await drawModels();
  sheets.models.showModal();
});

el<HTMLButtonElement>('model-chip').addEventListener('click', async () => {
  await drawModels();
  sheets.models.showModal();
});

/* ============ diagnostics ============ */

el<HTMLButtonElement>('diag-btn').addEventListener('click', async () => {
  const lines: string[] = [];
  lines.push(`secure: ${window.isSecureContext}`);
  lines.push(`webgpu: ${(await webgpu()) ? 'adapter found' : 'none'}`);
  lines.push(`state: ${state}`);
  lines.push(`model: ${settings.modelId}`);

  const free = await freeMB();
  lines.push(`free: ${free === null ? 'unknown' : Math.round(free) + ' MB'}`);

  try {
    lines.push(`persisted: ${await navigator.storage.persisted()}`);
  } catch {
    lines.push('persisted: unknown');
  }

  try {
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    lines.push(`cached: ${keys.length}`);
    for (const req of keys) lines.push(`  ${req.url.split('/').pop()}`);
  } catch {
    lines.push('cached: unknown');
  }

  lines.push(`chats: ${chats.length}`);
  lines.push(`ua: ${navigator.userAgent}`);

  dom.diagBody.textContent = lines.join('\n');
  sheets.diag.showModal();
});

el<HTMLButtonElement>('diag-copy').addEventListener('click', () => {
  void navigator.clipboard.writeText(dom.diagBody.textContent ?? '').then(() => toast('Copied'));
});

el<HTMLButtonElement>('diag-clear').addEventListener('click', async () => {
  const cache = await caches.open('transformers-cache');
  for (const req of await cache.keys()) await cache.delete(req);
  toast('Cache cleared. Reload before loading a model.');
});

/* ============ palette ============ */

type Command = { label: string; keys?: string; run: () => void };

const COMMANDS: Command[] = [
  { label: 'New chat', keys: 'Ctrl Shift O', run: () => newChat() },
  { label: 'Models', run: () => void el<HTMLButtonElement>('models-btn').click() },
  { label: 'Settings', run: () => sheets.settings.showModal() },
  { label: 'Diagnostics', run: () => void el<HTMLButtonElement>('diag-btn').click() },
  { label: 'Export chat', run: () => void el<HTMLButtonElement>('export-btn').click() },
  { label: 'Unload model', run: () => void unloadModel() },
];

function drawPalette(query: string) {
  dom.paletteList.replaceChildren();
  const hits = COMMANDS.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()));
  hits.forEach((cmd, index) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(index === 0));
    li.textContent = cmd.label;
    if (cmd.keys) {
      const kbd = document.createElement('kbd');
      kbd.textContent = cmd.keys;
      li.append(kbd);
    }
    li.addEventListener('click', () => {
      sheets.palette.close();
      cmd.run();
    });
    dom.paletteList.append(li);
  });
}

dom.paletteInput.addEventListener('input', () => drawPalette(dom.paletteInput.value));
dom.paletteInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  (dom.paletteList.querySelector('li') as HTMLElement | null)?.click();
  sheets.palette.close();
});

/* ============ theme + keys ============ */

el<HTMLButtonElement>('theme-btn').addEventListener('click', () => {
  settings.theme = settings.theme === 'light' ? 'dark' : 'light';
  applyTheme();
  saveSettings();
});

window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;

  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    dom.paletteInput.value = '';
    drawPalette('');
    sheets.palette.showModal();
    dom.paletteInput.focus();
  }
  if (mod && event.shiftKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    newChat();
  }
  if (event.key === 'Escape') closeMenu();
});

document.addEventListener('click', (event) => {
  const node = event.target as HTMLElement;
  if (node.closest('[data-close]')) node.closest('dialog')?.close();
});

/* ============ boot ============ */

async function boot() {
  try {
    if (!window.isSecureContext) crash('Needs HTTPS or localhost.');

    const saved = (await getKV('settings')) as Settings | undefined;
    if (saved) settings = { ...DEFAULTS, ...saved };

    applyTheme();
    wireSettings();
    drawPresets();
  } catch (error) {
    crash(`settings: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    chats = (await loadChats()).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    chats = [];
    crash(`storage: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (chats.length) {
    chat = chats[0];
    drawList();
  } else {
    newChat();
  }
  drawChat();

  try {
    if (!(await webgpu())) {
      paintBanner('<b>No WebGPU.</b> You can still load the 0.5B on CPU, it will just be slow.');
    }
  } catch {
    /* ignore */
  }

  try {
    if (!(await getKV('onboarded'))) {
      sheets.onboarding.showModal();
      el<HTMLButtonElement>('onb-load').addEventListener('click', () => {
        sheets.onboarding.close();
        void setKV('onboarded', true);
        void loadModel(MODELS[0].id);
      });
    }
  } catch {
    /* ignore */
  }

  dom.input.focus();
  booted = true;
}

boot().catch((error: unknown) => crash(error instanceof Error ? error.message : String(error)));
