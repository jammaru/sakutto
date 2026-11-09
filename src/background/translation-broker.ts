import { browser, type Browser } from 'wxt/browser';
import {
  errorPayload,
  isTranslationCancelRequest,
  isTranslationStartRequest,
  deserializeTranslateOptions,
  TRANSLATION_PORT,
  type TranslationServerMessage,
} from '@/engine/offscreen/protocol';
import type { EngineClient } from './engine-client';

export class TranslationBroker {
  private readonly tabs = new Map<number, Set<Browser.runtime.Port>>();

  constructor(private readonly client: EngineClient) {}

  start(): void {
    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== TRANSLATION_PORT) return;
      if (port.sender?.id !== browser.runtime.id) return;
      this.attach(port);
    });
  }

  /** Drops in-flight page translations when the tab navigates or closes. */
  cancelTab(tabId: number): void {
    const ports = this.tabs.get(tabId);
    if (!ports) return;
    for (const port of ports) {
      try {
        port.disconnect();
      } catch {
        // The page port is already gone.
      }
    }
    ports.clear();
    this.tabs.delete(tabId);
  }

  private attach(port: Browser.runtime.Port): void {
    const controllers = new Map<string, AbortController>();
    const tabId = port.sender?.tab?.id;
    if (tabId !== undefined) {
      const group = this.tabs.get(tabId) ?? new Set<Browser.runtime.Port>();
      group.add(port);
      this.tabs.set(tabId, group);
    }

    const post = (message: TranslationServerMessage): void => {
      try {
        port.postMessage(message);
      } catch {
        // The caller went away; its requests are aborted by the disconnect handler.
      }
    };

    port.onMessage.addListener((message: unknown) => {
      if (isTranslationCancelRequest(message)) {
        controllers.get(message.requestId)?.abort();
        controllers.delete(message.requestId);
        return;
      }

      if (!isTranslationStartRequest(message)) return;

      const requestId = message.requestId;
      const controller = new AbortController();
      controllers.set(requestId, controller);

      void (async () => {
        try {
          const options = deserializeTranslateOptions(message.options, controller.signal);
          for await (const chunk of this.client.translate(message.segments, options)) {
            post({ type: 'chunk', requestId, chunk });
          }
          if (!controller.signal.aborted) post({ type: 'done', requestId });
        } catch (error) {
          if (!controller.signal.aborted) {
            post({ type: 'error', requestId, error: errorPayload(error) });
          }
        } finally {
          controllers.delete(requestId);
        }
      })();
    });

    port.onDisconnect.addListener(() => {
      if (tabId !== undefined) this.tabs.get(tabId)?.delete(port);
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    });
  }
}
