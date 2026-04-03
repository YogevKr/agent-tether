const TELEGRAM_LIMIT = 4096;
const TELEGRAM_MARKDOWN_RAW_LIMIT = 3500;

export function renderTelegramMarkdownChunks({
  markdown,
  prefixText = "",
  limit = TELEGRAM_LIMIT,
  rawLimit = TELEGRAM_MARKDOWN_RAW_LIMIT,
} = {}) {
  const blocks = [];
  const normalizedPrefix = normalizeLineEndings(prefixText).trim();
  const normalizedMarkdown = normalizeLineEndings(String(markdown || "")).trim();

  if (normalizedPrefix) {
    blocks.push(...splitOversizedBlock({ type: "plain", text: normalizedPrefix }, rawLimit));
  }

  if (normalizedMarkdown) {
    for (const block of splitMarkdownBlocks(normalizedMarkdown)) {
      blocks.push(...splitOversizedBlock(block, rawLimit));
    }
  }

  if (blocks.length === 0) {
    return [""];
  }

  const chunks = [];
  let current = "";

  for (const block of blocks) {
    const rendered = renderTelegramMarkdownBlock(block);

    if (!rendered) {
      continue;
    }

    const candidate = current ? `${current}\n\n${rendered}` : rendered;

    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    current = rendered;
  }

  if (current || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

function splitMarkdownBlocks(markdown) {
  const lines = normalizeLineEndings(markdown).split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line || line.trim() === "") {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(/^```([\w-]+)?\s*$/);

    if (fenceMatch) {
      index += 1;
      const codeLines = [];

      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push({
        type: "code",
        language: fenceMatch[1] || "",
        text: codeLines.join("\n"),
      });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);

    if (headingMatch) {
      blocks.push({
        type: "heading",
        text: headingMatch[2].trim(),
      });
      index += 1;
      continue;
    }

    if (isQuoteLine(line)) {
      const quoteLines = [];

      while (index < lines.length && isQuoteLine(lines[index])) {
        quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }

      blocks.push({
        type: "quote",
        lines: quoteLines,
      });
      continue;
    }

    if (isListLine(line)) {
      const listLines = [];

      while (
        index < lines.length &&
        lines[index].trim() !== "" &&
        (isListLine(lines[index]) || isIndentedContinuationLine(lines[index]))
      ) {
        listLines.push(lines[index]);
        index += 1;
      }

      blocks.push({
        type: "list",
        lines: listLines,
      });
      continue;
    }

    const paragraphLines = [];

    while (
      index < lines.length &&
      lines[index].trim() !== "" &&
      !/^```/.test(lines[index]) &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !isQuoteLine(lines[index]) &&
      !isListLine(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    blocks.push({
      type: "paragraph",
      lines: paragraphLines,
    });
  }

  return blocks;
}

function splitOversizedBlock(block, rawLimit) {
  if (estimateBlockLength(block) <= rawLimit) {
    return [block];
  }

  if (block.type === "code") {
    return splitCodeBlock(block, rawLimit - 32);
  }

  if (block.type === "heading") {
    return splitTextSegments(block.text, rawLimit).map((text, index) =>
      index === 0
        ? { type: "heading", text }
        : { type: "paragraph", lines: [text] });
  }

  if (block.type === "plain") {
    return splitTextBlock(block.type, block.text.split("\n"), rawLimit);
  }

  return splitTextBlock(block.type, block.lines || [], rawLimit);
}

function splitCodeBlock(block, rawLimit) {
  const lines = block.text.split("\n");
  const groups = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    const segments = splitFixedWidth(line, rawLimit);

    for (const segment of segments) {
      const addition = current.length === 0 ? segment.length : segment.length + 1;

      if (current.length > 0 && currentLength + addition > rawLimit) {
        groups.push({
          type: "code",
          language: block.language,
          text: current.join("\n"),
        });
        current = [];
        currentLength = 0;
      }

      current.push(segment);
      currentLength += current.length === 1 ? segment.length : segment.length + 1;
    }
  }

  if (groups.length === 0 && current.length === 0) {
    return [block];
  }

  if (current.length > 0) {
    groups.push({
      type: "code",
      language: block.language,
      text: current.join("\n"),
    });
  }

  return groups;
}

function splitTextBlock(type, lines, rawLimit) {
  const groups = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    const segments = splitTextLine(line, rawLimit, {
      continuationIndent: type === "list" && isListLine(line) ? "  " : "",
    });

    for (const segment of segments) {
      const addition = current.length === 0 ? segment.length : segment.length + 1;

      if (current.length > 0 && currentLength + addition > rawLimit) {
        groups.push(buildTextBlock(type, current));
        current = [];
        currentLength = 0;
      }

      current.push(segment);
      currentLength += current.length === 1 ? segment.length : segment.length + 1;
    }
  }

  if (current.length > 0) {
    groups.push(buildTextBlock(type, current));
  }

  return groups;
}

function buildTextBlock(type, lines) {
  if (type === "plain") {
    return {
      type,
      text: lines.join("\n"),
    };
  }

  return {
    type,
    lines,
  };
}

function estimateBlockLength(block) {
  if (block.type === "heading") {
    return block.text.length;
  }

  if (block.type === "code" || block.type === "plain") {
    return block.text.length;
  }

  return (block.lines || []).join("\n").length;
}

function renderTelegramMarkdownBlock(block) {
  if (block.type === "plain") {
    return escapeHtml(block.text);
  }

  if (block.type === "heading") {
    return `<b>${renderInline(block.text)}</b>`;
  }

  if (block.type === "code") {
    return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
  }

  if (block.type === "quote") {
    return block.lines
      .map((line) => `&gt; ${renderInline(line)}`)
      .join("\n");
  }

  if (block.type === "list") {
    return block.lines
      .map((line) => renderListLine(line))
      .join("\n");
  }

  return (block.lines || []).map((line) => renderInline(line)).join("\n");
}

function renderListLine(line) {
  const itemMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);

  if (!itemMatch) {
    return renderIndentedText(line);
  }

  const marker = /^\d+\.$/.test(itemMatch[2]) ? itemMatch[2] : "•";
  return `${renderIndent(itemMatch[1])}${marker} ${renderInline(itemMatch[3])}`;
}

