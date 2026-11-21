import type { OcrTier } from '@/engine/ocr/catalog';

interface OcrRecognition {
  tier: OcrTier;
  controller: AbortController;
}

/** Recognition ownership is per caller request, never global to a model tier. */
export class OcrRecognitionRequests {
  private readonly requests = new Map<string, OcrRecognition>();

  start(requestId: string, tier: OcrTier): AbortController | null {
    if (this.requests.has(requestId)) return null;
    const controller = new AbortController();
    this.requests.set(requestId, { tier, controller });
    return controller;
  }

  cancel(tier: OcrTier, requestId: string): void {
    const request = this.requests.get(requestId);
    if (!request || request.tier !== tier) return;
    request.controller.abort();
    this.requests.delete(requestId);
  }

  cancelTier(tier: OcrTier): void {
    for (const [requestId, request] of this.requests) {
      if (request.tier !== tier) continue;
      request.controller.abort();
      this.requests.delete(requestId);
    }
  }

  finish(requestId: string, controller: AbortController): void {
    if (this.requests.get(requestId)?.controller === controller) {
      this.requests.delete(requestId);
    }
  }
}
