import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Private to the controller DB, never a deployment credential or worker file. */
export class RunResourceAuthority {
  constructor(private readonly db: DatabaseSync) {}
  private key?: ReturnType<typeof createPrivateKey>;
  private getKey() {
    if (this.key) return this.key;
    const query = this.db.prepare(
      "SELECT pem FROM run_resource_authority WHERE singleton=1",
    );
    let row = query.get();
    if (!row) {
      const { privateKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      });
      this.db
        .prepare(
          "INSERT INTO run_resource_authority(singleton,pem) VALUES(1,?) ON CONFLICT(singleton) DO NOTHING",
        )
        .run(privateKey.export({ type: "pkcs8", format: "pem" }));
      row = query.get();
    }
    if (typeof row?.pem !== "string")
      throw new Error("Run resource authority unavailable");
    this.key = createPrivateKey(row.pem);
    return this.key;
  }
  publicKey() {
    return createPublicKey(this.getKey())
      .export({ type: "spki", format: "pem" })
      .toString();
  }
  signState(data: string) {
    return sign("sha256", Buffer.from(data), this.getKey()).toString("base64");
  }
}
