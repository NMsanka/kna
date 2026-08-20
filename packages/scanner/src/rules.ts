/**
 * Detection ruleset for the pre-index scan (§10 Layer 2).
 *
 * This runs in the CLI, before anything leaves the machine, and it fails closed. §16 is blunt
 * about why: "treat this as unrecoverable if it happens — plan for prevention, not
 * remediation." A secret that reaches the index has also reached the embedding cache, the
 * query logs, and possibly a model provider's retention window.
 *
 * The ruleset is hashed and recorded in the bundle's scan report, so "which rules ran against
 * this commit" is answerable after an incident.
 */

export type Severity = 'critical' | 'high' | 'medium';
export type Category = 'secret' | 'pii' | 'injection';

export interface Rule {
  id: string;
  description: string;
  category: Category;
  severity: Severity;
  pattern: RegExp;
  /** Minimum Shannon entropy of the captured group, when the pattern alone is too loose. */
  minEntropy?: number;
  /** Capture group holding the candidate secret; defaults to the whole match. */
  captureGroup?: number;
  /** Paths where this rule is noise rather than signal. */
  excludePaths?: RegExp[];
}

const TEST_FIXTURE_PATHS = [/(^|\/)(test|tests|spec|__tests__|fixtures?|testdata)(\/|$)/i];

