// The assembler and pre-assembly reviewer share this bounded interpretation
// of saved graphics. Unrecognized prose remains scene direction. Offsets are
// UTF-16 string.slice indexes, with an exclusive end; text is never inferred.
export function parsedAssemblyOverlays(visual) {
  if (typeof visual !== 'string' || visual.length > 20_000) return [];
  const labels = /\b(opening title|title over action|small location title|location title|on-screen text|title card|end card|smaller caption|caption|title|overlay identifies examples from (?:his|her|their) career)(?:\s*:\s*|\s+(?=["“]))/gi;
  const result = [];
  let quotedUntil = 0;
  for (const match of visual.matchAll(labels)) {
    if (match.index < quotedUntil) continue;
    const contentStart = match.index + match[0].length, rest = visual.slice(contentStart);
    let text, spanEnd;
    if (rest[0] === '"' || rest[0] === '“') {
      const end = rest.indexOf(rest[0] === '"' ? '"' : '”', 1);
      quotedUntil = end < 0 ? visual.length : contentStart + end + 1;
      if (end < 2 || end > 161) continue;
      text = rest.slice(1, end);
      spanEnd = contentStart + end + 1;
    } else {
      // Unquoted directions require a colon and one bounded sentence. Keep
      // written punctuation; never consume later action after that sentence.
      if (!match[0].includes(':')) continue;
      const nextLabel = new RegExp(labels.source, 'i').exec(rest), newline = rest.search(/[\r\n]/);
      const bounded = rest.slice(0, Math.min(nextLabel?.index ?? rest.length, newline < 0 ? rest.length : newline));
      let end = bounded.length;
      for (const stop of bounded.matchAll(/[.!?](?=\s|$)/g)) {
        if (stop[0] === '.' && /\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Rev|Mt|[A-Z])\.$/.test(bounded.slice(0, stop.index + 1))) continue;
        end = stop.index + 1; break;
      }
      const supplied = bounded.slice(0, end).trimEnd();
      text = supplied.trim();
      spanEnd = contentStart + supplied.length;
    }
    if (!text || text.length > 160 || /[\r\n]/.test(text) || text.startsWith('Based on a true story.')) continue;
    const label = match[1].toLowerCase();
    result.push({ text, style: label === 'opening title' ? 'Opening' : label === 'end card' ? 'EndCard'
      : ['title', 'title card', 'title over action'].includes(label) ? 'Title' : 'Location',
    start: match.index, end: spanEnd });
  }
  return result;
}
