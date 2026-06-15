// High-confidence DLP detector rules. Each rule maps a credential/PII format
// to a stable `type` (used in events and config.detectors filtering), a human
// `label`, a `regex`, and a `marker` substituted in redaction mode.
//
// IMPORTANT: every regex uses the global flag so the scanner can find all
// occurrences. The scanner resets `lastIndex` between uses.

export interface DlpRule {
  // detector key matched against config.detectors (e.g. 'aws', 'github')
  detector: string
  // finding type surfaced in events (e.g. 'AWS_ACCESS_KEY')
  type: string
  label: string
  regex: RegExp
  marker: string
}

export const DLP_RULES: DlpRule[] = [
  // ── Amazon Web Services ───────────────────────────────────────────────────
  {
    detector: 'aws',
    type: 'AWS_ACCESS_KEY',
    label: 'AWS Access Key ID',
    // Long-term (AKIA) + temporary/STS (ASIA) + the other 20-char AWS unique-id
    // prefixes that show up in leaked credentials.
    regex: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA|ASCA)[0-9A-Z]{16}\b/g,
    marker: '[REDACTED_AWS_KEY]',
  },
  {
    detector: 'aws',
    type: 'AWS_SECRET_KEY',
    label: 'AWS Secret Access Key',
    // 40-char base64 secret, only matched when adjacent to an aws-secret keyword
    // (a bare 40-char base64 string is far too common to flag on its own).
    regex: /aws(?:.{0,20})?(?:secret|sk)(?:.{0,20})?["' :=]+([A-Za-z0-9/+]{40})\b/gi,
    marker: '[REDACTED_AWS_SECRET]',
  },
  {
    detector: 'aws',
    type: 'AWS_SESSION_TOKEN',
    label: 'AWS Session Token',
    regex: /\bFwoG[A-Za-z0-9/+=_-]{50,}\b/g,
    marker: '[REDACTED_AWS_SESSION_TOKEN]',
  },
  {
    detector: 'aws',
    type: 'AWS_MWS_KEY',
    label: 'Amazon MWS Auth Token',
    regex: /amzn\.mws\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    marker: '[REDACTED_AWS_MWS_KEY]',
  },
  // ── Google Cloud / Google AI (Gemini) ─────────────────────────────────────
  {
    detector: 'google',
    type: 'GOOGLE_API_KEY',
    label: 'Google API Key (Cloud / Gemini / Maps / Firebase)',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    marker: '[REDACTED_GOOGLE_API_KEY]',
  },
  {
    detector: 'google',
    type: 'GOOGLE_OAUTH_TOKEN',
    label: 'Google OAuth Access Token',
    regex: /\bya29\.[0-9A-Za-z_-]{20,}/g,
    marker: '[REDACTED_GOOGLE_OAUTH_TOKEN]',
  },
  {
    detector: 'google',
    type: 'GOOGLE_OAUTH_REFRESH_TOKEN',
    label: 'Google OAuth Refresh Token',
    regex: /\b1\/\/0[0-9A-Za-z_-]{30,}/g,
    marker: '[REDACTED_GOOGLE_REFRESH_TOKEN]',
  },
  // (A downloaded GCP service-account JSON key's real secret is its
  // `-----BEGIN PRIVATE KEY-----` block, already covered by `private_keys`.)
  // ── AI / LLM service providers ─────────────────────────────────────────────
  {
    detector: 'anthropic',
    type: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API Key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    marker: '[REDACTED_ANTHROPIC_KEY]',
  },
  {
    detector: 'openrouter',
    type: 'OPENROUTER_API_KEY',
    label: 'OpenRouter API Key',
    regex: /\bsk-or-v1-[A-Za-z0-9]{32,}/g,
    marker: '[REDACTED_OPENROUTER_KEY]',
  },
  {
    detector: 'openai',
    type: 'OPENAI_API_KEY',
    label: 'OpenAI API Key',
    // Project/service-account/admin keys (contain - and _) OR the legacy
    // `sk-` + 48-char form. `sk-ant-`/`sk-or-` can't satisfy either branch.
    regex: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{40,}/g,
    marker: '[REDACTED_OPENAI_KEY]',
  },
  {
    detector: 'groq',
    type: 'GROQ_API_KEY',
    label: 'Groq API Key',
    regex: /\bgsk_[A-Za-z0-9]{40,}/g,
    marker: '[REDACTED_GROQ_KEY]',
  },
  {
    detector: 'xai',
    type: 'XAI_API_KEY',
    label: 'xAI (Grok) API Key',
    regex: /\bxai-[A-Za-z0-9]{40,}/g,
    marker: '[REDACTED_XAI_KEY]',
  },
  {
    detector: 'perplexity',
    type: 'PERPLEXITY_API_KEY',
    label: 'Perplexity API Key',
    regex: /\bpplx-[A-Za-z0-9]{32,}/g,
    marker: '[REDACTED_PERPLEXITY_KEY]',
  },
  {
    detector: 'huggingface',
    type: 'HUGGINGFACE_TOKEN',
    label: 'Hugging Face Access Token',
    regex: /\bhf_[A-Za-z0-9]{34,}/g,
    marker: '[REDACTED_HUGGINGFACE_TOKEN]',
  },
  {
    detector: 'replicate',
    type: 'REPLICATE_API_KEY',
    label: 'Replicate API Token',
    regex: /\br8_[A-Za-z0-9]{37,}/g,
    marker: '[REDACTED_REPLICATE_KEY]',
  },
  {
    detector: 'fireworks',
    type: 'FIREWORKS_API_KEY',
    label: 'Fireworks AI API Key',
    regex: /\bfw_[A-Za-z0-9]{24,}/g,
    marker: '[REDACTED_FIREWORKS_KEY]',
  },
  {
    detector: 'nvidia',
    type: 'NVIDIA_API_KEY',
    label: 'NVIDIA API Key',
    regex: /\bnvapi-[A-Za-z0-9_-]{32,}/g,
    marker: '[REDACTED_NVIDIA_KEY]',
  },
  {
    detector: 'anyscale',
    type: 'ANYSCALE_API_KEY',
    label: 'Anyscale API Key',
    regex: /\besecret_[A-Za-z0-9]{20,}/g,
    marker: '[REDACTED_ANYSCALE_KEY]',
  },
  {
    detector: 'langsmith',
    type: 'LANGSMITH_API_KEY',
    label: 'LangSmith / LangChain API Key',
    regex: /\blsv2_[a-z]{2}_[A-Za-z0-9]{20,}/g,
    marker: '[REDACTED_LANGSMITH_KEY]',
  },
  {
    detector: 'github',
    type: 'GITHUB_TOKEN',
    // PAT (ghp), OAuth (gho), user-to-server (ghu), server-to-server (ghs),
    // refresh (ghr) tokens — all `gh?_` + 36 base62.
    label: 'GitHub Token',
    regex: /gh[posru]_[0-9A-Za-z]{36}/g,
    marker: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    detector: 'github',
    type: 'GITHUB_FINE_GRAINED_PAT',
    label: 'GitHub Fine-Grained PAT',
    regex: /github_pat_[0-9A-Za-z_]{22,}/g,
    marker: '[REDACTED_GITHUB_TOKEN]',
  },
  {
    detector: 'gitlab',
    type: 'GITLAB_PAT',
    label: 'GitLab Personal/Project Access Token',
    regex: /\bglpat-[0-9A-Za-z_-]{20,}/g,
    marker: '[REDACTED_GITLAB_TOKEN]',
  },
  {
    detector: 'slack',
    type: 'SLACK_TOKEN',
    label: 'Slack Token',
    regex: /xox[baprs]-[0-9A-Za-z-]{10,}/g,
    marker: '[REDACTED_SLACK_TOKEN]',
  },
  {
    detector: 'slack',
    type: 'SLACK_WEBHOOK',
    label: 'Slack Incoming Webhook URL',
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/g,
    marker: '[REDACTED_SLACK_WEBHOOK]',
  },
  {
    detector: 'stripe',
    type: 'STRIPE_LIVE_KEY',
    label: 'Stripe Live Secret Key',
    // Secret (sk_live) and restricted (rk_live) live keys.
    regex: /[sr]k_live_[0-9a-zA-Z]{24,}/g,
    marker: '[REDACTED_STRIPE_KEY]',
  },
  {
    detector: 'stripe',
    type: 'STRIPE_WEBHOOK_SECRET',
    label: 'Stripe Webhook Signing Secret',
    regex: /\bwhsec_[A-Za-z0-9]{32,}/g,
    marker: '[REDACTED_STRIPE_WEBHOOK_SECRET]',
  },
  // ── Package registries & CI/CD ─────────────────────────────────────────────
  {
    detector: 'npm',
    type: 'NPM_TOKEN',
    label: 'npm Access Token',
    regex: /\bnpm_[0-9A-Za-z]{36}/g,
    marker: '[REDACTED_NPM_TOKEN]',
  },
  {
    detector: 'pypi',
    type: 'PYPI_TOKEN',
    label: 'PyPI Upload Token',
    regex: /\bpypi-AgEI[A-Za-z0-9_-]{50,}/g,
    marker: '[REDACTED_PYPI_TOKEN]',
  },
  {
    detector: 'rubygems',
    type: 'RUBYGEMS_KEY',
    label: 'RubyGems API Key',
    regex: /\brubygems_[a-f0-9]{48}/g,
    marker: '[REDACTED_RUBYGEMS_KEY]',
  },
  {
    detector: 'dockerhub',
    type: 'DOCKERHUB_PAT',
    label: 'Docker Hub Personal Access Token',
    regex: /\bdckr_pat_[A-Za-z0-9_-]{20,}/g,
    marker: '[REDACTED_DOCKERHUB_TOKEN]',
  },
  {
    detector: 'vault',
    type: 'VAULT_TOKEN',
    label: 'HashiCorp Vault Token',
    regex: /\bhv[sb]\.[A-Za-z0-9_-]{20,}/g,
    marker: '[REDACTED_VAULT_TOKEN]',
  },
  {
    detector: 'terraform',
    type: 'TERRAFORM_CLOUD_TOKEN',
    label: 'Terraform Cloud / Enterprise Token',
    regex: /\b[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_-]{40,}/g,
    marker: '[REDACTED_TERRAFORM_TOKEN]',
  },
  {
    detector: 'databricks',
    type: 'DATABRICKS_TOKEN',
    label: 'Databricks Personal Access Token',
    regex: /\bdapi[0-9a-f]{32}(?:-\d)?\b/g,
    marker: '[REDACTED_DATABRICKS_TOKEN]',
  },
  {
    detector: 'atlassian',
    type: 'ATLASSIAN_API_TOKEN',
    label: 'Atlassian (Jira/Confluence) API Token',
    regex: /\bAT(?:AT|CT)T3[A-Za-z0-9_=-]{100,}/g,
    marker: '[REDACTED_ATLASSIAN_TOKEN]',
  },
  // ── Payment, commerce ──────────────────────────────────────────────────────
  {
    detector: 'square',
    type: 'SQUARE_TOKEN',
    label: 'Square Access/OAuth Token',
    regex: /\bsq0(?:atp|csp|idp)-[A-Za-z0-9_-]{22,}/g,
    marker: '[REDACTED_SQUARE_TOKEN]',
  },
  {
    detector: 'shopify',
    type: 'SHOPIFY_TOKEN',
    label: 'Shopify Access Token',
    // shpat (admin), shpca (custom app), shppa (private app), shpss (shared secret).
    regex: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}/g,
    marker: '[REDACTED_SHOPIFY_TOKEN]',
  },
  // ── Communications & email/SMS ─────────────────────────────────────────────
  {
    detector: 'twilio',
    type: 'TWILIO_KEY',
    label: 'Twilio Account/API SID',
    regex: /\b(?:AC|SK)[0-9a-f]{32}\b/g,
    marker: '[REDACTED_TWILIO_KEY]',
  },
  {
    detector: 'sendgrid',
    type: 'SENDGRID_KEY',
    label: 'SendGrid API Key',
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
    marker: '[REDACTED_SENDGRID_KEY]',
  },
  {
    detector: 'mailgun',
    type: 'MAILGUN_KEY',
    label: 'Mailgun API Key',
    regex: /\bkey-[0-9a-f]{32}\b/g,
    marker: '[REDACTED_MAILGUN_KEY]',
  },
  {
    detector: 'mailchimp',
    type: 'MAILCHIMP_KEY',
    label: 'Mailchimp API Key',
    regex: /\b[0-9a-f]{32}-us\d{1,2}\b/g,
    marker: '[REDACTED_MAILCHIMP_KEY]',
  },
  {
    detector: 'telegram',
    type: 'TELEGRAM_BOT_TOKEN',
    label: 'Telegram Bot Token',
    regex: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g,
    marker: '[REDACTED_TELEGRAM_TOKEN]',
  },
  {
    detector: 'discord',
    type: 'DISCORD_WEBHOOK',
    label: 'Discord Webhook URL',
    regex: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
    marker: '[REDACTED_DISCORD_WEBHOOK]',
  },
  {
    detector: 'discord',
    type: 'DISCORD_BOT_TOKEN',
    label: 'Discord Bot Token',
    regex: /\b[MNO][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g,
    marker: '[REDACTED_DISCORD_TOKEN]',
  },
  // ── Cloud infrastructure & ops ─────────────────────────────────────────────
  {
    detector: 'azure',
    type: 'AZURE_STORAGE_KEY',
    label: 'Azure Storage Account Key (connection string)',
    regex: /AccountKey=[A-Za-z0-9+/]{86,}={0,2}/g,
    marker: '[REDACTED_AZURE_STORAGE_KEY]',
  },
  {
    detector: 'digitalocean',
    type: 'DIGITALOCEAN_TOKEN',
    label: 'DigitalOcean Access Token',
    regex: /\bdo[oprt]_v1_[a-f0-9]{64}/g,
    marker: '[REDACTED_DIGITALOCEAN_TOKEN]',
  },
  {
    detector: 'newrelic',
    type: 'NEWRELIC_KEY',
    label: 'New Relic API Key',
    regex: /\bNR(?:AK|JS|RA|AA|AL|II)-[A-Za-z0-9_-]{20,}/g,
    marker: '[REDACTED_NEWRELIC_KEY]',
  },
  {
    detector: 'sentry',
    type: 'SENTRY_DSN',
    label: 'Sentry DSN (with secret)',
    regex: /https:\/\/[0-9a-f]{32}(?::[0-9a-f]{32})?@[a-z0-9.-]*sentry\.io\/\d+/gi,
    marker: '[REDACTED_SENTRY_DSN]',
  },
  // ── Format signatures ──────────────────────────────────────────────────────
  {
    detector: 'jwt',
    type: 'JWT',
    label: 'JSON Web Token',
    // header.payload.signature — both header and payload base64url-encode a JSON
    // object, which always begins `{"` → `eyJ`. Requiring it on both segments
    // (plus a present signature) keeps this off arbitrary base64.
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    marker: '[REDACTED_JWT]',
  },
  {
    detector: 'private_keys',
    type: 'PRIVATE_KEY',
    label: 'Private Key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    marker: '[REDACTED_PRIVATE_KEY]',
  },
  {
    detector: 'mongodb',
    type: 'MONGODB_URI',
    label: 'MongoDB SRV Connection URI',
    regex: /mongodb\+srv:\/\/[^\s:@/]+:[^\s:@/]+@[^\s/"']+/g,
    marker: '[REDACTED_MONGODB_URI]',
  },
  {
    detector: 'connection_uri',
    type: 'CONNECTION_URI',
    label: 'Connection String with Embedded Credentials',
    // scheme://user:password@host — covers DB URIs (Postgres/MySQL/Redis/AMQP/
    // mongodb) and HTTP(S)/FTP basic-auth credentials. Password segment must be
    // non-empty so `scheme://user@host` (no secret) does not match.
    regex: /\b(?:https?|ftp|postgres(?:ql)?|mysql|mariadb|rediss?|amqps?|mongodb):\/\/[^\s:@/]+:[^\s:@/]+@[^\s/"']+/gi,
    marker: '[REDACTED_CONNECTION_URI]',
  },
  {
    detector: 'pii',
    type: 'SSN',
    label: 'US Social Security Number',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    marker: '[REDACTED_SSN]',
  },
]

// Marker used for Luhn-validated credit-card candidates (PII detector).
export const CREDIT_CARD_MARKER = '[REDACTED_CREDIT_CARD]'

// Marker used for entropy-based generic secrets (Strategy 2).
export const GENERIC_SECRET_MARKER = '[REDACTED_SECRET]'

// Marker used for `Authorization: Bearer <token>` style credentials.
export const BEARER_TOKEN_MARKER = '[REDACTED_BEARER_TOKEN]'

// Candidate credit-card numbers: 13–19 digits, optionally separated by single
// spaces or hyphens. Validation via Luhn happens in the scanner.
export const CREDIT_CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g

/**
 * Luhn checksum validation for a string of digits (separators allowed and
 * ignored). Returns false for input with no digits or fewer than 13 digits.
 */
export function luhnValid(digits: string): boolean {
  const cleaned = digits.replace(/[^0-9]/g, '')
  if (cleaned.length < 13 || cleaned.length > 19) return false
  let sum = 0
  let double = false
  for (let i = cleaned.length - 1; i >= 0; i--) {
    let d = cleaned.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}
