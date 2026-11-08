import { attach, type Res } from './inference';
import type { Port } from './client';

export function createDirectPort(): Port {
  let handler: ((res: Res) => void) | null = null;
  const handle = attach((res) => handler?.(res));
  return {
    postMessage: (req) => void handle(req),
    terminate: () => {},
    setHandler: (fn) => {
      handler = fn;
    },
  };
}
