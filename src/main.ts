import { renderMarkdown } from './markdown';
import { PRESETS } from './presets';
import { toast } from './toast';
import { createPort, type Port } from './engine/client';
import type { Res } from './engine/inference';
import * as store from './store';

type Role = 'system' | 'user' | 'assistant';
type Msg = { role: Role; content: string; at: number };
type Chat = { id: string; title: string; createdAt: number; updatedAt: number; messages: Msg[] };

type Model = {
  id: string;
  name: string;
  params: string;
  size: string;
  ctx: number;
  note: string;
  badge?: string;
  dtype: { webgpu: string; wasm: string };
};

const MODELS: Model[] = [
  {
    id: 'acidsound/LFM2.5-2.6B-Uncensored-ONNX',
    name: 'LFM2.5 2.6B Uncensored',
    params: '2.6B',
    size: '1.7 GB',
    ctx: 32000,
    note: 'Best quality and most willing. Wants WebGPU.',
    badge: 'Recommended',
    dtype: { webgpu: 'q4f16', wasm: 'q4' },
  },
  {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    name: 'Qwen2.5 1.5B Instruct',
    params: '1.5B',
    size: '1.0 GB',
    ctx: 32000,
    note: 'Balanced: quick replies, still coherent.',
    dtype: { webgpu: 'q4f16', wasm: 'q4' },
  },
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    name: 'Qwen2.5 0.5B Instruct',
    params: '0.5B',
    size: '0.4 GB',
    ctx: 32000,
    note: 'Smallest and fastest. Good on CPU.',
    badge: 'Fast',
    dtype: { webgpu: 'q4f16', wasm: 'q4' },
  },
];

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
  theme: 'auto' | 'dark' | 'light';
};

const DEFAULTS: Settings = {
  modelId: MODELS[0].id,
  system: PRESETS[0].prompt,
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 512,
  repetitionPenalty: 1.05,
  contextTurns: 12,
  markdown: true,
  autoscroll: true,
  theme: 'auto',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const chatEl = $<HTMLDivElement>('chat');
const inputEl = $<HTMLTextAreaElement>('input');
const sendBtn = $<HTMLButtonElement>('send');
const stopBtn = $<HTMLButtonElement>('stop');
const titleEl = $<HTMLHeadingElement>('chat-title');
const modelChip = $<HTMLButtonElement>('model-chip');
const modelDot = $<HTMLSpanElement>('model-dot');
const modelName = $<HTMLSpanElement>('model-name');
const listEl = $<HTMLElement>('chat-list');
const sidebar = $<HTMLElement>('sidebar');
const ctxEl = $<HTMLDivElement>('ctx');
const ctxFill = $<HTMLDivElement>('ctx-fill');
const ctxLabel = $<HTMLSpanElement>('ctx-label');
const attachEl = $<HTMLDivElement>('attachments');
const jumpBtn = $<HTMLButtonElement>('jump');

let settings: Settings = { ...DEFAULTS };
let chats: Chat[] = [];
let chat: Chat | null = null;
let port: Port | null = null;
let state: 'idle' | 'loading' | 'ready' | 'busy' = 'idle';
let attachments: { name: string; text: string }[] = [];
let follow = true;
let listening: { stop(): void } | null = null;

/* ---------------- settings ---------------- */

const saveSettings = () => void store.put('kv', settings, 'settings');

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
}

/* ---------------- model status ---------------- */

function setStatus(next: typeof state) {
  state = next;
  modelDot.className = `dot ${next === 'ready' ? 'ready' : next === 'busy' ? 'busy' : ''}`;
  const model = MODELS.find((m) => m.id === settings.modelId);
  modelName.textContent = next === 'ready' ? (model?.name ?? 'Model') : next === 'loading' ? 'Loading…' : next === 'busy' ? 'Thinking…' : 'No model';
  sendBtn.disabled = next !== 'ready';
  stopBtn.hidden = next !== 'busy';
  sendBtn.hidden = next === 'busy';
}

