import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { linkedFiles } from "../../db/schema.js";
import { IntegrationsService } from "../integrations/integrations.service.js";

export type LinkedEntity = "task" | "document" | "project" | "contact" | "company";
export const LINKED_ENTITIES: LinkedEntity[] = ["task", "document", "project", "contact", "company"];
type Provider = "google_drive" | "dropbox" | "link";

interface Parsed { provider: Provider; externalId: string | null; url: string }

/** Recognise Drive / Dropbox links; anything else is kept as a plain link. */
export function parseFileUrl(raw: string): Parsed {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new BadRequestException("That doesn't look like a link");
  }
  const host = u.hostname.toLowerCase();
  if (host === "drive.google.com" || host === "docs.google.com") {
    const m = u.pathname.match(/\/(?:file|document|spreadsheets|presentation|forms|drawings)\/d\/([^/]+)/) ?? u.pathname.match(/\/folders\/([^/?]+)/);
    const id = m?.[1] ?? u.searchParams.get("id");
    return { provider: "google_drive", externalId: id, url: u.toString() };
  }
  if (host.endsWith("dropbox.com") || host.endsWith("dropboxusercontent.com")) {
    return { provider: "dropbox", externalId: null, url: u.toString() };
  }
  return { provider: "link", externalId: null, url: u.toString() };
}

/**
 * Row 124: link a file from Drive / Dropbox to a record. If the provider is
 * connected (row 112) we fetch its real name, type and last-modified time and
 * can refresh them later; otherwise the link is stored with the name given.
 */
@Injectable()
export class LinkedFilesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly integrations: IntegrationsService,
  ) {}

  async list(orgId: string, entityType: LinkedEntity, entityId: string) {
    const rows = await this.db.query.linkedFiles.findMany({
      where: and(eq(linkedFiles.organizationId, orgId), eq(linkedFiles.entityType, entityType), eq(linkedFiles.entityId, entityId)),
      with: { addedBy: { columns: { id: true, name: true } } },
      orderBy: [asc(linkedFiles.createdAt)],
    });
    return rows.map((f) => this.shape(f));
  }

  async add(orgId: string, userId: string, dto: { entityType: LinkedEntity; entityId: string; url: string; name?: string | null }) {
    const parsed = parseFileUrl(dto.url);
    const meta = await this.fetchMeta(orgId, parsed).catch(() => null);
    const fallbackName = dto.name?.trim() || meta?.name || guessName(parsed.url);
    const [row] = await this.db
      .insert(linkedFiles)
      .values({
        organizationId: orgId,
        entityType: dto.entityType,
        entityId: dto.entityId,
        provider: parsed.provider,
        url: parsed.url,
        externalId: parsed.externalId,
        name: fallbackName.slice(0, 255),
        mimeType: meta?.mimeType ?? null,
        sizeBytes: meta?.sizeBytes ?? null,
        iconUrl: meta?.iconUrl ?? null,
        lastModifiedAt: meta?.modifiedAt ?? null,
        lastCheckedAt: meta ? new Date() : null,
        addedById: userId,
      })
      .returning();
    return this.list(orgId, dto.entityType, dto.entityId);
  }

  /** Re-read the provider's metadata (name, modified time) for one link. */
  async refresh(orgId: string, id: string) {
    const row = await this.db.query.linkedFiles.findFirst({ where: and(eq(linkedFiles.id, id), eq(linkedFiles.organizationId, orgId)) });
    if (!row) throw new NotFoundException("Linked file not found");
    const meta = await this.fetchMeta(orgId, { provider: row.provider as Provider, externalId: row.externalId, url: row.url });
    if (!meta) throw new BadRequestException(row.provider === "link" ? "Plain links have nothing to refresh" : "Connect the provider in Settings › Connections to refresh metadata");
    await this.db
      .update(linkedFiles)
      .set({ name: meta.name ?? row.name, mimeType: meta.mimeType ?? row.mimeType, sizeBytes: meta.sizeBytes ?? row.sizeBytes, iconUrl: meta.iconUrl ?? row.iconUrl, lastModifiedAt: meta.modifiedAt ?? row.lastModifiedAt, lastCheckedAt: new Date() })
      .where(eq(linkedFiles.id, id));
    return this.list(orgId, row.entityType as LinkedEntity, row.entityId);
  }

  async remove(orgId: string, id: string) {
    const rows = await this.db.delete(linkedFiles).where(and(eq(linkedFiles.id, id), eq(linkedFiles.organizationId, orgId))).returning({ entityType: linkedFiles.entityType, entityId: linkedFiles.entityId });
    if (!rows.length) throw new NotFoundException("Linked file not found");
    return this.list(orgId, rows[0]!.entityType as LinkedEntity, rows[0]!.entityId);
  }

  private shape(f: typeof linkedFiles.$inferSelect & { addedBy?: { id: string; name: string } | null }) {
    return {
      id: f.id,
      entityType: f.entityType,
      entityId: f.entityId,
      provider: f.provider as Provider,
      url: f.url,
      name: f.name,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      iconUrl: f.iconUrl,
      lastModifiedAt: f.lastModifiedAt?.toISOString() ?? null,
      lastCheckedAt: f.lastCheckedAt?.toISOString() ?? null,
      addedBy: f.addedBy ?? null,
      createdAt: f.createdAt.toISOString(),
    };
  }

  /** Provider metadata when that provider is connected; null when it isn't (or the link is plain). */
  private async fetchMeta(orgId: string, p: Parsed): Promise<{ name: string | null; mimeType: string | null; sizeBytes: number | null; iconUrl: string | null; modifiedAt: Date | null } | null> {
    if (p.provider === "link") return null;
    let token: string;
    try {
      token = await this.integrations.freshToken(orgId, p.provider);
    } catch {
      return null;
    }
    if (p.provider === "google_drive") {
      if (!p.externalId) return null;
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(p.externalId)}?fields=name,mimeType,modifiedTime,size,iconLink&supportsAllDrives=true`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Google Drive ${res.status}`);
      const j = (await res.json()) as { name?: string; mimeType?: string; modifiedTime?: string; size?: string; iconLink?: string };
      return { name: j.name ?? null, mimeType: j.mimeType ?? null, sizeBytes: j.size ? Number(j.size) : null, iconUrl: j.iconLink ?? null, modifiedAt: j.modifiedTime ? new Date(j.modifiedTime) : null };
    }
    const res = await fetch("https://api.dropboxapi.com/2/sharing/get_shared_link_metadata", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url: p.url }) });
    if (!res.ok) throw new Error(`Dropbox ${res.status}`);
    const j = (await res.json()) as { name?: string; size?: number; server_modified?: string; ".tag"?: string };
    return { name: j.name ?? null, mimeType: j[".tag"] === "folder" ? "application/vnd.dropbox.folder" : null, sizeBytes: j.size ?? null, iconUrl: null, modifiedAt: j.server_modified ? new Date(j.server_modified) : null };
  }
}

function guessName(url: string) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    if (last && !/^[A-Za-z0-9_-]{20,}$/.test(last) && !["view", "edit", "d"].includes(last)) return last;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "Linked file";
  }
}
