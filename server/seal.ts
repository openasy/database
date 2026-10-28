// Seals the password of each database with the install's secrets key (ADR 0021), so it is opened only to connect and
// the SQLite file and its backups hold it encrypted. Without a key nothing is sealed, and Database refuses to keep a
// password at all (monitor.ts).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "v1:";

export function sealer(key: Buffer | undefined) {
  return {
    /** Whether there is a key to seal with. */
    ready: Boolean(key),
    seal(text: string): string {
      if (!key) throw new Error("No secrets key is mounted to seal with.");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    },
    open(sealed: string): string {
      if (!sealed.startsWith(PREFIX)) throw new Error("The secret is not sealed.");
      if (!key) throw new Error("The secret was sealed with a secrets key, and none is mounted.");
      const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

export type Sealer = ReturnType<typeof sealer>;