async function ensurePort(): Promise<Port> {
  if (port) return port;
  port = await createPort();
  port.setHandler(onEngine);
  return port;
}

function onEngine(res: Res) {
  switch (res.type) {
    case 'ready':
      setStatus('ready');
      toast('Model ready');
      break;
    case 'progress':
      setStatus('loading');
      break;
    case 'token':
      pushToken(res.text);
      break;
    case 'done':
      finishStream();
      break;
    case 'error':
      toast(res.message.slice(0, 160), true);
      if (state === 'loading') setStatus('idle');
      break;
  }
}

async function loadModel(modelId: string) {
  const model = MODELS.find((m) => m.id === modelId);
  if (!model) return;

  settings.modelId = modelId;
  void saveSettings();
  setStatus('loading');

  const gpu = await hasWebGPU();
  const p = await ensurePort();
  p.postMessage({
    type: 'load',
    modelId,
    device: gpu ? 'webgpu' : 'wasm',
    dtype: gpu ? model.dtype.webgpu : model.dtype.wasm,
  });
  if (!gpu) toast('No WebGPU — running on CPU, replies will be slow', true);
}

async function unloadModel() {
  port?.terminate();
  port = null;
  setStatus('idle');
  toast('Model unloaded, memory freed');
}

async function hasWebGPU() {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

/* ---------------- chats ---------------- */

function newChat(): Chat {
  const fresh: Chat = { id: crypto.randomUUID(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  chats.unshift(fresh);
  chat = fresh;
  void store.put('chats', fresh);
  renderList();
  renderChat();
  inputEl.focus();
  return fresh;
}

function openChat(id: string) {
  const found = chats.find((c) => c.id === id);
  if (!found) return;
  chat = found;
  renderList();
  renderChat();
  sidebar.classList.remove('open');
}

function deleteChat(id: string) {
  chats = chats.filter((c) => c.id !== id);
  void store.del('chats', id);
  if (chat?.id === id) {
    if (chats.length) openChat(chats[0].id);
    else newChat();
  } else {
    renderList();
  }
}

function touch() {
  if (!chat) return;
  chat.updatedAt = Date.now();
  void store.put('chats', chat);
}

function renderList(filter = '') {
  const q = filter.trim().toLowerCase();
  listEl.replaceChildren();

  const visible = q
    ? chats.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)))
    : chats;

  for (const item of visible) {
    const row = document.createElement('button');
    row.className = 'chat-item';
    row.type = 'button';
    row.setAttribute('aria-current', String(item.id === chat?.id));

    const label = document.createElement('span');
    label.textContent = item.title;
    row.append(label);

    const del = document.createElement('span');
    del.className = 'del';
    del.innerHTML = '<svg><use href="#i-trash"/></svg>';
    del.setAttribute('role', 'button');
    del.setAttribute('aria-label', `Delete ${item.title}`);
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteChat(item.id);
    });
    row.append(del);

    row.addEventListener('click', () => openChat(item.id));
    listEl.append(row);
  }
}

function renderChat() {
  chatEl.replaceChildren();
  titleEl.textContent = chat?.title ?? 'New chat';

  if (!chat || chat.messages.length === 0) {
    const box = document.createElement('div');
    box.className = 'empty';
    box.innerHTML =
      '<h2>Nothing here yet</h2><p>Ask anything. The model runs locally, so there is no account, no quota and no logging.</p>';
    chatEl.append(box);
  } else {
    for (const msg of chat.messages) renderMessage(msg);
  }
  updateCtx();
  scrollBottom();
}

/* ---------------- message rendering ---------------- */

function bodyFor(text: string, asMarkdown: boolean): HTMLElement {
  const body = document.createElement('div');
  if (asMarkdown && settings.markdown) {
    body.className = 'msg-body md';
    body.innerHTML = renderMarkdown(text);
  } else {
    body.className = 'msg-body';
    body.textContent = text;
  }
  return body;
}

