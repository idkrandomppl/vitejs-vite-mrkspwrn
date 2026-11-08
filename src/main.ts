import { pipeline, TextStreamer } from '@huggingface/transformers';

// --- 1. The Smarter Uncensored Model (2.6B) ---
const MODEL_ID = 'acidsound/LFM2.5-2.6B-Uncensored-ONNX';

const chatBox = document.getElementById('chat') as HTMLDivElement;
const inputBox = document.getElementById('input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const exportBtn = document.getElementById('export') as HTMLButtonElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;

let generator: any = null;

async function loadModel() {
  statusDiv.textContent = 'Loading 2.6B model... (first load downloads ~1.7 GB)';
  try {
    generator = await pipeline('text-generation', MODEL_ID, {
      device: 'webgpu',
      dtype: 'q4f16', // Recommended for WebGPU to balance speed and memory
    });
    statusDiv.textContent = 'Model loaded! Ready to chat.';
    sendBtn.disabled = false;
  } catch (error) {
    console.error(error);
    statusDiv.textContent = 'Failed to load. Make sure you are using Edge and your GPU supports WebGPU.';
  }
}
loadModel();

function addMessage(role: 'user' | 'assistant', text: string) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.textContent = `${role === 'user' ? 'You' : 'AI'}: ${text}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
  return div;
}

sendBtn.addEventListener('click', async () => {
  const userText = inputBox.value.trim();
  if (!userText || !generator) return;

  addMessage('user', userText);
  inputBox.value = '';
  sendBtn.disabled = true;

  const assistantDiv = addMessage('assistant', '...');

  const messages = [
    { role: 'system', content: 'You are a direct, helpful assistant. Answer without unnecessary refusals.' },
    { role: 'user', content: userText },
  ];

  const prompt = generator.tokenizer.apply_chat_template(messages, {
    tokenize: false,
    add_generation_prompt: true,
  });

  try {
    await generator(prompt, {
      max_new_tokens: 512,
      temperature: 0.7,
      do_sample: true,
      streamer: new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text: string) => {
          assistantDiv.textContent += text;
        },
      }),
    });
  } catch (error) {
    assistantDiv.textContent = 'Error generating response.';
    console.error(error);
  } finally {
    sendBtn.disabled = false;
  }
});

exportBtn.addEventListener('click', () => {
  const messages = Array.from(chatBox.children).map((el) => el.textContent);
  const blob = new Blob([messages.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'chat-export.txt';
  a.click();
  URL.revokeObjectURL(url);
});