import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OCR_CHARSET, OCR_MODEL_CATALOG, OCR_TIER_CATALOG, isOcrTier } from '@/engine/ocr/catalog';
import { ORT_ASSETS, ORT_VERSION } from '@/engine/ocr/runtime-assets';
import packageJson from '../package.json';

const EXPECTED = {
  tiny_det: [1_780_590, '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8'],
  small_det: [9_880_512, 'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e'],
  medium_det: [62_032_837, 'eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1'],
  small_rec: [21_159_378, '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634'],
  medium_rec: [76_554_979, '9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba'],
} as const;

describe('PP-OCRv6 catalog', () => {
  it('pins every official weight URL, byte size and digest', () => {
    expect(Object.keys(OCR_MODEL_CATALOG).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(OCR_MODEL_CATALOG).not.toHaveProperty('tiny_rec');
    for (const [id, [size, sha256]] of Object.entries(EXPECTED)) {
      const entry = OCR_MODEL_CATALOG[id as keyof typeof OCR_MODEL_CATALOG];
      expect(entry.size).toBe(size);
      expect(entry.sha256).toBe(sha256);
      expect(entry.url).toBe(
        `https://huggingface.co/PaddlePaddle/PP-OCRv6_${id}_onnx/resolve/${entry.commit}/inference.onnx`,
      );
      expect(entry.commit).toMatch(/^[0-9a-f]{40}$/u);
    }
  });

  it('forms standard and high tiers from complete det/rec bundles', () => {
    expect(OCR_TIER_CATALOG.standard.det.id).toBe('tiny_det');
    expect(OCR_TIER_CATALOG.standard.rec.id).toBe('small_rec');
    expect(OCR_TIER_CATALOG.standard.size).toBe(22_939_968);
    expect(OCR_TIER_CATALOG.high.det.id).toBe('medium_det');
    expect(OCR_TIER_CATALOG.high.rec.id).toBe('medium_rec');
    expect(OCR_TIER_CATALOG.high.size).toBe(138_587_816);
    for (const tier of Object.values(OCR_TIER_CATALOG)) {
      expect(tier.files.map((file) => file.path)).toHaveLength(2);
      expect(tier.files.reduce((sum, file) => sum + file.size, 0)).toBe(tier.size);
    }
    expect(isOcrTier('standard')).toBe(true);
    expect(isOcrTier('tiny_rec')).toBe(false);
  });

  it('packages the exact release dictionary with kana and appended-space capacity', () => {
    const bytes = readFileSync(new URL(`../public/${OCR_CHARSET.path}`, import.meta.url));
    expect(bytes.length).toBe(OCR_CHARSET.size);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(OCR_CHARSET.sha256);
    const characters = bytes.toString('utf8').slice(0, -1).split('\n');
    expect(characters).toHaveLength(OCR_CHARSET.entries);
    expect(characters).toEqual(expect.arrayContaining(['あ', 'ア', 'ん', 'ン']));
    expect(OCR_CHARSET.classes).toBe(OCR_CHARSET.entries + 2);
  });
});

describe('packaged ONNX Runtime pins', () => {
  it('uses the pinned package and checks every local artifact hash', () => {
    expect(packageJson.dependencies['onnxruntime-web']).toBe(ORT_VERSION);
    for (const [name, pin] of Object.entries(ORT_ASSETS)) {
      const bytes = readFileSync(
        new URL(`../node_modules/onnxruntime-web/dist/${name}`, import.meta.url),
      );
      expect(bytes.length).toBe(pin.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.sha256);
    }
  });
});
