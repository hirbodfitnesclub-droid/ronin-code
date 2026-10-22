import React from 'react';

/* Minimal, safe markdown for assistant messages: **bold**, *italic*,
   `code`, and "- " bullet lists. Built purely from React nodes — raw
   HTML from the model is never injected into the DOM. */

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g);
  return parts.map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 1) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

export default function RichText({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split('\n');
  let list: string[] = [];
  const flushList = (key: string) => {
    if (!list.length) return;
    const items = list;
    list = [];
    blocks.push(
      <ul key={key}>
        {items.map((item, i) => (
          <li key={i}>{renderInline(item, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      list.push(bullet[1]);
      return;
    }
    flushList(`ul-${idx}`);
    if (!line.trim()) return;
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    blocks.push(
      <p key={`p-${idx}`}>
        {renderInline(heading ? heading[1] : line, `p-${idx}`)}
      </p>,
    );
  });
  flushList('ul-end');
  return <>{blocks}</>;
}
