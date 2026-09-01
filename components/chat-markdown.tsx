"use client";

type ChatMarkdownProps = {
  value: string;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyInlineMarkdown(value: string) {
  return value
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(
      /(^|[\s(])(@"[^"]+"|@[A-Za-z0-9_]+)/g,
      '$1<span class="chat-mention">$2</span>'
    )
    .replace(
      /(^|[\s(])(https?:\/\/[^\s<]+)/g,
      '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>'
    );
}

function renderMarkdown(value: string) {
  const escaped = escapeHtml(value).replace(/\r\n/g, "\n");
  const codeBlocks: string[] = [];

  const withCodePlaceholders = escaped.replace(/```([\s\S]*?)```/g, (_, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return placeholder;
  });

  const blocks = withCodePlaceholders.split("\n");
  let inList = false;

  const rendered = blocks
    .map((line) => {
      if (!line.trim()) {
        if (inList) {
          inList = false;
          return "</ul>";
        }
        return "";
      }

      if (line.startsWith("> ")) {
        if (inList) {
          inList = false;
          return `</ul><blockquote>${applyInlineMarkdown(line.slice(2))}</blockquote>`;
        }
        return `<blockquote>${applyInlineMarkdown(line.slice(2))}</blockquote>`;
      }

      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        if (inList) {
          inList = false;
          return `</ul><h${heading[1].length}>${applyInlineMarkdown(heading[2])}</h${heading[1].length}>`;
        }
        return `<h${heading[1].length}>${applyInlineMarkdown(heading[2])}</h${heading[1].length}>`;
      }

      const listItem = line.match(/^[-*]\s+(.+)$/);
      if (listItem) {
        const item = `<li>${applyInlineMarkdown(listItem[1])}</li>`;
        if (!inList) {
          inList = true;
          return `<ul>${item}`;
        }
        return item;
      }

      if (inList) {
        inList = false;
        return `</ul><p>${applyInlineMarkdown(line)}</p>`;
      }

      return `<p>${applyInlineMarkdown(line)}</p>`;
    })
    .join("");

  const closedLists = inList ? `${rendered}</ul>` : rendered;

  return codeBlocks.reduce(
    (output, code, index) => output.replace(`__CODE_BLOCK_${index}__`, code),
    closedLists
  );
}

export function extractMessageUrls(value: string) {
  return Array.from(new Set(value.match(/https?:\/\/[^\s)]+/g) ?? [])).slice(0, 2);
}

export function ChatMarkdown({ value }: ChatMarkdownProps) {
  return (
    <div
      className="chat-markdown"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
    />
  );
}
