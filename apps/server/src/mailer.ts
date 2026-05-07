import { Resend } from 'resend';

export interface SendArgs { to: string; subject: string; html: string; text: string }
export interface Mailer { send(args: SendArgs): Promise<void> }

export class ResendMailer implements Mailer {
  constructor(private apiKey: string, private from: string) {}
  async send(a: SendArgs): Promise<void> {
    const c = new Resend(this.apiKey);
    const { error } = await c.emails.send({
      from: this.from, to: a.to, subject: a.subject, html: a.html, text: a.text,
    });
    if (error) throw new Error(`resend: ${error.message}`);
  }
}

export class FakeMailer implements Mailer {
  outbox: SendArgs[] = [];
  async send(a: SendArgs): Promise<void> { this.outbox.push(a); }
  lastTo(addr: string): SendArgs | undefined { return [...this.outbox].reverse().find(m => m.to === addr); }
}
