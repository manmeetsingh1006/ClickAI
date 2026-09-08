import { desktopCapturer, screen, Display } from "electron";

export interface Screenshot {
  dataUrl: string;
  imageWidth: number;
  imageHeight: number;
  /** Multiply an x/y pixel coordinate in this image by these, then add
   *  originX/originY, to get absolute logical screen points (what
   *  mouse/keyboard automation expects — important on multi-monitor setups
   *  where a display doesn't start at (0,0)). */
  pointsPerPixelX: number;
  pointsPerPixelY: number;
  originX: number;
  originY: number;
}

const DEFAULT_MAX_DIMENSION = 1280;

/**
 * Captures a display (defaults to the primary one) and returns it as a
 * base64 PNG data URL, downscaled so the image doesn't burn an excessive
 * number of OpenAI vision tokens.
 *
 * On macOS this requires Screen Recording permission
 * (System Settings > Privacy & Security > Screen Recording) or the
 * captured frame will be blank/black.
 */
export async function captureScreen(
  maxDimension: number = DEFAULT_MAX_DIMENSION,
  targetDisplay: Display = screen.getPrimaryDisplay()
): Promise<Screenshot> {
  const { width: logicalWidth, height: logicalHeight, x: originX, y: originY } = targetDisplay.bounds;
  const scaleFactor = targetDisplay.scaleFactor || 1;
  const nativeWidth = Math.round(logicalWidth * scaleFactor);
  const nativeHeight = Math.round(logicalHeight * scaleFactor);

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: nativeWidth, height: nativeHeight },
  });

  const matchedSource =
    sources.find((s) => s.display_id === String(targetDisplay.id)) ||
    sources[0];

  if (!matchedSource) {
    throw new Error("No screen source available to capture.");
  }

  let image = matchedSource.thumbnail;
  let imageWidth = nativeWidth;
  let imageHeight = nativeHeight;

  const longestSide = Math.max(nativeWidth, nativeHeight);
  if (longestSide > maxDimension) {
    const scale = maxDimension / longestSide;
    imageWidth = Math.round(nativeWidth * scale);
    imageHeight = Math.round(nativeHeight * scale);
    image = image.resize({ width: imageWidth, height: imageHeight, quality: "good" });
  }

  return {
    dataUrl: image.toDataURL(),
    imageWidth,
    imageHeight,
    pointsPerPixelX: logicalWidth / imageWidth,
    pointsPerPixelY: logicalHeight / imageHeight,
    originX,
    originY,
  };
}

export interface CursorRegion {
  dataUrl: string;
  regionWidth: number;
  regionHeight: number;
}

/**
 * Captures a small native-resolution crop of the screen centered on the
 * given cursor point (in absolute logical screen coordinates). Used for
 * Point Mode: asking a vision model "what's at pixel (x,y) in this big
 * screenshot" is unreliable — models are much better at "what's in the
 * center of this small image", so we do the pointing ourselves via
 * cropping instead of asking the model to locate a coordinate.
 */
export async function captureCursorRegion(
  cursor: { x: number; y: number },
  halfSize = 180
): Promise<CursorRegion> {
  const targetDisplay = screen.getDisplayNearestPoint(cursor);
  const scaleFactor = targetDisplay.scaleFactor || 1;
  const nativeWidth = Math.round(targetDisplay.bounds.width * scaleFactor);
  const nativeHeight = Math.round(targetDisplay.bounds.height * scaleFactor);

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: nativeWidth, height: nativeHeight },
  });

  const matchedSource =
    sources.find((s) => s.display_id === String(targetDisplay.id)) ||
    sources[0];

  if (!matchedSource) {
    throw new Error("No screen source available to capture.");
  }

  const nativeCursorX = Math.round((cursor.x - targetDisplay.bounds.x) * scaleFactor);
  const nativeCursorY = Math.round((cursor.y - targetDisplay.bounds.y) * scaleFactor);
  const nativeHalf = Math.round(halfSize * scaleFactor);
  const cropWidth = Math.min(nativeHalf * 2, nativeWidth);
  const cropHeight = Math.min(nativeHalf * 2, nativeHeight);
  const cropX = Math.max(0, Math.min(nativeWidth - cropWidth, nativeCursorX - nativeHalf));
  const cropY = Math.max(0, Math.min(nativeHeight - cropHeight, nativeCursorY - nativeHalf));

  const cropped = matchedSource.thumbnail.crop({ x: cropX, y: cropY, width: cropWidth, height: cropHeight });

  return {
    dataUrl: cropped.toDataURL(),
    regionWidth: cropWidth,
    regionHeight: cropHeight,
  };
}
