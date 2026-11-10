export interface OffscreenDocumentApi {
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  closeDocument(): Promise<void>;
}

export class OffscreenController {
  private creating: Promise<void> | null = null;

  constructor(private readonly api: OffscreenDocumentApi) {}

  async ensure(): Promise<void> {
    if (await this.api.hasDocument()) return;

    if (!this.creating) {
      this.creating = this.api
        .createDocument()
        .catch(async (error: unknown) => {
          if (await this.api.hasDocument()) return;
          throw error;
        })
        .finally(() => {
          this.creating = null;
        });
    }

    await this.creating;
  }

  async close(): Promise<void> {
    const pending = this.creating;
    if (pending) await pending.catch(() => undefined);
    this.creating = null;
    try {
      await this.api.closeDocument();
    } catch {
      // The document is already gone.
    }
  }

  async recreate(): Promise<void> {
    await this.close();
    await this.ensure();
  }
}