function renderMessage(msg: Msg): HTMLElement {
  chatEl.querySelector('.empty')?.remove();

  const wrap = document.createElement('article');
  wrap.className = `msg ${msg.role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.append(bodyFor(msg.content, msg.role === 'assistant'));
  wrap.append(bubble);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const mk = (icon: string, label: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<svg><use href="#i-${icon}"/></svg>`;
    b.addEventListener('click', run);
    actions.append(b);
  };

  mk('copy', 'Copy', () => {
    void navigator.clipboard.writeText(msg.content).then(() => toast('Copied'));
  });

  if (msg.role === 'assistant') {
    mk('redo', 'Regenerate', () => regenerate(msg));
    if ('speechSynthesis' in window) {
      mk('speak', 'Read aloud', () => {
        speechSynthesis.cancel();
        speechSynthesis.speak(new SpeechSynthesisUtterance(msg.content));
      });
    }
  } else {
    mk('edit', 'Edit and resend', () => startEdit(wrap, msg));
  }

  wrap.append(actions);
  chatEl.append(wrap);
  return wrap;
}

function startEdit(wrap: HTMLElement, msg: Msg) {
  if (!chat || state === 'busy') return;

  const box = document.createElement('div');
  box.className = 'edit-box';
  const area = document.createElement('textarea');
  area.value = msg.content;
  area.rows = Math.min(14, msg.content.split('\n').length + 2);

  const bar = document.createElement('div');
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => renderChat());
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Resend';
  save.addEventListener('click', () => {
    const next = area.value.trim();
    if (!next) return;
    const index = chat!.messages.indexOf(msg);
    chat!.messages = chat!.messages.slice(0, index);
    void store.put('chats', chat!);
    renderChat();
    void submit(next);
  });

  bar.append(cancel, save);
  box.append(area, bar);
  wrap.replaceChildren(box);
  area.focus();
}

function regenerate(msg: Msg) {
  if (!chat || state !== 'ready') return;
  const index = chat.messages.indexOf(msg);
  if (index < 0) return;
  chat.messages = chat.messages.slice(0, index);
  void store.put('chats', chat);
  renderChat();
  void run();
}

/* ---------------- context ---------------- */

function contextMessages(): Msg[] {
  if (!chat) return [];
  const turns = Math.max(0, settings.contextTurns);
  const model = MODELS.find((m) => m.id === settings.modelId);
  const budget = Math.floor((model?.ctx ?? 8000) * 0.7) * 3.6;

  let slice = turns === 0 ? [] : chat.messages.slice(-turns * 2);
  while (slice.length > 1 && slice.reduce((n, m) => n + m.content.length, 0) > budget) slice = slice.slice(1);
  return slice;
}

function updateCtx() {
  const model = MODELS.find((m) => m.id === settings.modelId);
  if (!model || !chat) {
    ctxEl.hidden = true;
    return;
  }
  const used = contextMessages().reduce((n, m) => n + m.content.length, 0) / 3.6 + settings.system.length / 3.6;
  const max = model.ctx;
  const ratio = Math.min(used / max, 1);

  ctxEl.hidden = chat.messages.length === 0;
  ctxFill.style.width = `${ratio * 100}%`;
  ctxLabel.textContent = `${Math.round(used)} / ${max} tokens`;
  ctxEl.className = `ctx${ratio > 0.9 ? ' full' : ratio > 0.75 ? ' hot' : ''}`;
}

/* ---------------- streaming ---------------- */

let streamWrap: HTMLElement | null = null;
let streamBody: HTMLElement | null = null;
let streamText = '';
let paintQueued = false;

function pushToken(text: string) {
  streamText += text;
  if (paintQueued || !streamBody) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    if (!streamBody) return;
    const stick = follow && settings.autoscroll;
    if (settings.markdown) streamBody.innerHTML = renderMarkdown(streamText);
    else streamBody.textContent = streamText;
    if (stick) scrollBottom();
    jumpBtn.hidden = true;
  });
}

