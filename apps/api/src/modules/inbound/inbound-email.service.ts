import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, asc, eq, ilike, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.module.js";
import type { DB } from "../../db/index.js";
import { lists, memberships, projects, tasks, users } from "../../db/schema.js";
import { TasksService } from "../tasks/tasks.service.js";
import { CommentsService } from "../comments/comments.service.js";
import { FilesService } from "../files/files.service.js";

/** Normalised inbound mail. Postmark's JSON maps onto this 1:1; SES/Mailgun need a thin adapter. */
export interface InboundEmail {
  from: string;
  fromName?: string | null;
  to: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  attachments?: { name: string; contentType: string; contentBase64: string }[];
}

const DOMAIN = process.env.INBOUND_EMAIL_DOMAIN ?? "in.pm-tool.local";

/**
 * Row 78: every project has a unique address (`<slug>+<token>@<domain>`). Mail
 * forwarded there becomes a task in the project's first list - or a comment,
 * when the subject carries an existing task reference like "[PM-142]" or
 * matches an open task's title (a "Re:" thread). Attachments ride along.
 * The provider (Postmark / SES) posts the parsed mail to /public/inbound/email.
 */
@Injectable()
export class InboundEmailService {
  private readonly logger = new Logger(InboundEmailService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DB,
    private readonly tasksService: TasksService,
    private readonly comments: CommentsService,
    private readonly files: FilesService,
  ) {}

