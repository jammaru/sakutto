import { isRecord } from './object';

export interface ImageTranslateRequest {
  type: 'image:translate';
  srcUrl: string;
}

export interface ImageCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageCaptureRequest {
  type: 'image:capture';
  rect: ImageCaptureRect | null;
}

export function isImageTranslateRequest(value: unknown): value is ImageTranslateRequest {
  return (
    isRecord(value) &&
    value.type === 'image:translate' &&
    typeof value.srcUrl === 'string' &&
    value.srcUrl.length > 0
  );
}

export function isImageCaptureRequest(value: unknown): value is ImageCaptureRequest {
  if (!isRecord(value) || value.type !== 'image:capture') return false;
  if (value.rect === null) return true;
  return (
    isRecord(value.rect) &&
    typeof value.rect.x === 'number' &&
    Number.isFinite(value.rect.x) &&
    typeof value.rect.y === 'number' &&
    Number.isFinite(value.rect.y) &&
    typeof value.rect.width === 'number' &&
    Number.isFinite(value.rect.width) &&
    value.rect.width > 0 &&
    typeof value.rect.height === 'number' &&
    Number.isFinite(value.rect.height) &&
    value.rect.height > 0
  );
}