function finishStream() {
  if (!streamBody || !chat) return;
  const final = streamText.trim();
  streamWrap?.classList.remove('streaming');

  if (final) {
    chat.messages.push({ role: 'assistant', content: final, at: Date.now() });
    touch();
    const index = chat.messages.length - 1;
    streamWrap?.remove();
    const fresh = renderMessage(chat.messages[index]);
    void fresh;
  } else {
    streamWrap?.remove();
  }

  streamWrap = null;
  streamBody = null;
  streamText = '';
  setStatus('ready');
  updateCtx();
  scrollBottom();
  inputEl.focus();
}

function scrollBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

/* ---------------- generation ---------------- */

async function run() {
  if (!chat || state !== 'ready') return;

  const context = contextMessages().map(({ role, content }) => ({ role, content }));
  const messages = settings.system.trim()
    ? [{ role: 'system' as const, content: settings.system.trim() }, ...context]
    : context;

  if (messages.length === 0) return;

  setStatus('busy');
  streamText = '';
  streamWrap = document.createElement('article');
  streamWrap.className = 'msg assistant streaming';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  streamBody = bodyFor('', settings.markdown);
  bubble.append(streamBody);
  streamWrap.append(bubble);
  chatEl.append(streamWrap);
  scrollBottom();

  const p = await ensurePort();
  p.postMessage({
    type: 'generate',
    messages,
    params: {
      maxNewTokens: settings.maxTokens,
      temperature: settings.temperature,
      topP: settings.topP,
      repetitionPenalty: settings.repetitionPenalty,
    },
  });
}

async function submit(text: string) {
  if (!chat) newChat();
  if (!chat) return;

  const body = attachments.length
    ? `${text}\n\n${attachments.map((a) => `<file name="${a.name}">\n${a.text}\n</file>`).join('\n\n')}`
    : text;

  chat.messages.push({ role: 'user', content: body, at: Date.now() });
  if (chat.title === 'New chat') chat.title = text.slice(0, 48) || 'New chat';
  touch();
  renderChat();
  renderList();

  attachments = [];
  renderAttachments();
  await run();
}

/* ---------------- composer ---------------- */

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 220)}px`;
}

function renderAttachments() {
  attachEl.replaceChildren();
  attachEl.hidden = attachments.length === 0;
  attachments.forEach((file, index) => {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = file.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.innerHTML = '<svg><use href="#i-x"/></svg>';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.addEventListener('click', () => {
      attachments.splice(index, 1);
      renderAttachments();
    });
    pill.append(remove);
    attachEl.append(pill);
  });
}

$<HTMLFormElement>('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = inputEl.value.trim();
  if (!text || state !== 'ready') return;
  inputEl.value = '';
  autosize();
  void submit(text);
});

inputEl.addEventListener('input', autosize);
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $<HTMLFormElement>('composer').requestSubmit();
  }
});

stopBtn.addEventListener('click', () => port?.postMessage({ type: 'stop' }));

$<HTMLButtonElement>('attach-btn').addEventListener('click', () => $<HTMLInputElement>('file').click());

$<HTMLInputElement>('file').addEventListener('change', async (event) => {
  const files = (event.target as HTMLInputElement).files;
  if (!files) return;
  for (const file of Array.from(files).slice(0, 4)) {
    const text = await file.text();
    attachments.push({ name: file.name, text: text.slice(0, 20000) });
  }
  renderAttachments();
  (event.target as HTMLInputElement).value = '';
});

const micBtn = $<HTMLButtonElement>('mic-btn');
const Recognition =
  (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike }).webkitSpeechRecognition;

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
  onend: (() => void) | null;
};

if (Recognition) {
  micBtn.hidden = false;
  micBtn.addEventListener('click', () => {
    if (listening) {
      listening.stop();
      return;
    }
    const rec = new Recognition();
    rec.lang = navigator.language;
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (event) => {
      inputEl.value = event.results[0][0].transcript;
      autosize();
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

/* ---------------- chat actions ---------------- */

$<HTMLButtonElement>('new-chat').addEventListener('click', () => newChat());
$<HTMLButtonElement>('open-sidebar').addEventListener('click', () => sidebar.classList.add('open'));
$<HTMLButtonElement>('close-sidebar').addEventListener('click', () => sidebar.classList.remove('open'));

$<HTMLInputElement>('search').addEventListener('input', (event) => renderList((event.target as HTMLInputElement).value));

titleEl.addEventListener('click', () => {
  if (!chat) return;
  const next = prompt('Chat title', chat.title);
  if (next?.trim()) {
    chat.title = next.trim();
    touch();
    renderList();
    titleEl.textContent = chat.title;
  }
});

$<HTMLButtonElement>('export-btn').addEventListener('click', () => {
  if (!chat || chat.messages.length === 0) return toast('Nothing to export');
  const md = [`# ${chat.title}`, '']
    .concat(chat.messages.map((m) => `**${m.role === 'user' ? 'You' : 'Model'}**\n\n${m.content}\n`))
    .join('\n');
  download(`${chat.title.replace(/\W+/g, '-').slice(0, 40)}.md`, md, 'text/markdown');
});

