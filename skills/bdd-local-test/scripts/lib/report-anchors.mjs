// Report evidence uses Markdown heading fragments or explicit HTML anchors.
function headingSlug(title) {
  const visible = title.replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/<\/?[A-Za-z][^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos);/g, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(?<![\p{L}\p{N}])_([^_]+)_(?![\p{L}\p{N}])/gu, '$1');
  return visible.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replaceAll(' ', '-');
}

export function markdownAnchors(markdown) {
  const anchors = new Set();
  const headings = new Set();
  const nextSuffix = new Map();
  let fence, inComment = false, previous = '';
  for (let line of markdown.replace(/^\uFEFF/, '').split(/\r\n?|\n/)) {
    line = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
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
    if (/^(?: {4}|\t)/.test(line)) { previous = ''; continue; }

    const html = line.replace(/(`+)(.*?)\1/g, '');
    for (const tag of html.matchAll(/<([A-Za-z][\w:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
      for (const attr of tag[0].matchAll(/\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        const key = attr[1].toLowerCase();
        if (key === 'id' || (key === 'name' && tag[1].toLowerCase() === 'a')) anchors.add(attr[2] ?? attr[3] ?? attr[4]);
      }
    }
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?)|$)[ \t]*$/.exec(line);
    let title;
    if (atx) title = (atx[1] ?? '').replace(/(?:^|\s)#+\s*$/, '');
    else if (previous && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) title = previous;
    if (title === undefined) {
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
  }
  return anchors;
}
