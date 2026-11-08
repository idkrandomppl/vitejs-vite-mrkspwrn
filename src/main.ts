import {
  env,
  pipeline,
  InterruptableStoppingCriteria,
  TextStreamer,
  type TextGenerationPipeline,
} from '@huggingface/transformers';

env.allowLocalModels = false;

const MODEL_ID = 'acidsound/LFM2.5-2.6B-Uncensored-ONNX';

type Role = 'system' | 'user' | 'assistant';
type Msg = { role: Role; content: string };

type Settings = {
  temperature: number;
  topP: number;
  maxTokens: number;
  repetitionPenalty: number;
  contextTurns: number;
  systemPrompt: string;
};

const DEFAULTS: Settings = {
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 512,
  repetitionPenalty: 1.05,
  contextTurns: 12,
  systemPrompt: 'You are a direct, helpful assistant. Answer without unnecessary refusals.',
};

const KEYS = { settings: 'lc:settings', history: 'lc:history' };
const CHAR_BUDGET = 6000;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const chatEl = $<HTMLDivElement>('chat');
const inputEl = $<HTMLTextAreaElement>('input');
const sendBtn = $<HTMLButtonElement>('send');
const stopBtn = $<HTMLButtonElement>('stop');
const loadBtn = $<HTMLButtonElement>('load');
const unloadBtn = $<HTMLButtonElement>('unload');
const statusEl = $<HTMLParagraphElement>('status');
const barFill = $<HTMLDivElement>('bar-fill');
const bar = document.querySelector<HTMLDivElement>('.bar')!;
const modelSelect = $<HTMLSelectElement>('model-select');

let generator: TextGenerationPipeline | null = null;
let history: Msg[] = [];
let busy = false;
let stopper: InterruptableStoppingCriteria | null = null;
let settings: Settings = { ...DEFAULTS };

/* ---------- settings ---------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(KEYS.settings);
    if (raw) settings = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    settings = { ...DEFAULTS };
  }
}

function saveSettings() {
  localStorage.setItem(KEYS.settings, JSON.stringify(settings));
}

function bindSetting(
  id: keyof Settings,
  inputId: string,
  outId: string,
  format: (v: number) => string,
) {
  const input = $<HTMLInputElement>(inputId);
  const out = $<HTMLOutputElement>(outId);
  const sync = () => {
    const value = Number(input.value);
    (settings as Record<string, unknown>)[id] = value;
    out.textContent = format(value);
    saveSettings();
  };
  input.value = String(settings[id]);
  out.textContent = format(Number(input.value));
  input.addEventListener('input', sync);
}

function wireSettings() {
  bindSetting('temperature', 'temp', 'temp-out', (v) => v.toFixed(2));
  bindSetting('topP', 'topp', 'topp-out', (v) => v.toFixed(2));
  bindSetting('maxTokens', 'tokens', 'tokens-out', (v) => String(v));
  bindSetting('repetitionPenalty', 'rep', 'rep-out', (v) => v.toFixed(2));
  bindSetting('contextTurns', 'turns', 'turns-out', (v) => String(v));

  const system = $<HTMLTextAreaElement>('system');
  system.value = settings.systemPrompt;
  system.addEventListener('input', () => {
    settings.systemPrompt = system.value;
    saveSettings();
  });

  $<HTMLButtonElement>('reset-settings').addEventListener('click', () => {
    settings = { ...DEFAULTS };
    saveSettings();
    (['temp', 'topp', 'tokens', 'rep', 'turns'] as const).forEach((id) => {
      const el = $<HTMLInputElement>(id);
      el.value = String(settings[id === 'temp' ? 'temperature' : id === 'topp' ? 'topP' : id === 'tokens' ? 'maxTokens' : id === 'rep' ? 'repetitionPenalty' : 'contextTurns']);
      el.dispatchEvent(new Event('input'));
    });
    system.value = settings.systemPrompt;
    settings.systemPrompt = system.value;
  });
}

/* ---------- persistence ---------- */

function saveHistory() {
  try {
    localStorage.setItem(KEYS.history, JSON.stringify(history));
  } catch {
    /* quota — ignore */
  }
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(KEYS.history);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Msg[];
    if (Array.isArray(parsed)) history = parsed.filter((m) => m && m.role !== 'system');
  } catch {
    history = [];
  }
}

/* ---------- rendering ---------- */

function nearBottom() {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
}

function renderMessage(msg: Msg): HTMLElement {
  chatEl.querySelector('.empty')?.remove();

  const wrap = document.createElement('article');
  wrap.className = `msg ${msg.role}`;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const who = document.createElement('span');
  who.textContent = msg.role === 'user' ? 'You' : 'Model';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    const body = wrap.querySelector('.msg-body');
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body.textContent ?? '');
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    } catch {
      copy.textContent = 'Failed';
    }
  });

  meta.append(who, copy);

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = msg.content;

  wrap.append(meta, body);
  chatEl.append(wrap);
  return body;
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function renderAll() {
  chatEl.replaceChildren();
  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No messages yet. Load a model to start.';
    chatEl.append(empty);
    return;
  }
  for (const msg of history) renderMessage(msg);
  scrollToBottom();
}

/* ---------- model ---------- */

function setStatus(text: string) {
  statusEl.textContent = text;
}