function renderIndentedText(line) {
  const match = line.match(/^(\s*)(.*)$/);
  return `${renderIndent(match?.[1] || "")}${renderInline(match?.[2] || "")}`;
}

function renderIndent(spacing) {
  const normalized = String(spacing || "").replace(/\t/g, "  ");
  return normalized ? "&#160;".repeat(normalized.length) : "";
}

function renderInline(text) {
  return String(text)
    .split("\n")
    .map((line) => renderInlineLine(line))
    .join("\n");
}

function renderInlineLine(line) {
  const placeholders = [];
  let rendered = escapeHtml(line);

  rendered = protectPattern(
    rendered,
    /`([^`\n]+)`/g,
    placeholders,
    (_match, code) => `<code>${code}</code>`,
  );
  rendered = protectMarkdownLinks(rendered, placeholders);

  rendered = applyWrappedTag(rendered, /\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*/g, "b", {
    innerTag: "i",
  });
  rendered = applyWrappedTag(rendered, /___(?!\s)(.+?)(?<!\s)___/g, "b", {
    innerTag: "i",
  });
  rendered = applyWrappedTag(rendered, /\*\*(?!\s)(.+?)(?<!\s)\*\*/g, "b");
  rendered = applyWrappedTag(rendered, /__(?!\s)(.+?)(?<!\s)__/g, "b");
  rendered = applyWrappedTag(rendered, /~~(?!\s)(.+?)(?<!\s)~~/g, "s");
  rendered = applyWrappedTag(rendered, /\|\|(?!\s)(.+?)(?<!\s)\|\|/g, "tg-spoiler");
  rendered = rendered.replace(
    /(^|[^\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g,
    (_match, leading, inner) => `${leading}<i>${inner}</i>`,
  );
  rendered = rendered.replace(
    /(^|[^\w])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g,
    (_match, leading, inner) => `${leading}<i>${inner}</i>`,
  );

  return restorePlaceholders(rendered, placeholders);
}

function protectMarkdownLinks(text, placeholders) {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const labelStart = text.indexOf("[", index);

    if (labelStart === -1) {
      result += text.slice(index);
      break;
    }

    result += text.slice(index, labelStart);

    const labelEnd = findBalancedBracket(text, labelStart, "[", "]");

    if (labelEnd === -1 || text[labelEnd + 1] !== "(") {
      result += text[labelStart];
      index = labelStart + 1;
      continue;
    }

    const urlEnd = findBalancedBracket(text, labelEnd + 1, "(", ")");

    if (urlEnd === -1) {
      result += text[labelStart];
      index = labelStart + 1;
      continue;
    }

    const label = text.slice(labelStart + 1, labelEnd);
    const url = text.slice(labelEnd + 2, urlEnd);
    const token = `\u0000${placeholders.length}\u0000`;

    placeholders.push(`<a href="${escapeHtmlAttribute(url)}">${label}</a>`);
    result += token;
    index = urlEnd + 1;
  }

  return result;
}

function findBalancedBracket(text, startIndex, openChar, closeChar) {
  let depth = 0;

  for (let index = startIndex; index < text.length; index += 1) {
    if (text[index] === openChar) {
      depth += 1;
      continue;
    }

    if (text[index] === closeChar) {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function protectPattern(text, pattern, placeholders, buildReplacement) {
  return text.replace(pattern, (...args) => {
    const replacement = buildReplacement(...args);
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(replacement);
    return token;
  });
}

function applyWrappedTag(text, pattern, tag, options = {}) {
  const innerTag = options.innerTag || "";

  return text.replace(pattern, (_match, inner) =>
    innerTag
      ? `<${tag}><${innerTag}>${inner}</${innerTag}></${tag}>`
      : `<${tag}>${inner}</${tag}>`);
}

function restorePlaceholders(text, placeholders) {
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => placeholders[Number(index)] || "");
}

function splitTextLine(line, rawLimit, options = {}) {
  const continuationIndent = options.continuationIndent || "";

  if (line.length <= rawLimit) {
    return [line];
  }

  const segments = splitTextSegments(line, rawLimit);

  return segments.map((segment, index) =>
    index === 0 || !continuationIndent ? segment : `${continuationIndent}${segment}`);
}

function splitTextSegments(text, rawLimit) {
  if (text.length <= rawLimit) {
    return [text];
  }

  const segments = [];
  let remaining = text;

  while (remaining.length > rawLimit) {
    let splitIndex = remaining.lastIndexOf(" ", rawLimit);

    if (splitIndex < Math.floor(rawLimit * 0.5)) {
      splitIndex = rawLimit;
    }

    segments.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining) {
    segments.push(remaining);
  }

  return segments;
}

function splitFixedWidth(text, rawLimit) {
  if (text.length <= rawLimit) {
    return [text];
  }

  const segments = [];

  for (let index = 0; index < text.length; index += rawLimit) {
    segments.push(text.slice(index, index + rawLimit));
  }

  return segments;
}

function isListLine(line) {
  return /^\s*([-*+]|\d+\.)\s+/.test(line);
}

function isIndentedContinuationLine(line) {
  return /^\s{2,}\S/.test(line);
}

function isQuoteLine(line) {
  return /^\s*>\s?/.test(line);
}

function normalizeLineEndings(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(text) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
