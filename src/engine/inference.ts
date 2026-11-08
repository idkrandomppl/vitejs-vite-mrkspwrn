type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export type Req =
  | { type: 'load'; modelId: string; device: 'webgpu' | 'wasm'; dtype: string }
  | {
      type: 'generate';
      messages: Message[];
      params: { maxNewTokens: number; temperature: number; topP: number; repetitionPenalty: number };
    }
  | { type: 'stop' };

export type Res =
  | { type: 'ready' }
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'token'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

type Lib = typeof import('@huggingface/transformers');

export function attach(post: (res: Res) => void) {
  let lib: Lib | null = null;
  let generator: Awaited<ReturnType<Lib['pipeline']>> | null = null;
  let stopper: { interrupt(): void } | null = null;
  let busy = false;

  const load = async (req: Extract<Req, { type: 'load' }>) => {
    lib = await import('@huggingface/transformers');
    lib.env.allowLocalModels = false;
    if (req.device === 'wasm') {
      lib.env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2));
    }

    generator = (await lib.pipeline('text-generation', req.modelId, {
      device: req.device,
      dtype: req.dtype as never,
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.total) {
          post({ type: 'progress', file: p.file ?? 'weights', loaded: p.loaded ?? 0, total: p.total });
        }
      },
    })) as never;

    post({ type: 'ready' });
  };

  const generate = async (req: Extract<Req, { type: 'generate' }>) => {
    if (!lib || !generator || busy) return;
    busy = true;

    const criteria = new lib.InterruptableStoppingCriteria();
    stopper = criteria;
    let text = '';

    try {
      await generator(req.messages as never, {
        max_new_tokens: req.params.maxNewTokens,
        temperature: req.params.temperature,
        top_p: req.params.topP,
        repetition_penalty: req.params.repetitionPenalty,
        do_sample: req.params.temperature > 0,
        stopping_criteria: criteria as never,
        streamer: new lib.TextStreamer(generator.tokenizer as never, {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (token: string) => {
            text += token;
            post({ type: 'token', text: token });
          },
        }),
      });
      post({ type: 'done', text });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      post({ type: 'error', message });
      post({ type: 'done', text });
    } finally {
      busy = false;
      stopper = null;
    }
  };

  return async function handle(req: Req) {
    switch (req.type) {
      case 'load':
        try {
          await load(req);
        } catch (error) {
          post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
        break;
      case 'generate':
        await generate(req);
        break;
      case 'stop':
        stopper?.interrupt();
        break;
    }
  };
}
