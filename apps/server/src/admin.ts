// Tiny admin role check.
//
// Admin auth here is "is the session-holder's email in the configured
// ADMIN_EMAILS list". That keeps secrets out of the database — adding
// or removing an admin is an env-var redeploy. Comparison is
// case-insensitive on email.

export interface AdminConfig {
  /** Already-normalized lowercase emails. */
  emails: Set<string>;
}

export function parseAdminEmails(env?: string): AdminConfig {
  const set = new Set<string>();
  for (const raw of (env ?? '').split(',')) {
    const e = raw.trim().toLowerCase();
    if (e.includes('@')) set.add(e);
  }
  return { emails: set };
}

export function isAdmin(cfg: AdminConfig, email: string | null | undefined): boolean {
  return !!email && cfg.emails.has(email.toLowerCase());
}