function download(name: string, data: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

chatEl.addEventListener('scroll', () => {
  follow = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 90;
  jumpBtn.hidden = follow;
});

jumpBtn.addEventListener('click', () => {
  follow = true;
  scrollBottom();
});

chatEl.addEventListener('click', (event) => {
  const pre = (event.target as HTMLElement).closest('pre');
  if (!pre) return;
  const code = pre.querySelector('code')?.textContent ?? '';
  void navigator.clipboard.writeText(code).then(() => toast('Code copied'));
});

/* ---------------- settings dialog ---------------- */

const settingsSheet = $<HTMLDialogElement>('settings');

function bindRange(id: string, outId: string, key: keyof Settings, digits = 2) {
  const input = $<HTMLInputElement>(id);
  const out = $<HTMLOutputElement>(outId);
  const sync = () => {
    (settings[key] as number) = Number(input.value);
    out.textContent = digits ? Number(input.value).toFixed(digits) : input.value;
    void saveSettings();
  };
  input.value = String(settings[key]);
  out.textContent = digits ? Number(input.value).toFixed(digits) : String(input.value);
  input.addEventListener('input', sync);
}

const systemArea = $<HTMLTextAreaElement>('system');
const presetHost = $<HTMLDivElement>('presets');

function buildPresets() {
  presetHost.replaceChildren();
  for (const preset of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = preset.name;
    b.setAttribute('aria-pressed', String(settings.system === preset.prompt));
    b.addEventListener('click', () => {
      settings.system = preset.prompt;
      systemArea.value = preset.prompt;
      buildPresets();
      void saveSettings();
      updateCtx();
    });
    presetHost.append(b);
  }
}

bindRange('temp', 'temp-out', 'temperature');
bindRange('topp', 'topp-out', 'topP');
bindRange('max', 'max-out', 'maxTokens', 0);
bindRange('rep', 'rep-out', 'repetitionPenalty');
bindRange('turns', 'turns-out', 'contextTurns', 0);

systemArea.addEventListener('input', () => {
  settings.system = systemArea.value;
  buildPresets();
  void saveSettings();
  updateCtx();
});

$<HTMLInputElement>('markdown').addEventListener('change', (e) => {
  settings.markdown = (e.target as HTMLInputElement).checked;
  void saveSettings();
  renderChat();
});

$<HTMLInputElement>('autoscroll').addEventListener('change', (e) => {
  settings.autoscroll = (e.target as HTMLInputElement).checked;
  void saveSettings();
});

$<HTMLButtonElement>('settings-btn').addEventListener('click', () => {
  settingsSheet.showModal();
});

$<HTMLButtonElement>('reset').addEventListener('click', () => {
  settings = { ...DEFAULTS, modelId: settings.modelId };
  void saveSettings();
  hydrateSettings();
  toast('Settings reset');
});

function hydrateSettings() {
  applyTheme();
  systemArea.value = settings.system;
  buildPresets();
  for (const [id, key, digits] of [
    ['temp', 'temperature', 2],
    ['topp', 'topP', 2],
    ['max', 'maxTokens', 0],
    ['rep', 'repetitionPenalty', 2],
    ['turns', 'contextTurns', 0],
  ] as const) {
    $<HTMLInputElement>(id).value = String(settings[key]);
    $(`${id}-out`).textContent = digits ? Number(settings[key]).toFixed(digits) : String(settings[key]);
  }
  $<HTMLInputElement>('markdown').checked = settings.markdown;
  $<HTMLInputElement>('autoscroll').checked = settings.autoscroll;
}

$<HTMLButtonElement>('export-all').addEventListener('click', () => {
  download('local-chat-archive.json', JSON.stringify({ version: 1, chats }, null, 2), 'application/json');
});

$<HTMLButtonElement>('import-btn').addEventListener('click', () => $<HTMLInputElement>('import-file').click());

$<HTMLInputElement>('import-file').addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text()) as { chats?: Chat[] };
    const incoming = (parsed.chats ?? []).map((c) => ({ ...c, id: crypto.randomUUID() }));
    chats = [...incoming, ...chats];
    for (const c of incoming) void store.put('chats', c);
    renderList();
    toast(`Imported ${incoming.length} chat${incoming.length === 1 ? '' : 's'}`);
  } catch {
    toast('Could not read that file', true);
  }
});

