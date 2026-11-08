import { attach, type Res } from './inference';

const ctx = self as unknown as {
  postMessage(value: Res): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

const handle = attach((res) => ctx.postMessage(res));
ctx.onmessage = (event: MessageEvent) => void handle(event.data);