export const SECRET_RULES: Rule[] = [
  {
    id: 'aws-access-key-id',
    description: 'AWS access key ID',
    category: 'secret',
    severity: 'critical',
    pattern: /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g,
    captureGroup: 1,
  },
  {
    id: 'aws-secret-access-key',
    description: 'AWS secret access key',
    category: 'secret',
    severity: 'critical',
    pattern:
      /aws[_.-]?(?:secret[_.-]?)?access[_.-]?key(?:[_.-]?id)?["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})\b/gi,
    captureGroup: 1,
    minEntropy: 3.5,
  },
  {
    id: 'private-key-block',
    description: 'PEM private key block',
    category: 'secret',
    severity: 'critical',
    pattern: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED)?\s*PRIVATE KEY(?:\s+BLOCK)?-----/g,
  },
  {
    id: 'github-token',
    description: 'GitHub personal access / app token',
    category: 'secret',
    severity: 'critical',
    pattern: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,})\b/g,
    captureGroup: 1,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    category: 'secret',
    severity: 'high',
    pattern: /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g,
    captureGroup: 1,
  },
  {
    id: 'openai-key',
    description: 'OpenAI / Anthropic style API key',
    category: 'secret',
    severity: 'critical',
    pattern: /\b((?:sk|sk-proj|sk-ant)-[A-Za-z0-9_-]{20,})\b/g,
    captureGroup: 1,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    category: 'secret',
    severity: 'high',
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    captureGroup: 1,
  },
  {
    id: 'azure-storage-connection-string',
    description: 'Azure storage connection string',
    category: 'secret',
    severity: 'critical',
    pattern: /DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=([A-Za-z0-9+/=]{40,})/g,
    captureGroup: 1,
  },
  {
    id: 'sql-connection-string',
    description: 'Database connection string with an inline password',
    category: 'secret',
    severity: 'critical',
    pattern: /(?:Server|Data Source|Host)\s*=[^;]+;[^\n]*?(?:Password|Pwd)\s*=\s*([^;"'\s]{6,})/gi,
    captureGroup: 1,
  },
  {
    id: 'url-embedded-credentials',
    description: 'Credentials embedded in a URL',
    category: 'secret',
    severity: 'high',
    pattern:
      /\b(?:postgres|postgresql|mysql|mongodb|redis|amqp|https?):\/\/[^\s:/@]+:([^\s@/]{6,})@/gi,
    captureGroup: 1,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    category: 'secret',
    severity: 'high',
    pattern: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    captureGroup: 1,
  },
  {
    id: 'stripe-key',
    description: 'Stripe secret key',
    category: 'secret',
    severity: 'critical',
    pattern: /\b((?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,})\b/g,
    captureGroup: 1,
  },
  {
    id: 'npm-token',
    description: 'npm access token',
    category: 'secret',
    severity: 'high',
    pattern: /\b(npm_[A-Za-z0-9]{36})\b/g,
    captureGroup: 1,
  },
  {
    id: 'generic-assigned-secret',
    description: 'High-entropy value assigned to a secret-shaped identifier',
    category: 'secret',
    severity: 'high',
    pattern:
      /\b(?:api[_-]?key|apikey|secret|password|passwd|token|credential|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi,
    captureGroup: 1,
    minEntropy: 3.5,
  },
];

/**
 * PII rules. §10 Layer 2 singles out test fixtures as "a notorious reservoir of real customer
 * data", so these deliberately run *harder* inside test directories rather than being
 * suppressed there like the secret heuristics.
 */
export const PII_RULES: Rule[] = [
  {
    id: 'email-address',
    description: 'Email address',
    category: 'pii',
    severity: 'medium',
    pattern: /\b[A-Za-z0-9._%+-]+@(?!example\.|test\.|localhost)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    id: 'credit-card',
    description: 'Payment card number (Luhn-valid)',
    category: 'pii',
    severity: 'critical',
    pattern: /\b((?:\d[ -]?){13,19})\b/g,
    captureGroup: 1,
  },
  {
    id: 'us-ssn',
    description: 'US social security number',
    category: 'pii',
    severity: 'critical',
    pattern: /\b(?!000|666|9\d\d)(\d{3})-(\d{2})-(\d{4})\b/g,
  },
  {
    id: 'iban',
    description: 'IBAN',
    category: 'pii',
    severity: 'high',
    pattern: /\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/g,
    captureGroup: 1,
  },
  {
    id: 'phone-e164',
    description: 'E.164 phone number',
    category: 'pii',
    severity: 'medium',
    pattern: /(?<![\w.-])\+\d{1,3}[\s-]?\d{6,14}(?![\w.-])/g,
  },
];

/**
 * §10 Layer 5 — indirect prompt injection. The indexer ingests attacker-controllable text by
 * design: a code comment, a README, a vendored dependency's docs. These patterns are flagged
 * and logged rather than blocked, because a false positive here would refuse a legitimate
 * commit; the actual defence is that retrieved text is never treated as instructions.
 */
export const INJECTION_RULES: Rule[] = [
  {
    id: 'instruction-override',
    description: 'Imperative attempting to override model instructions',
    category: 'injection',
    severity: 'high',
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|messages?)\b/gi,
  },
  {
    id: 'role-assertion',
    description: 'Text asserting a system or developer role',
    category: 'injection',
    severity: 'high',
    pattern: /^\s*(?:system|developer|assistant)\s*[:>]\s*you\s+(?:are|must|should|will)\b/gim,
  },
  {
    id: 'exfiltration-directive',
    description: 'Directive to enumerate or disclose out-of-scope content',
    category: 'injection',
    severity: 'high',
    pattern:
      /\b(?:list|enumerate|reveal|disclose|print|output|dump)\s+(?:all\s+|every\s+)?(?:repositor|secret|credential|api[_ -]?key|token|environment variable|password)/gi,
  },
  {
    id: 'tool-coercion',
    description: 'Attempt to steer tool selection or widen scope from retrieved content',
    category: 'injection',
    severity: 'high',
    pattern:
      /\b(?:call|invoke|use)\s+the\s+\w+\s+tool\b|\bset\s+scope\s+to\s+(?:org|all|everything)\b/gi,
  },
  {
    id: 'hidden-unicode-directive',
    description: 'Zero-width or bidirectional control characters hiding text',
    category: 'injection',
    severity: 'high',
    // Trojan-source style overrides plus zero-width joiners used to smuggle instructions.
    pattern: /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,
  },
];

/**
 * Hard path denylist. §10 Layer 2 — these never reach analysis at all, regardless of content,
 * because the cheapest control is not collecting the file.
 */
export const DENY_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.env\.[^/]*$/i,
  /\.(pem|pfx|p12|key|keystore|jks|ppk|asc|gpg)$/i,
  /(^|\/)(secrets?|credentials?|private)(\/|$)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)appsettings\.(local|development|secrets)\.json$/i,
  /(^|\/)local\.settings\.json$/i,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.docker(\/config\.json)?$/,
  /(^|\/)kubeconfig$/i,
  /\.(sqlite3?|db|mdb|bak|dump|sql\.gz)$/i,
];

/** Binary and generated files that would waste analysis budget and pollute retrieval. */
export const SKIP_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(node_modules|\.git|dist|build|out|bin|obj|target|\.next|\.turbo|coverage|__pycache__|\.venv|venv)(\/|$)/,
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|mp4|mov|avi|webm|mp3|wav|ogg|woff2?|ttf|eot|otf)$/i,
  /\.(zip|tar|gz|bz2|xz|7z|rar|jar|war|nupkg|whl|dll|exe|so|dylib|pdb|wasm)$/i,
  /\.(lock|lockb)$/i,
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|poetry\.lock|Cargo\.lock|packages\.lock\.json)$/,
  /\.min\.(js|css)$/i,
  /\.map$/i,
];

export const ALL_RULES: Rule[] = [...SECRET_RULES, ...PII_RULES, ...INJECTION_RULES];

export function shouldSuppressInTests(rule: Rule, path: string): boolean {
  // PII rules stay armed in test directories — that is precisely where real customer data hides.
  if (rule.category === 'pii') return false;
  if (rule.id === 'generic-assigned-secret' || rule.id === 'jwt') {
    return TEST_FIXTURE_PATHS.some((p) => p.test(path));
  }
  return false;
}