$<HTMLButtonElement>('wipe').addEventListener('click', async () => {
  if (!confirm('Delete every chat and setting on this device?')) return;
  await store.clearStore('chats');
  await store.clearStore('kv');
  chats = [];
  settings = { ...DEFAULTS };
  newChat();
  hydrateSettings();
  toast('Everything deleted');
});

/* ---------------- model library ---------------- */

const modelSheet = $<HTMLDialogElement>('models');
const modelList = $<HTMLDivElement>('model-list');

async function renderModels() {
  modelList.replaceChildren();
  const gpu = await hasWebGPU();
  $<HTMLParagraphElement>('gpu-hint').textContent = gpu
    ? 'WebGPU detected — models run on your GPU.'
    : 'No WebGPU. Everything runs on CPU: pick a small model.';

  let cacheKeys: string[] = [];
  try {
    const cache = await caches.open('transformers-cache');
    cacheKeys = (await cache.keys()).map((r) => r.url);
  } catch {
    cacheKeys = [];
  }

  for (const model of MODELS) {
    const card = document.createElement('div');
    card.className = `model-card${model.id === settings.modelId ? ' active' : ''}`;

    const top = document.createElement('div');
    top.className = 'top';
    const name = document.createElement('strong');
    name.textContent = model.name;
    top.append(name);
    if (model.badge) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = model.badge;
      top.append(badge);
    }
    card.append(top);

    const meta = document.createElement('p');
    meta.textContent = `${model.params} params · ${model.size} download · ${model.note}`;
    card.append(meta);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'ghost';
    use.textContent = model.id === settings.modelId && state === 'ready' ? 'Loaded' : 'Load';
    use.disabled = model.id === settings.modelId && (state === 'ready' || state === 'loading');
    use.addEventListener('click', async () => {
      await loadModel(model.id);
      modelSheet.close();
      await renderModels();
    });
    actions.append(use);

    if (model.id === settings.modelId && state === 'ready') {
      const unload = document.createElement('button');
      unload.type = 'button';
      unload.className = 'ghost';
      unload.textContent = 'Unload';
      unload.addEventListener('click', async () => {
        await unloadModel();
        await renderModels();
      });
      actions.append(unload);
    }

    const cached = cacheKeys.some((url) => url.includes(model.id));
    if (cached) {
      const tag = document.createElement('span');
      tag.className = 'cached';
      tag.textContent = 'cached';
      actions.append(tag);

      const purge = document.createElement('button');
      purge.type = 'button';
      purge.className = 'ghost danger';
      purge.textContent = 'Remove';
      purge.addEventListener('click', async () => {
        try {
          const cache = await caches.open('transformers-cache');
          for (const req of await cache.keys()) {
            if (req.url.includes(model.id)) await cache.delete(req);
          }
          toast('Removed from cache');
          await renderModels();
        } catch {
          toast('Could not clear the cache', true);
        }
      });
      actions.append(purge);
    }

    card.append(actions);
    modelList.append(card);
  }
}

