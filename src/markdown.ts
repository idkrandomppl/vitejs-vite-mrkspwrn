const MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => MAP[c]);

export function renderMarkdown(src: string): string {
  const blocks: string[] = [];
  const inlines: string[] = [];

  let text = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const i = blocks.push(
      `<pre data-lang="${esc(lang || 'code')}"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`,
    ) - 1;
    return `\u0000${i}\u0000`;
  });

  text = esc(text);
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const i = inlines.push(`<code>${code}</code>`) - 1;
    return `\u0001${i}\u0001`;
  });

  text = text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];

  const flushPara = () => {
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
      flushPara();
      closeList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length + 1, 6);
      out.push(`<h${level}>${heading[2]}</h${level}>`);
      continue;
    }

    const ul = /^[-*+]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
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
      flushPara();
      closeList();
      out.push(`<blockquote>${line.slice(2)}</blockquote>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushPara();
      closeList();
      out.push('<hr>');
      continue;
    }

    closeList();
    para.push(line);
  }
  flushPara();
  closeList();

  return out
    .join('\n')
    .replace(/\u0001(\d+)\u0001/g, (_m, i: string) => inlines[Number(i)] ?? '')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)] ?? '');
}
