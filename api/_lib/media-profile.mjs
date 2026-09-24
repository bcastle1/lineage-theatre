// Encoding limits shared by assembly and publication. These are app limits,
// not a statement of provider capability or account entitlement.
export function verifiedMediaProfile(value) {
  const { width, height, frameRate } = value || {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 2 || height < 2 || width % 2 || height % 2
    || width > 4096 || height > 4096 || width * height > 4096 * 2160
    || !Number.isFinite(frameRate) || frameRate < 1 || frameRate > 60) {
    throw new Error("The film's dimensions and frame rate need verification.");
  }
  return { width, height, frameRate };
}
