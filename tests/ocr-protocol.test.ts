import { describe, expect, it } from 'vitest';
import { decodeOcrImage, encodeOcrImage } from '@/engine/ocr/codec';
import { isEngineHostMessage, isEngineHostRequest } from '@/engine/offscreen/protocol';

const image = { width: 2, height: 1, data: new Uint8ClampedArray([0, 1, 2, 255, 10, 20, 30, 255]) };

describe('OCR offscreen protocol', () => {
  it('round-trips RGBA data and validates recognize/cancel/status messages', () => {
    const payload = encodeOcrImage(image);
    expect(decodeOcrImage(payload)).toEqual(image);
    expect(
      isEngineHostRequest({
        type: 'ocr-recognize',
        requestId: 'o1',
        tier: 'standard',
        image: payload,
      }),
    ).toBe(true);
    expect(isEngineHostRequest({ type: 'ocr-cancel', requestId: 'o1' })).toBe(true);
    expect(isEngineHostRequest({ type: 'ocr-status', requestId: 's1', tier: 'high' })).toBe(true);
    expect(isEngineHostRequest({ type: 'ocr-download', requestId: 'd1', tier: 'standard' })).toBe(
      true,
    );
    expect(isEngineHostRequest({ type: 'ocr-delete', requestId: 'd1', tier: 'high' })).toBe(true);
    expect(isEngineHostRequest({ type: 'cancel', requestId: 'translation' })).toBe(true);
  });

  it('rejects malformed tiers, dimensions and byte payloads', () => {
    const payload = encodeOcrImage(image);
    expect(
      isEngineHostRequest({
        type: 'ocr-recognize',
        requestId: 'o1',
        tier: 'tiny_rec',
        image: payload,
      }),
    ).toBe(false);
    expect(
      isEngineHostRequest({
        type: 'ocr-recognize',
        requestId: 'o1',
        tier: 'standard',
        image: { ...payload, width: 0 },
      }),
    ).toBe(false);
    expect(
      isEngineHostRequest({
        type: 'ocr-recognize',
        requestId: 'o1',
        tier: 'standard',
        image: { ...payload, data: payload.data.slice(0, -4) },
      }),
    ).toBe(false);
  });

  it('validates OCR progress without changing existing response envelopes', () => {
    expect(
      isEngineHostMessage({
        type: 'ocr-progress',
        requestId: 'ocr:standard',
        status: { id: 'standard', state: 'partial', received: 4, total: 20, progress: 0.2 },
      }),
    ).toBe(true);
    expect(
      isEngineHostMessage({ type: 'response', requestId: 'o1', ok: true, value: { lines: [] } }),
    ).toBe(true);
  });
});
