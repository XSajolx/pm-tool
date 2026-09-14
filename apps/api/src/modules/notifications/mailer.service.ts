import { Injectable, Logger } from "@nestjs/common";

/**
 * Row 73: the e-mail channel. Sends through Resend when RESEND_API_KEY is set
 * (MAIL_FROM optional); otherwise it logs the message so local dev still shows
 * what *would* have gone out. Failures never propagate - mail is best-effort.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly apiKey = process.env.RESEND_API_KEY;
  private readonly from = process.env.MAIL_FROM ?? "PM Tool <notifications@pm-tool.local>";
  private readonly appUrl = (process.env.WEB_URL ?? process.env.CORS_ORIGIN ?? "http://localhost:5173").split(",")[0]!.trim();

  /** Row 116: the last send / check outcome, for the health page. */
  lastResult: { at: string; ok: boolean; error: string | null; what: "send" | "check" } | null = null;

  get configured() {
    return Boolean(this.apiKey);
  }

  /** Row 116: verify the key without sending anything (Resend lists domains). */
  async check() {
    if (!this.apiKey) return { ok: false, error: "RESEND_API_KEY is not set" };
    try {
      const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${this.apiKey}` } });
      const ok = res.ok;
      const error = ok ? null : `Resend responded ${res.status}`;
      this.lastResult = { at: new Date().toISOString(), ok, error, what: "check" };
      return { ok, error };
    } catch (err) {
      const error = (err as Error).message;
      this.lastResult = { at: new Date().toISOString(), ok: false, error, what: "check" };
      return { ok: false, error };
    }
  }

  async send(input: { to: string; subject: string; text: string; link?: string }) {
    const body = input.link ? `${input.text}\n\n${this.appUrl}${input.link}` : input.text;
    if (!this.apiKey) {
      this.logger.log(`[email not configured] to=${input.to} subject="${input.subject}"`);
      return { sent: false };
    }
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [input.to], subject: input.subject, text: body }),
      });
      const detail = res.ok ? null : `${res.status} ${await res.text()}`;
      if (detail) this.logger.warn(`email to ${input.to} failed: ${detail}`);
      this.lastResult = { at: new Date().toISOString(), ok: res.ok, error: detail, what: "send" };
      return { sent: res.ok };
    } catch (err) {
      this.logger.warn(`email to ${input.to} failed: ${(err as Error).message}`);
      this.lastResult = { at: new Date().toISOString(), ok: false, error: (err as Error).message, what: "send" };
      return { sent: false };
    }
  }
}
