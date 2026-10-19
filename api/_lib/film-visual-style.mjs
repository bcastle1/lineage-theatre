// Cinematic describes camera and lighting, not an animation medium. Keep this
// independent of factuality: documentary and dramatized stories can both be real-looking.
export const REALISTIC_FILM_DIRECTION = 'Photorealistic live-action historical filmmaking, as if photographed with real performers and practical period sets. Natural human proportions, visible skin texture, believable eyes and hands, woven fabric, restrained expressions, physically plausible movement, natural window light and photographic depth of field. No cartoon, illustration, hand-drawn outlines, painterly rendering, 3D animation, plastic skin or stylized faces.';
export function realisticCreativeText(value) {
  return String(value || '').replace(/\b(?:premium\s+)?cinematic animation\b/gi, 'photorealistic historical filmmaking')
    .replace(/\bcinematic animated\b/gi, 'photorealistic cinematic')
    .replace(/\bAnimation maintains\b/g, 'The character maintains');
}
