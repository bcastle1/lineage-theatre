const HASH = /^[a-f0-9]{64}$/;
const need = value => { if (!value) throw Object.assign(Error('The approved text correction changed.'), { code: 'VISUAL_REVIEW_INVALID' }); };

// Only an exact, already-saved short label may cover an approved region of one
// completed clip. The immutable recovery grant supplies the owner approval.
export function validateFilmTextCorrections(job, corrections) {
  if (corrections === undefined) return [];
  need(Array.isArray(corrections) && corrections.length === 1);
  for (const value of corrections) {
    need(value && Object.keys(value).sort().join(',') === 'background,endMs,fontColor,fontSize,height,shotId,sourceSha256,startMs,text,version,width,x,y'
      && value.version === 1 && HASH.test(value.sourceSha256 || ''));
    const index = job?.manifest?.shots?.findIndex(shot => shot.id === value.shotId);
    const shot = job?.manifest?.shots?.[index], stored = job?.shots?.[index];
    need(shot && stored?.id === shot.id && stored.status === 'completed' && stored.output?.sha256 === value.sourceSha256
      && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 120
      && value.text === value.text.trim() && !/[{}\\\r\n\x00-\x1f\x7f]/.test(value.text)
      && shot.visual.includes(value.text)
      && ['startMs', 'endMs', 'x', 'y', 'width', 'height', 'fontSize'].every(key => Number.isSafeInteger(value[key]))
      && value.startMs >= 0 && value.endMs > value.startMs && value.endMs <= shot.targetDurationMs
      && value.endMs - value.startMs <= 4000 && value.x >= 0 && value.y >= 0
      && value.width >= 100 && value.height >= 40 && value.height <= 216
      && value.x + value.width <= 1920 && value.y + value.height <= 1080
      && value.fontSize >= 16 && value.fontSize <= 100 && value.fontSize < value.height
      && typeof value.background === 'string' && typeof value.fontColor === 'string'
      && /^[A-Fa-f0-9]{6}$/.test(value.background) && /^[A-Fa-f0-9]{6}$/.test(value.fontColor));
  }
  return corrections;
}