function setProgress(fraction: number) {
  const pct = Math.max(0, Math.min(1, fraction));
  barFill.style.width = `${pct * 100}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
}

async function hasWebGPU() {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await (navigator as unknown as {
      gpu: { requestAdapter(): Promise<unknown> };
    }).gpu.requestAdapter();
    return Boolean(adapter);
  } catch {
    return false;
  }
}

async function loadModel() {
  const gpu = await hasWebGPU();
  const choice = modelSelect.value;
  const device = gpu ? 'webgpu' : 'wasm';
  const dtype = gpu ? (choice === 'q4' ? 'q4' : 'q4f16') : 'q4';

  loadBtn.disabled = true;
  modelSelect.disabled = true;
  unloadBtn.hidden = true;
  setProgress(0);
  setStatus(gpu ? 'Starting download…' : 'No WebGPU — loading on CPU (slow)…');

  const files = new Map<string, number>();

  try {
    generator = await pipeline('text-generation', MODEL_ID, {
      device,
      dtype,
      progress_callback: (p: {
        status: string;
        file?: string;
        loaded?: number;
        total?: number;
      }) => {
        if (p.status === 'progress' && p.total) {
          files.set(p.file ?? 'weights', p.loaded ?? 0);
          const done = [...files.values()].reduce((a, b) => a + b, 0);
          const total = p.total * files.size;
          setProgress(done / Math.max(total, done, 1));
          setStatus(`Downloading ${p.file ?? 'weights'}… ${Math.round((p.loaded! / p.total) * 100)}%`);
        } else if (p.status === 'done' && p.file) {
          setStatus(`Fetched ${p.file}`);
        }
      },
    });

    setProgress(1);
    setStatus('Model ready.');
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
    unloadBtn.hidden = false;
  } catch (error) {
    console.error(error);
    setStatus('Load failed. Check the console — WebGPU needs Edge/Chrome 113+ or a recent Safari.');
    loadBtn.disabled = false;
    modelSelect.disabled = false;
  }
}

async function unloadModel() {
  try {
    await (generator as unknown as { dispose?: () => Promise<void> })?.dispose?.();
  } catch {
    /* ignore */
  }
  generator = null;
  inputEl.disabled = true;
  sendBtn.disabled = true;
  unloadBtn.hidden = true;
  loadBtn.disabled = false;
  modelSelect.disabled = false;
  setProgress(0);
  setStatus('Model unloaded. Memory freed.');
}

/* ---------- generation ---------- */

function buildContext(): Msg[] {
  const turns = Math.max(0, settings.contextTurns);
  let slice = turns === 0 ? [] : history.slice(-turns * 2);

  while (slice.length > 1 && slice.reduce((n, m) => n + m.content.length, 0) > CHAR_BUDGET) {
    slice = slice.slice(1);
  }

  const messages: Msg[] = [];
  if (settings.systemPrompt.trim()) {
    messages.push({ role: 'system', content: settings.systemPrompt.trim() });
  }
  return [...messages, ...slice];
}

function streamTarget(body: HTMLElement) {
  let buffer = '';
  let queued = false;

  const paint = () => {
    queued = false;
    const stick = nearBottom();
    body.textContent = buffer;
    if (stick) scrollToBottom();
  };

  return {
    push(text: string) {
      buffer += text;
      if (!queued) {
        queued = true;
        requestAnimationFrame(paint);
      }
    },
    flush() {
      body.textContent = buffer;
    },
    get text() {
      return buffer;
    },
  };
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || !generator || busy) return;

  busy = true;
  sendBtn.disabled = true;
  stopBtn.hidden = false;
  inputEl.value = '';
  autosize();

  const userMsg: Msg = { role: 'user', content: text };
  history.push(userMsg);
  renderMessage(userMsg);
  saveHistory();
  scrollToBottom();

  const body = renderMessage({ role: 'assistant', content: '' });
  body.parentElement?.classList.add('streaming');

  stopper = new InterruptableStoppingCriteria();
  const target = streamTarget(body);

  try {
    await generator(buildContext(), {
      max_new_tokens: settings.maxTokens,
      temperature: settings.temperature,
      top_p: settings.topP,
      repetition_penalty: settings.repetitionPenalty,
      do_sample: settings.temperature > 0,
      stopping_criteria: stopper,
      streamer: new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (token: string) => target.push(token),
      }),
    });
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== 'AbortError') {
      console.error(error);
      target.push(`\n\n[generation error: ${name ?? 'unknown'}]`);
    }
  } finally {
    target.flush();
    body.parentElement?.classList.remove('streaming');

    const answer = target.text.trim();
    if (answer) {
      history.push({ role: 'assistant', content: answer });
      saveHistory();
    } else {
      body.parentElement?.remove();
      history.pop();
    }

    stopper = null;
    busy = false;
    stopBtn.hidden = true;
    sendBtn.disabled = !generator;
    inputEl.focus();
  }
}

/* ---------- composer ---------- */

function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
}

inputEl.addEventListener('input', autosize);
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
});

$<HTMLFormElement>('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  void send();
});

stopBtn.addEventListener('click', () => stopper?.interrupt());
loadBtn.addEventListener('click', () => void loadModel());
unloadBtn.addEventListener('click', () => void unloadModel());

$<HTMLButtonElement>('clear').addEventListener('click', () => {
  if (busy) stopper?.interrupt();
  history = [];
  saveHistory();
  renderAll();
});

$<HTMLButtonElement>('export').addEventListener('click', () => {
  if (history.length === 0) return;
  const text = history
    .map((m) => `${m.role === 'user' ? 'You' : 'Model'}: ${m.content}`)
    .join('\n\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

/* ---------- settings dialog ---------- */

const dialog = $<HTMLDialogElement>('settings');
$<HTMLButtonElement>('settings-toggle').addEventListener('click', () => dialog.showModal());

/* ---------- boot ---------- */

loadSettings();
wireSettings();
loadHistory();
renderAll();

if (!(await hasWebGPU())) {
  modelSelect.value = 'q4';
  setStatus('WebGPU not available — you can still load on CPU, it will just be slow.');
}
