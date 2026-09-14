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

  get configured() {
    return Boolean(this.apiKey);
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
      if (!res.ok) this.logger.warn(`email to ${input.to} failed: ${res.status} ${await res.text()}`);
      return { sent: res.ok };
    } catch (err) {
      this.logger.warn(`email to ${input.to} failed: ${(err as Error).message}`);
      return { sent: false };
    }
  }
}
