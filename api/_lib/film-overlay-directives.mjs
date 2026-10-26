// Pure parsing of the application's explicit text-overlay directions. Keep the
// original visual intact; ranges are only used when building new video prompts.
export function savedOverlayDirectives(visual) {
  if (typeof visual !== 'string' || visual.length > 20_000) return [];
  const labels = /\b(opening title|small location title|location title|on-screen text|title card|end card|caption|title|overlay identifies examples from (?:his|her|their) career)(?:\s*:\s*|\s+(?=["“]))/gi;
  const result = [];
  let quotedUntil = 0;
  for (const match of visual.matchAll(labels)) {
    if (match.index < quotedUntil) continue;
    const valueStart = match.index + match[0].length, rest = visual.slice(valueStart);
    let text, rangeEnd;
    if (rest[0] === '"' || rest[0] === '“') {
      const end = rest.indexOf(rest[0] === '"' ? '"' : '”', 1);
      quotedUntil = end < 0 ? visual.length : valueStart + end + 1;
      if (end < 2 || end > 161) continue;
      text = rest.slice(1, end); rangeEnd = quotedUntil;
    } else {
      // Unquoted directions require a colon and one bounded sentence. Keep
      // written punctuation; never infer text from surrounding visual prose.
      if (!match[0].includes(':')) continue;
      const nextLabel = new RegExp(labels.source, 'i').exec(rest), newline = rest.search(/[\r\n]/);
      const bounded = rest.slice(0, Math.min(nextLabel?.index ?? rest.length, newline < 0 ? rest.length : newline));
      let end = bounded.length;
      for (const stop of bounded.matchAll(/[.!?](?=\s|$)/g)) {
        if (stop[0] === '.' && /\b(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Rev|Mt|[A-Z])\.$/.test(bounded.slice(0, stop.index + 1))) continue;
        end = stop.index + 1; break;
      }
      text = bounded.slice(0, end).trim(); rangeEnd = valueStart + end;
    }
    if (!text || text.length > 160 || /[\r\n]/.test(text) || text.startsWith('Based on a true story.')) continue;
    const label = match[1].toLowerCase();
    result.push({ text, style: label === 'opening title' ? 'Opening' : label === 'end card' ? 'EndCard'
      : ['title', 'title card'].includes(label) ? 'Title' : 'Location', start: match.index, end: rangeEnd });
  }
  return result;
}

// This projection retains the assembler's original text/style contract and
// parsing behavior, including legacy paid films and title punctuation.
export const savedOverlays = visual => savedOverlayDirectives(visual).map(({ text, style }) => ({ text, style }));

export function stripFilmOverlayDirectives(visual) {
  if (typeof visual !== 'string') return visual;
  let cursor = 0, output = '', removedEnd;
  for (const directive of savedOverlayDirectives(visual)) {
    let start = directive.start;
    // The old parser recognizes the Caption suffix in this supported label.
    // Consume its complete application directive, never leave a dangling label.
    const prefix = visual.slice(0, start), smallCaption = /small location\s+$/i.exec(prefix);
    if (smallCaption && /^caption/i.test(visual.slice(start))) start = smallCaption.index;
    const before = visual.slice(0, start);
    // A title described within narrative prose (for example a book's title)
    // is not an application directive. Never remove historical document prose.
    const standalone = !before.trim() || /[.!?;]\s*$/.test(before) || /[\r\n]\s*$/.test(before)
      || removedEnd !== undefined && /^[\s.;]*$/.test(visual.slice(removedEnd, start));
    if (!standalone) continue;
    output += visual.slice(cursor, start); cursor = directive.end; removedEnd = directive.end;
  }
  return output + visual.slice(cursor);
}
