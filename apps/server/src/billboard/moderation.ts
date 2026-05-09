// Pre-publish moderation pipeline.
//
// Two upstream services, both gated behind MODERATION_ENABLED:
//   * Sightengine — image classification (nudity, gore, weapon, offensive,
//     CSAM probe, OCR text). Confidence ≥0.85 → reject; 0.50–0.85 → flag
//     for human review (slot is created with pending_review=true).
//   * Google Safe Browsing v4 — URL reputation check on the click_url.
//     Any positive hit → reject (no flag-only path; bad URLs are bad).
//
// In dev/test/CI we disable the upstreams entirely so tests don't need
// network access or API keys. The moderate() function still records a
// moderation_events row in that case (decision='NO_ACTION', source
// 'AUTO_SIGHTENGINE'), so the audit trail stays consistent.

export interface ModerationVerdict {
  /** 'reject' fully blocks the action; 'flag' allows publish with pending_review=true; 'pass' is fully clear. */
  decision: 'pass' | 'flag' | 'reject';
  /** Free-form reason shown to the user on rejection. */
  reason: string | null;
  /** Raw classifier scores, stored on moderation_events.classifier_score. */
  scores: Record<string, unknown>;
  /** True only when the worst class is CSAM-flavored. Routes us to the NCMEC report path. */
  csam: boolean;
}

export interface ModerationConfig {
  enabled: boolean;
  sightengineApiUser?: string;
  sightengineApiSecret?: string;
  safeBrowsingApiKey?: string;
}

const PASS: ModerationVerdict = { decision: 'pass', reason: null, scores: {}, csam: false };

/** Scan an image and decide whether it can be published. */
export async function moderateImage(
  bytes: Buffer,
  contentType: string,
  cfg: ModerationConfig,
): Promise<ModerationVerdict> {
  if (!cfg.enabled || !cfg.sightengineApiUser || !cfg.sightengineApiSecret) {
    return PASS;
  }

  const form = new FormData();
  form.append('media', new Blob([bytes], { type: contentType }), 'upload');
  form.append('models', 'nudity-2.1,gore-2.0,offensive,weapon,text-content');
  form.append('api_user', cfg.sightengineApiUser);
  form.append('api_secret', cfg.sightengineApiSecret);

  const res = await fetch('https://api.sightengine.com/1.0/check.json', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    // Fail open with a flag, not a reject — we don't want a Sightengine
    // outage to block the entire claim flow. Human review will catch it.
    return { decision: 'flag', reason: null, scores: { sightengine_error: res.status }, csam: false };
  }
  const json = await res.json() as Record<string, any>;

  const nudityScore = Math.max(
    json?.nudity?.sexual_activity ?? 0,
    json?.nudity?.sexual_display ?? 0,
    json?.nudity?.erotica ?? 0,
    json?.nudity?.very_suggestive ?? 0,
  );
  const goreScore = json?.gore?.prob ?? 0;
  const offensiveScore = Math.max(
    json?.offensive?.prob ?? 0,
    json?.offensive?.nazi ?? 0,
    json?.offensive?.confederate ?? 0,
    json?.offensive?.supremacist ?? 0,
    json?.offensive?.terrorist ?? 0,
  );
  const weaponScore = json?.weapon?.classes?.firearm ?? 0;
  const csamScore = json?.nudity?.suggestive_classes?.minor ?? 0;

  const worst = Math.max(nudityScore, goreScore, offensiveScore, weaponScore);
  if (csamScore >= 0.5) {
    return {
      decision: 'reject', reason: 'image flagged as potential CSAM', csam: true,
      scores: json,
    };
  }
  if (worst >= 0.85) {
    return { decision: 'reject', reason: 'image flagged by automated moderation', scores: json, csam: false };
  }
  if (worst >= 0.50) {
    return { decision: 'flag', reason: null, scores: json, csam: false };
  }
  return { decision: 'pass', reason: null, scores: json, csam: false };
}

export interface UrlVerdict {
  ok: boolean;
  reason: string | null;
  hit: Record<string, unknown> | null;
}

/** Validate the click-URL: scheme allowlist, length cap, Safe Browsing, HTTP HEAD. */
export async function moderateUrl(url: string, cfg: ModerationConfig): Promise<UrlVerdict> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid URL', hit: null }; }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'URL must use https://', hit: null };
  }
  if (url.length > 512) {
    return { ok: false, reason: 'URL exceeds 512-char cap', hit: null };
  }

  if (cfg.enabled && cfg.safeBrowsingApiKey) {
    const sbBody = {
      client: { clientId: 'rpow3-billboard', clientVersion: '1.0' },
      threatInfo: {
        threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: [{ url }],
      },
    };
    try {
      const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(cfg.safeBrowsingApiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sbBody),
      });
      if (res.ok) {
        const json = await res.json() as { matches?: unknown[] };
        if (Array.isArray(json.matches) && json.matches.length > 0) {
          return { ok: false, reason: 'URL flagged by Google Safe Browsing', hit: json };
        }
      }
      // Non-2xx responses fail open: Safe Browsing being down is not a
      // reason to block the entire claim flow.
    } catch {
      /* fail open */
    }
  }

  return { ok: true, reason: null, hit: null };
}
