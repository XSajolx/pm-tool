import { Injectable, Logger } from "@nestjs/common";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where file bytes live (row 43; task attachments use the same service).
 *
 * S3-compatible (Cloudflare R2 / S3) when S3_BUCKET + S3_ACCESS_KEY_ID are set:
 * the app tier uploads once and hands out short-lived signed GET URLs, so bytes
 * never stream through the API on read.
 *
 * Otherwise a local folder (UPLOAD_DIR, default ./uploads next to the API) —
 * fine for dev and single-box installs; /api/files/:id/raw streams the bytes.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket = process.env.S3_BUCKET ?? "";
  private readonly s3 =
    process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID
      ? new S3Client({
          region: process.env.S3_REGION || "auto",
          endpoint: process.env.S3_ENDPOINT || undefined,
          forcePathStyle: Boolean(process.env.S3_ENDPOINT),
          credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "" },
        })
      : null;
  private readonly dir = process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), "uploads");

  constructor() {
    this.logger.log(this.s3 ? `files → S3 bucket ${this.bucket}` : `files → local folder ${this.dir}`);
  }

  get mode(): "s3" | "local" {
    return this.s3 ? "s3" : "local";
  }

  async put(key: string, body: Buffer, mimeType: string) {
    if (this.s3) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mimeType }));
      return;
    }
    const file = this.localPath(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async remove(key: string) {
    try {
      if (this.s3) await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      else await unlink(this.localPath(key));
    } catch (err) {
      this.logger.warn(`could not delete ${key}: ${(err as Error).message}`);
    }
  }

  /** A URL the browser can load directly (img src, download link). */
  async url(key: string, id: string, filename: string) {
    if (this.s3) {
      return getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: `inline; filename="${encodeURIComponent(filename)}"` }),
        { expiresIn: 3600 },
      );
    }
    const base = (process.env.PUBLIC_API_URL ?? process.env.API_URL ?? `http://localhost:${process.env.API_PORT ?? 3333}`).replace(/\/$/, "");
    return `${base}/api/files/${id}/raw`;
  }

  /** Local mode only: a readable stream of the bytes, or null when missing. */
  localStream(key: string) {
    const file = this.localPath(key);
    return existsSync(file) ? createReadStream(file) : null;
  }

  private localPath(key: string) {
    // Keys are org/scope/id-name; strip anything that could walk the tree.
    return path.join(this.dir, ...key.split("/").map((seg) => seg.replace(/[^\w.\-() ]+/g, "_")));
  }
}
