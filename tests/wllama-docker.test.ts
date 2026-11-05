import { describe, expect, it } from 'vitest';
import { emsdkImage, emsdkTag } from '../scripts/wllama/docker';

describe('emsdk image selection', () => {
  it('passes a tag, not an image name, to the compose build', () => {
    expect(emsdkTag('x64')).toBe('4.0.20');
    expect(emsdkImage('4.0.20')).toBe('emscripten/emsdk:4.0.20');
  });

  it('uses the arm64 variant of the tag on Apple Silicon', () => {
    expect(emsdkTag('arm64')).toBe('4.0.20-arm64');
    expect(emsdkImage(emsdkTag('arm64'))).toBe('emscripten/emsdk:4.0.20-arm64');
  });
});