  /** The project's address, minting the token on first use. */
  async addressFor(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)) });
    if (!project) throw new NotFoundException("Project not found");
    let token = project.inboundToken;
    if (!token) {
      token = randomBytes(9).toString("base64url");
      await this.db.update(projects).set({ inboundToken: token }).where(eq(projects.id, projectId));
    }
    return { address: `${slug(project.name)}+${token}@${DOMAIN}`, token, domain: DOMAIN, configured: Boolean(process.env.INBOUND_EMAIL_DOMAIN) };
  }

  /** New token = old address stops working (e.g. it leaked to a mailing list). */
  async regenerate(orgId: string, projectId: string) {
    const project = await this.db.query.projects.findFirst({ where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)), columns: { id: true } });
    if (!project) throw new NotFoundException("Project not found");
    await this.db.update(projects).set({ inboundToken: randomBytes(9).toString("base64url") }).where(eq(projects.id, projectId));
    return this.addressFor(orgId, projectId);
  }

  /** Accepts Postmark's inbound JSON or the normalised shape above. */
  normalise(raw: Record<string, unknown>): InboundEmail {
    if (typeof raw.from === "string" && Array.isArray(raw.to)) return raw as unknown as InboundEmail;
    const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : "");
    const recipients = [str("OriginalRecipient"), str("To"), str("ToFull") ? "" : "", str("Cc")]
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter(Boolean);
    const toFull = Array.isArray(raw.ToFull) ? (raw.ToFull as { Email?: string }[]).map((t) => t.Email ?? "").filter(Boolean) : [];
    const atts = Array.isArray(raw.Attachments)
      ? (raw.Attachments as { Name?: string; ContentType?: string; Content?: string }[]).map((a) => ({ name: a.Name ?? "attachment", contentType: a.ContentType ?? "application/octet-stream", contentBase64: a.Content ?? "" }))
      : [];
    return { from: str("From"), fromName: str("FromName") || null, to: [...recipients, ...toFull], subject: str("Subject"), text: str("TextBody") || null, html: str("HtmlBody") || null, attachments: atts };
  }

  /** Route a mail to its project and turn it into a task or a comment. */
  async handle(mail: InboundEmail) {
    const token = mail.to.map(tokenOf).find(Boolean);
    if (!token) throw new BadRequestException("No project address among the recipients");
    const project = await this.db.query.projects.findFirst({
      where: and(eq(projects.inboundToken, token), isNull(projects.archivedAt)),
      with: { space: { with: { lists: { where: isNull(lists.archivedAt), orderBy: [asc(lists.position)] } } } },
    });
    if (!project) throw new NotFoundException("Unknown project address");
    const list = project.space?.lists[0];
    if (!list) throw new BadRequestException("Project has no task list to file into");
    const orgId = project.organizationId;

    // Who acts: the sender if they're a member here, else the project lead / creator.
    const senderEmail = extractEmail(mail.from);
    const member = senderEmail
      ? await this.db
          .select({ id: users.id })
          .from(users)
          .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.organizationId, orgId)))
          .where(ilike(users.email, senderEmail))
          .limit(1)
      : [];
    const actorId = member[0]?.id ?? project.leadId ?? project.createdById;
    if (!actorId) throw new BadRequestException("Project has no lead to act as");

    const subject = mail.subject.trim() || "(no subject)";
    const cleanSubject = subject.replace(/^((re|fwd?|fw)\s*:\s*)+/i, "").trim() || subject;
    const body = (mail.text?.trim() || stripHtml(mail.html ?? "") || "").slice(0, 10_000);
    const header = `📧 From ${mail.fromName ? `${mail.fromName} <${senderEmail ?? mail.from}>` : mail.from}`;

    // Existing thread? "[PM-142]" beats a title match.
    const ref = subject.match(/\[([A-Z]{1,6}-\d{1,6})\]/)?.[1];
    const listIds = project.space!.lists.map((l) => l.id);
    let existing = ref
      ? await this.db.query.tasks.findFirst({ where: and(eq(tasks.organizationId, orgId), eq(tasks.reference, ref), isNull(tasks.archivedAt)) })
      : undefined;
    if (!existing && /^(re|fwd?|fw)\s*:/i.test(subject)) {
      const rows = await this.db.query.tasks.findMany({ where: and(eq(tasks.organizationId, orgId), isNull(tasks.archivedAt), isNull(tasks.completedAt), ilike(tasks.title, cleanSubject)), limit: 5 });
      existing = rows.find((t) => listIds.includes(t.listId)) ?? rows[0];
    }

    if (existing) {
      const comment = await this.comments.create(orgId, actorId, existing.id, { body: `${header}\n\n${body}` });
      await this.saveAttachments(orgId, actorId, existing.id, mail.attachments ?? []);
      this.logger.log(`inbound mail -> comment on task ${existing.id}`);
      return { kind: "comment" as const, taskId: existing.id, commentId: comment.id, projectId: project.id };
    }

    const task = await this.tasksService.create(orgId, actorId, { listId: list.id, title: cleanSubject.slice(0, 500), description: `${header}\n\n${body}` });
    await this.saveAttachments(orgId, actorId, task.id, mail.attachments ?? []);
    this.logger.log(`inbound mail -> task ${task.id} in project ${project.id}`);
    return { kind: "task" as const, taskId: task.id, projectId: project.id };
  }

  private async saveAttachments(orgId: string, userId: string, taskId: string, atts: NonNullable<InboundEmail["attachments"]>) {
    for (const a of atts.slice(0, 10)) {
      if (!a.contentBase64) continue;
      const buffer = Buffer.from(a.contentBase64, "base64");
      if (!buffer.length || buffer.length > 25 * 1024 * 1024) continue;
      try {
        await this.files.upload(orgId, userId, { originalname: a.name, mimetype: a.contentType, size: buffer.length, buffer }, { taskId });
      } catch (err) {
        this.logger.warn(`attachment ${a.name} skipped: ${(err as Error).message}`);
      }
    }
  }
}

function slug(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
}

/** `anything+TOKEN@domain` or `project-TOKEN@domain`; case-insensitive on the domain only. */
function tokenOf(address: string): string | null {
  const email = extractEmail(address);
  if (!email) return null;
  const local = email.split("@")[0] ?? "";
  const plus = local.match(/\+([A-Za-z0-9_-]{8,})$/)?.[1];
  if (plus) return plus;
  const dashed = local.match(/^project-([A-Za-z0-9_-]{8,})$/)?.[1];
  return dashed ?? null;
}

function extractEmail(v: string): string | null {
  const m = v.match(/<([^>]+)>/)?.[1] ?? v;
  const e = m.trim();
  return /^[^\s@]+@[^\s@]+$/.test(e) ? e : null;
}

function stripHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
