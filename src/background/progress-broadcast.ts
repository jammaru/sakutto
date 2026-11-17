import type { ModelStatus } from '@/shared/engine-status';
import type { ModelProgressMessage } from '@/shared/messages';

export interface ProgressTab {
  id?: number | undefined;
  url?: string | undefined;
}

export interface ProgressSink {
  sendExtension(message: ModelProgressMessage): Promise<void>;
  listTabs(): Promise<readonly ProgressTab[]>;
  sendTab(tabId: number, message: ModelProgressMessage): Promise<void>;
}

/**
 * Extension UI tabs hear progress through {@link ProgressSink.sendExtension}. Web pages
 * hear terminal states through `tabs.sendMessage`, which avoids `runtime.sendMessage`
 * fan-out to BFCache’d content scripts.
 */
export async function broadcastModelProgress(
  message: ModelProgressMessage,
  sink: ProgressSink,
): Promise<void> {
  try {
    await sink.sendExtension(message);
  } catch {
    // Extension pages may be closed; the page broadcast still runs.
  }

  // `loaded` and `ready` let a page follow the runtime that just became usable after a
  // deletion. `absent` lets an active page stop when no usable model remains. Downloads and
  // verification stay on extension pages only.
  if (
    message.status.state !== 'loaded' &&
    message.status.state !== 'ready' &&
    message.status.state !== 'absent'
  ) {
    return;
  }

  let tabs: readonly ProgressTab[];
  try {
    tabs = await sink.listTabs();
  } catch {
    return;
  }

  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      const url = tab.url ?? '';
      if (!url.startsWith('http://') && !url.startsWith('https://')) return;
      try {
        await sink.sendTab(tab.id, message);
      } catch {
        // This tab has no content script.
      }
    }),
  );
}

/** Loads the model that just finished downloading, and leaves a different model alone. */
export function shouldWarmDownloadedModel(
  downloaded: ModelStatus,
  active: ModelStatus | null,
): boolean {
  return (
    downloaded.state === 'ready' &&
    active !== null &&
    active.id === downloaded.id &&
    active.state !== 'loaded'
  );
}
