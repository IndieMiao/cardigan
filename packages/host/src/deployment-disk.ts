import { statfs } from "node:fs/promises";
import type { Store } from "@cardigan/store";
import { DEFAULT_DISK_LOW_PERCENT } from "./deployment-config.js";

const LOW = "host_disk_space_low";
const RECOVERED = "host_disk_space_recovered";

/** One nonblocking notice per low-space episode, also across supervisor restarts. */
export class DeploymentDiskMonitor {
  private next = 0;
  private lastLow?: boolean;

  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    private readonly threshold = DEFAULT_DISK_LOW_PERCENT,
    private readonly sample = async (
      dir: string,
    ): Promise<{ blocks: bigint; bavail: bigint }> =>
      statfs(dir, { bigint: true }),
  ) {}

  async poll(now = Date.now()) {
    if (now < this.next) return;
    this.next = now + 60_000;
    const { blocks, bavail } = await this.sample(this.dataDir);
    if (blocks <= 0n || bavail < 0n || bavail > blocks)
      throw new Error("Invalid disk observation");
    const low = bavail * 100n < blocks * BigInt(this.threshold);
    // The supervisor holds the exclusive host lock; stable samples need no database write lock.
    if (low === this.lastLow) return;
    this.store.uow.run((tx) => {
      const last = this.store.database
        .prepare(`SELECT type FROM events WHERE project_id = 'cardigan'
        AND card_id IS NULL AND type IN (?, ?) AND json_extract(doc, '$.actor.kind') = 'system'
        ORDER BY seq DESC LIMIT 1`)
        .get(LOW, RECOVERED);
      if ((last?.type === LOW) === low) return;
      const available = Number((bavail * 1000n) / blocks) / 10;
      tx.events.append("cardigan", {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence("cardigan"),
        type: low ? LOW : RECOVERED,
        actor: { kind: "system", project_id: "cardigan" },
        created_at: new Date(now).toISOString(),
        payload: {
          available_percent: available,
          threshold_percent: this.threshold,
          ...(low
            ? {
                notice: `主机数据盘可用空间剩余 ${available}%，低于 ${this.threshold}% 的提醒阈值。`,
              }
            : {}),
        },
      });
    });
    this.lastLow = low;
  }
}
