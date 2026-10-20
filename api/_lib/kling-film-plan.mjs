// Plan new films before pricing/payment. Never rewrite an already-paid manifest.
// The reviewed screenplay remains intact; these are consecutive production cuts.
export function planKlingShots(manifest) {
  const shots = [];
  for (const scene of manifest.shots) {
    if (scene.targetDurationMs < 3000) throw new Error("Each scene needs at least three seconds. Increase the film length or combine short scenes.");
    const count = Math.ceil(scene.targetDurationMs / 15000);
    if (count === 1) { shots.push({ ...scene }); continue; }
    let speaker = "";
    const blocks = [
      { kind: "narration", prefix: "", words: scene.narration.trim().split(/\s+/).filter(Boolean) },
      ...scene.dialogue.split(/\r?\n/).filter(line => line.trim()).map(line => {
        const match = line.match(/^([^:\n]{1,100}:)\s*(.*)$/);
        if (match) speaker = match[1];
        return { kind: "dialogue", prefix: speaker, words: (match?.[2] ?? line).trim().split(/\s+/).filter(Boolean) };
      }),
    ];
    const totalWords = blocks.reduce((sum, block) => sum + block.words.length, 0);
    let wordPosition = 0, elapsed = 0;
    for (let part = 0; part < count; part++) {
      const end = Math.round(scene.targetDurationMs * (part + 1) / count);
      const wordEnd = Math.round(totalWords * (part + 1) / count);
      let offset = 0;
      const narration = [], dialogue = [];
      for (const block of blocks) {
        const from = Math.max(0, wordPosition - offset), to = Math.min(block.words.length, wordEnd - offset);
        if (to > from) {
          const words = block.words.slice(from, to).join(" ");
          (block.kind === "narration" ? narration : dialogue).push(block.prefix ? `${block.prefix} ${words}` : words);
        }
        offset += block.words.length;
      }
      shots.push({ ...scene, startMs: scene.startMs + elapsed, targetDurationMs: end - elapsed,
        narration: narration.join(" "), dialogue: dialogue.join("\n"), scenePart: part + 1, sceneParts: count });
      elapsed = end; wordPosition = wordEnd;
    }
  }
  // A 600-second film can contain at most 200 three-second cuts.
  if (shots.length > 200) throw new Error("This film has too many production cuts.");
  return { ...manifest, productionPlan: { provider: "kling", version: 1 },
    shots: shots.map((shot, index) => ({ ...shot, id: `shot-${String(index + 1).padStart(3, "0")}`,
      continuity: { ...shot.continuity, precedingShotId: index ? `shot-${String(index).padStart(3, "0")}` : null } })) };
}
