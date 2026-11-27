import path from 'node:path';

// Report evidence uses Markdown heading fragments or explicit HTML anchors.
function headingSlug(title) {
  const visible = title.replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos);/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(?<![\p{L}\p{N}])_([^_]+)_(?![\p{L}\p{N}])/gu, '$1');
  return visible.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replaceAll(' ', '-');
}

// Collect line details only when an archive needs to check section contents.
function scanReport(markdown, rows) {
  const anchors = new Set();
  const headings = new Set();
  const nextSuffix = new Map();
  let fence, inComment = false, previous = '';
  for (let line of markdown.replace(/^\uFEFF/, '').split(/\r\n?|\n/)) {
    line = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      else if (rows && line.trim()) rows.push({ code: true, line });
      continue;
    }
    if (!inComment && marker) { fence = marker[1]; previous = ''; continue; }
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, '');
    const start = line.indexOf('<!--');
    if (start !== -1) { inComment = true; line = line.slice(0, start); }
    if (/^(?: {4}|\t)/.test(line)) {
      if (rows && line.trim()) rows.push({ code: true, line });
      previous = '';
      continue;
    }

    const html = line.replace(/(`+)(.*?)\1/g, '');
    const row = rows && { line, markup: html, ids: [] };
    for (const tag of html.matchAll(/<([A-Za-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
      for (const attr of tag[0].matchAll(/\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        const key = attr[1].toLowerCase();
        if (key === 'id' || (key === 'name' && tag[1].toLowerCase() === 'a')) {
          const id = attr[2] ?? attr[3] ?? attr[4];
          anchors.add(id);
          row?.ids.push(id);
        }
      }
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|$)[ \t]*$/.exec(line);
    let title;
    if (atx) title = (atx[2] ?? '').replace(/(?:^|\s)#+\s*$/, '');
    else if (previous && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) title = previous;
    if (title === undefined) {
      if (rows) rows.push(row);
      previous = /^\s*(?:[-+*]\s|\d+[.)]\s|\||<)/.test(line) ? '' : line.trim();
      continue;
    }
    previous = '';
    const base = headingSlug(title);
    let slug = base;
    let suffix = nextSuffix.get(base) ?? 0;
    while (headings.has(slug)) slug = base + '-' + ++suffix;
    nextSuffix.set(base, suffix);
    headings.add(slug);
    anchors.add(slug);
    if (rows) {
      if (atx) rows.push(row);
      const titleRow = rows.at(-1);
      titleRow.heading = { slug, level: atx ? atx[1].length : line.trim()[0] === '=' ? 1 : 2 };
    }
  }
  return anchors;
}

export function markdownAnchors(markdown) {
  return scanReport(markdown);
}

function attachmentCollector() {
  const attachments = new Set();
  const definitions = new Map(), references = new Map();
  const labelKey = label => label.trim().replace(/\s+/g, ' ').toLowerCase();
  const destination = /\(\s*(?:<([^>]+)>|((?:\\[()]|[^\s()]|\([^()]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/y;
  const reference = /\[((?:\\.|[^\]\\])*)\]/y;
  function add(destination, image) {
    if (image && /^data:image\//i.test(destination)) {
      throw new Error('報告內嵌圖片須另存為 evidence/ 附件，供封存核對遮罩');
    }
    const local = /^(?:file:|[a-z]:[\\/])/i.test(destination);
    if (!local && /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(destination)) return;
    let name = destination.split(/[?#]/, 1)[0];
    try { name = decodeURIComponent(name); } catch { /* Preserve literal file names. */ }
    name = name.replaceAll('\\', '/');
    const evidenceFile = /\.(?:png|jpe?g|gif|bmp|webp|svg|avif|pdf|zip|har|log|txt|csv|tsv|json|xml|xlsx?|mp4|webm)$/i.test(name);
    if (name && (image || evidenceFile || /^(?:\.\/)*evidence\//i.test(name))) attachments.add(path.posix.normalize(name));
  }
  function scan(markup) {
    const def = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/.exec(markup);
    if (def) {
      const key = labelKey(def[1]);
      if (!definitions.has(key)) definitions.set(key, def[2] ?? def[3]);
      return false;
    }
    // Link text can itself contain bracketed button names or an image.
    const openings = [];
    for (let i = 0; i < markup.length; i++) {
      if (markup[i] === '\\') { i++; continue; }
      if (markup[i] === '[') { openings.push(i); continue; }
      if (markup[i] !== ']' || !openings.length) continue;
      const start = openings.pop();
      const image = markup[start - 1] === '!';
      destination.lastIndex = reference.lastIndex = i + 1;
      const direct = destination.exec(markup);
      if (direct) {
        add((direct[1] ?? direct[2]).replace(/\\([()])/g, '$1'), image);
        i = destination.lastIndex - 1;
      } else {
        const ref = reference.exec(markup);
        const key = labelKey(ref?.[1] || markup.slice(start + 1, i));
        references.set(key, references.get(key) || image);
        if (ref) i = reference.lastIndex - 1;
      }
    }
    for (const m of markup.matchAll(/<(a|img)\b[^>]*?\s(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const image = m[1].toLowerCase() === 'img';
      if (m[2].toLowerCase() === (image ? 'src' : 'href')) add(m[3] ?? m[4] ?? m[5], image);
    }
    return true;
  }
  function finish() {
    for (const [key, image] of references) if (definitions.has(key)) add(definitions.get(key), image);
    return attachments;
  }
  return { scan, finish };
}

export function reportEvidence(markdown) {
  const rows = [];
  scanReport(markdown, rows);
  const populated = new Set(), sections = [], attachments = attachmentCollector();
  let pending = [];
  for (const row of rows) {
    if (!row.code && !attachments.scan(row.markup)) continue;
    if (row.ids?.length) pending.push(...row.ids);
    if (row.heading) {
      const { level, slug } = row.heading;
      while (sections.length && sections.at(-1).level >= level) sections.pop();
      sections.push({ level, ids: [slug, ...pending] });
      pending = [];
      continue;
    }
    const visible = row.code ? row.line : row.line.replace(/<\/?[A-Za-z][^>]*>|<填寫[^>]*>/g, '').trim();
    if (!visible || (!row.code && /^[\s|:_*#=>~-]+$/.test(visible))) continue;
    for (const { ids } of sections) for (const id of ids) populated.add(id);
    for (const id of pending) populated.add(id);
    pending = [];
  }
  return { populated, attachments: attachments.finish() };
}