modelChip.addEventListener('click', async () => {
  await renderModels();
  modelSheet.showModal();
});

/* ---------------- command palette ---------------- */

const palette = $<HTMLDialogElement>('palette');
const paletteInput = $<HTMLInputElement>('palette-input');
const paletteList = $<HTMLUListElement>('palette-list');

type Command = { label: string; keys?: string; run: () => void };

const COMMANDS: Command[] = [
  { label: 'New chat', keys: 'Ctrl Shift O', run: () => newChat() },
  { label: 'Model library', run: () => void modelChip.click() },
  { label: 'Settings', run: () => settingsSheet.showModal() },
  { label: 'Export chat', run: () => void $<HTMLButtonElement>('export-btn').click() },
  { label: 'Toggle theme', run: () => cycleTheme() },
  { label: 'Unload model', run: () => void unloadModel() },
  { label: 'Delete this chat', run: () => chat && deleteChat(chat.id) },
];

function openPalette() {
  paletteInput.value = '';
  drawPalette('');
  palette.showModal();
  paletteInput.focus();
}

function drawPalette(query: string) {
  paletteList.replaceChildren();
  const q = query.toLowerCase();
  const hits = COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
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
      palette.close();
      cmd.run();
    });
    paletteList.append(li);
  });
}

paletteInput.addEventListener('input', () => drawPalette(paletteInput.value));
paletteInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const first = paletteList.querySelector('li');
  if (first) {
    palette.close();
    (first as HTMLElement).click();
  }
});

/* ---------------- theme ---------------- */

const THEMES = ['auto', 'dark', 'light'] as const;

function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(settings.theme) + 1) % THEMES.length];
  settings.theme = next;
  applyTheme();
  void saveSettings();
  toast(`Theme: ${next}`);
}

$<HTMLButtonElement>('theme-btn').addEventListener('click', cycleTheme);

/* ---------------- keyboard ---------------- */

window.addEventListener('keydown', (event) => {
  const mod = event.ctrlKey || event.metaKey;

  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
  }
  if (mod && event.shiftKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    newChat();
  }
  if (mod && event.key === '/') {
    event.preventDefault();
    settingsSheet.showModal();
  }
  if (event.key === 'Escape') sidebar.classList.remove('open');
});

document.addEventListener('click', (event) => {
  const el = event.target as HTMLElement;
  if (el.closest('[data-close]')) el.closest('dialog')?.close();
});

/* ---------------- boot ---------------- */

async function boot() {
  const saved = await store.get<Settings>('kv', 'settings');
  if (saved) settings = { ...DEFAULTS, ...saved };

  hydrateSettings();
  applyTheme();
  setStatus('idle');

  chats = (await store.all<Chat>('chats')).sort((a, b) => b.updatedAt - a.updatedAt);
  if (chats.length === 0) newChat();
  else {
    chat = chats[0];
    renderList();
    renderChat();
  }

  const onboarding = $<HTMLDialogElement>('onboarding');
  if (!(await store.get('kv', 'onboarded'))) {
    onboarding.showModal();
    $<HTMLButtonElement>('onb-load').addEventListener('click', async () => {
      onboarding.close();
      void store.put('kv', true, 'onboarded');
      await loadModel(settings.modelId);
    });
  }

  if (navigator.storage?.persist) void navigator.storage.persist();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
  }

  inputEl.focus();
}

void boot();
