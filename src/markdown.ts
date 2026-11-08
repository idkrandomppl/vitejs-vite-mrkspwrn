const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENT[c]);

export function markdown(src: string): string {
  const blocks: string[] = [];
  const codes: string[] = [];

  let text = src.replace(/```([\w+-]*)\r?\n?([\s\S]*?)```/g, (_all, lang: string, code: string) => {
    blocks.push(`<pre data-lang="${esc(lang || 'code')}"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `@@B${blocks.length - 1}@@`;
  });

  text = esc(text);
  text = text.replace(/`([^`\n]+)`/g, (_all, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `@@C${codes.length - 1}@@`;
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
    .replace(/@@C(\d+)@@/g, (_all, i: string) => codes[Number(i)] ?? '')
    .replace(/@@B(\d+)@@/g, (_all, i: string) => blocks[Number(i)] ?? '');
}
