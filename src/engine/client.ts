import type { Req, Res } from './inference';

export type Port = {
  postMessage(req: Req): void;
  terminate(): void;
  setHandler(fn: (res: Res) => void): void;
};

export async function createPort(): Promise<Port> {
  try {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    return {
      postMessage: (req) => worker.postMessage(req),
      terminate: () => worker.terminate(),
      setHandler: (fn) => {
        worker.onmessage = (event: MessageEvent<Res>) => fn(event.data);
        worker.onerror = () => fn({ type: 'error', message: 'Worker crashed' });
      },
    };
  } catch {
    const { createDirectPort } = await import('./direct');
    return createDirectPort();
  }
}
