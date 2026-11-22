import { type ExtMessageOptions, ExtMessageSender } from "./ext-message.js";
import { loadExtMessageConfig } from "./ext-message-config.js";
import { extGenerationStamp } from "./ext-message-generation.js";

/** Web and background can be separate processes. YAML rename publishes a complete generation. */
export class LiveExtMessageSender {
  private sender?: ExtMessageSender;
  private stamp?: string;
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(
    private path: string,
    private options: Omit<ExtMessageOptions, "configuration">,
  ) {}
  private install() {
    this.options.store.uow.run((tx) => {
      const stamp = extGenerationStamp(this.path);
      const sender = new ExtMessageSender({
        ...this.options,
        configuration: loadExtMessageConfig(this.path),
        generation: { path: this.path, stamp },
      });
      sender.recordStatus(tx);
      this.sender = sender;
      this.stamp = stamp;
    });
  }
  start() {
    this.install();
  }
  // The timer serializes ticks. Stop the WS worker and settle old sends before replacing it.
  async tick() {
    if (this.stopped) return;
    if (this.stamp !== extGenerationStamp(this.path)) {
      this.closing ??= this.sender?.stop();
      await this.closing;
      if (this.stopped) return;
      this.closing = undefined;
      this.install();
    }
    await this.sender?.tick();
  }
  async stop() {
    this.stopped = true;
    this.closing ??= this.sender?.stop();
    await this.closing;
  }
}
