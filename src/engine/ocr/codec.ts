import { EngineError } from '@/engine/errors';
import type { OcrImagePayload } from '@/engine/offscreen/protocol';

export interface DecodedOcrImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function decodeOcrImage(payload: OcrImagePayload): DecodedOcrImage {
  let binary: string;
  try {
    binary = atob(payload.data);
  } catch (error) {
    throw new EngineError('invalid-input', 'The OCR image is not valid base64.', {
      cause: error,
      retryable: false,
    });
  }
  const expected = payload.width * payload.height * 4;
  if (binary.length !== expected) {
    throw new EngineError('invalid-input', 'The OCR image byte length does not match its size.', {
      retryable: false,
    });
  }
  const data = new Uint8ClampedArray(expected);
  for (let index = 0; index < expected; index++) data[index] = binary.charCodeAt(index);
  return { width: payload.width, height: payload.height, data };
}

export function encodeOcrImage(image: DecodedOcrImage): OcrImagePayload {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < image.data.length; offset += chunk) {
    binary += String.fromCharCode(...image.data.subarray(offset, offset + chunk));
  }
  return { width: image.width, height: image.height, data: btoa(binary) };
}
