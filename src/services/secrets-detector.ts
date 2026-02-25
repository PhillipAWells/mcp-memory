/**
 * Secrets and sensitive information detector
 *
 * Detects various types of secrets and sensitive data to prevent
 * accidental storage in semantic memory.
 */

export interface SecretDetection {
	found: boolean;
	secrets: DetectedSecret[];
	sanitized?: string;
}

export interface DetectedSecret {
	type: SecretType;
	pattern: string;
	location: {
		start: number;
		end: number;
	};
	context: string; // Surrounding context (redacted)
	confidence: 'high' | 'medium' | 'low';
}

export type SecretType =
  | 'api_key'
  | 'bearer_token'
  | 'jwt_token'
  | 'oauth_token'
  | 'password'
  | 'private_key'
  | 'ssh_key'
  | 'database_url'
  | 'aws_credentials'
  | 'gcp_credentials'
  | 'azure_credentials'
  | 'github_token'
  | 'slack_token'
  | 'stripe_key'
  | 'openai_key'
  | 'email'
  | 'phone_number'
  | 'credit_card'
  | 'ssn'
  | 'generic_secret';

interface SecretPattern {
	type: SecretType;
	regex: RegExp;
	confidence: 'high' | 'medium' | 'low';
	description: string;
}

/**
 * Luhn algorithm check for credit card numbers.
 * Returns true if the number passes the Luhn check.
 */
/** Minimum digits for a valid credit card number. */
const LUHN_MIN_DIGITS = 13;
/** Luhn algorithm: a doubled digit above this needs subtraction. */
const LUHN_DOUBLE_THRESHOLD = 9;
/** Luhn modulo check value. */
const LUHN_MODULO = 10;
/** Context characters shown before/after a detected secret. */
const SECRET_CONTEXT_CHARS = 10;
/**
 * Number of distinct medium-confidence detections required to block storage.
 *
 * Set to 5 (rather than 3) to reduce false positives from legitimate content
 * that contains multiple low-risk signals such as email addresses, phone
 * numbers, or generic config key names without actual secret values.
 */
const MEDIUM_CONFIDENCE_BLOCK_THRESHOLD = 3;
/** Confidence ordering for deduplication. */
const CONFIDENCE_ORDER = { high: 3, medium: 2, low: 1 } as const;

function luhnCheck(numStr: string): boolean {
	const digits = numStr.replace(/\D/g, '');
	if (digits.length < LUHN_MIN_DIGITS) return false;
	let sum = 0;
	let isEven = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let digit = parseInt(digits[i], 10);
		if (isEven) {
			digit *= 2;
			if (digit > LUHN_DOUBLE_THRESHOLD) digit -= LUHN_DOUBLE_THRESHOLD;
		}
		sum += digit;
		isEven = !isEven;
	}
	return sum % LUHN_MODULO === 0;
}

/**
 * Secret detection patterns
 * Ordered by specificity (most specific first)
 */
const SECRET_PATTERNS: SecretPattern[] = [
	// API Keys - Specific providers
	{
		type: 'openai_key',
		regex: /sk-[a-zA-Z0-9]{48}/g,
		confidence: 'high',
		description: 'OpenAI API key',
	},
	{
		type: 'stripe_key',
		regex: /sk_(live|test)_[a-zA-Z0-9]{24,}/g,
		confidence: 'high',
		description: 'Stripe secret key',
	},
	{
		type: 'github_token',
		regex: /gh[pousr]_[a-zA-Z0-9]{36,}/g,
		confidence: 'high',
		description: 'GitHub token',
	},
	{
		type: 'slack_token',
		regex: /xox[baprs]-[a-zA-Z0-9-]{10,}/g,
		confidence: 'high',
		description: 'Slack token',
	},

	// AWS
	{
		type: 'aws_credentials',
		regex: /AKIA[0-9A-Z]{16}/g,
		confidence: 'high',
		description: 'AWS access key',
	},
	{
		type: 'aws_credentials',
		regex: /aws_secret_access_key\s*=\s*[a-zA-Z0-9/+=]{40}/gi,
		confidence: 'high',
		description: 'AWS secret access key',
	},

	// GCP
	{
		type: 'gcp_credentials',
		regex: /"private_key":\s*"-----BEGIN PRIVATE KEY-----[^"]+-----END PRIVATE KEY-----"/g,
		confidence: 'high',
		description: 'GCP service account key',
	},

	// Azure
	{
		type: 'azure_credentials',
		regex: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[a-zA-Z0-9+/=]{88}/g,
		confidence: 'high',
		description: 'Azure storage connection string',
	},

	// JWT tokens
	{
		type: 'jwt_token',
		regex: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
		confidence: 'high',
		description: 'JWT token',
	},

	// Bearer tokens
	{
		type: 'bearer_token',
		regex: /Bearer\s+[a-zA-Z0-9_.=-]+/gi,
		confidence: 'high',
		description: 'Bearer token',
	},

	// Private keys
	{
		type: 'private_key',
		regex: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]+?-----END (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
		confidence: 'high',
		description: 'Private key (PEM format)',
	},
	{
		type: 'ssh_key',
		regex: /ssh-(rsa|dss|ed25519)\s+[A-Za-z0-9+/=]{100,}/g,
		confidence: 'high',
		description: 'SSH public key',
	},

	// Database URLs with credentials
	{
		type: 'database_url',
		regex: /(postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^\s]+/gi,
		confidence: 'high',
		description: 'Database URL with credentials',
	},

	// Generic API keys (common patterns)
	{
		type: 'api_key',
		regex: /['"](api[_-]?key|apikey|api[_-]?secret)['"]\s*[:=]\s*['"][a-zA-Z0-9_-]{20,}['"]/gi,
		confidence: 'medium',
		description: 'Generic API key',
	},

	// Passwords
	{
		type: 'password',
		regex: /['"](password|passwd|pwd)['"]\s*[:=]\s*['"][^'"]{8,}['"]/gi,
		confidence: 'medium',
		description: 'Password in assignment',
	},
	{
		type: 'password',
		// Excludes common placeholder patterns: ***, <...>, [...], xxx-style masks
		regex: /password\s*=\s*(?!\*{3,}|<[^>]+>|\[[^\]]+\]|x{3,})[^\s&]{8,}/gi,
		confidence: 'low',
		description: 'Password in URL or config',
	},

	// OAuth tokens
	{
		type: 'oauth_token',
		regex: /['"](access_token|refresh_token|oauth_token)['"]\s*[:=]\s*['"][a-zA-Z0-9_.-]{20,}['"]/gi,
		confidence: 'medium',
		description: 'OAuth token',
	},

	// Credit cards — BIN-specific patterns, validated with Luhn algorithm
	// (Luhn check applied in detectSecrets to eliminate false positives)
	{
		type: 'credit_card',
		regex: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
		confidence: 'medium',
		description: 'Credit card number',
	},

	// Social Security Numbers (US)
	{
		type: 'ssn',
		regex: /\b\d{3}-\d{2}-\d{4}\b/g,
		confidence: 'medium',
		description: 'Social Security Number',
	},

	// Email addresses (PII)
	{
		type: 'email',
		regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
		confidence: 'low',
		description: 'Email address',
	},

	// Phone numbers (basic patterns)
	{
		type: 'phone_number',
		regex: /\b(\+\d{1,3}[- ]?)?\(?\d{3}\)?[- ]?\d{3}[- ]?\d{4}\b/g,
		confidence: 'low',
		description: 'Phone number',
	},

	// Generic secrets (environment variable pattern)
	{
		type: 'generic_secret',
		regex: /[A-Z_]{3,}_(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)=[^\s]{8,}/g,
		confidence: 'medium',
		description: 'Generic secret in environment variable format',
	},
];

/**
 * Internal helper: replace detected secrets in content with redaction placeholders.
 * Operates end-to-start to preserve indices during replacement.
 * Does NOT call detectSecrets — avoids mutual recursion.
 */
function applySanitization(content: string, secrets: DetectedSecret[]): string {
	let sanitized = content;
	const sorted = [...secrets].sort((a, b) => b.location.start - a.location.start);
	for (const secret of sorted) {
		const before = sanitized.slice(0, secret.location.start);
		const after = sanitized.slice(secret.location.end);
		const placeholder = `[REDACTED_${secret.type.toUpperCase()}]`;
		sanitized = before + placeholder + after;
	}
	return sanitized;
}

/**
 * Detect secrets and sensitive information in content
 */
export function detectSecrets(content: string): SecretDetection {
	const secrets: DetectedSecret[] = [];

	for (const pattern of SECRET_PATTERNS) {
		const matches = content.matchAll(pattern.regex);

		for (const match of matches) {
			if (match.index === undefined) continue;

			// For credit card matches, apply Luhn validation to eliminate false positives
			if (pattern.type === 'credit_card' && !luhnCheck(match[0])) {
				continue;
			}

			// Extract context (SECRET_CONTEXT_CHARS chars before and after, redacted)
			const start = Math.max(0, match.index - SECRET_CONTEXT_CHARS);
			const end = Math.min(content.length, match.index + match[0].length + SECRET_CONTEXT_CHARS);
			const contextBefore = content.slice(start, match.index);
			const contextAfter = content.slice(
				match.index + match[0].length,
				end,
			);
			const redactedMatch = '[REDACTED]';

			secrets.push({
				type: pattern.type,
				pattern: pattern.description,
				location: {
					start: match.index,
					end: match.index + match[0].length,
				},
				context: `...${contextBefore}${redactedMatch}${contextAfter}...`,
				confidence: pattern.confidence,
			});
		}
	}

	// Sort by location
	secrets.sort((a, b) => a.location.start - b.location.start);

	// Deduplicate overlapping secrets (keep highest confidence)
	const deduplicated: DetectedSecret[] = [];
	for (const secret of secrets) {
		const overlapping = deduplicated.find(
			(existing) =>
				(secret.location.start >= existing.location.start &&
          secret.location.start <= existing.location.end) ||
        (secret.location.end >= existing.location.start &&
          secret.location.end <= existing.location.end),
		);

		if (!overlapping) {
			deduplicated.push(secret);
		} else {
			// Replace if higher confidence
			if (
				CONFIDENCE_ORDER[secret.confidence] >
        CONFIDENCE_ORDER[overlapping.confidence]
			) {
				const index = deduplicated.indexOf(overlapping);
				deduplicated[index] = secret;
			}
		}
	}

	// Compute sanitized version without calling sanitizeContent (avoids mutual recursion)
	const sanitized = deduplicated.length > 0
		? applySanitization(content, deduplicated)
		: undefined;

	return {
		found: deduplicated.length > 0,
		secrets: deduplicated,
		sanitized,
	};
}

/**
 * Sanitize content by replacing detected secrets with placeholders
 */
export function sanitizeContent(content: string): string {
	const detection = detectSecrets(content);
	return detection.sanitized ?? content;
}

/**
 * Check if content is safe to store (no high-confidence secrets)
 */
export function isSafeToStore(content: string): {
	safe: boolean;
	reason?: string;
	secrets?: DetectedSecret[];
} {
	const detection = detectSecrets(content);

	if (!detection.found) {
		return { safe: true };
	}

	// Check for high-confidence secrets
	const highConfidence = detection.secrets.filter(
		(s) => s.confidence === 'high',
	);

	if (highConfidence.length > 0) {
		return {
			safe: false,
			reason: `Found ${highConfidence.length} high-confidence secret(s): ${highConfidence.map((s) => s.pattern).join(', ')}`,
			secrets: highConfidence,
		};
	}

	// Check for multiple medium-confidence secrets
	const mediumConfidence = detection.secrets.filter(
		(s) => s.confidence === 'medium',
	);

	if (mediumConfidence.length >= MEDIUM_CONFIDENCE_BLOCK_THRESHOLD) {
		return {
			safe: false,
			reason: `Found ${mediumConfidence.length} medium-confidence secret(s): ${mediumConfidence.map((s) => s.pattern).join(', ')}`,
			secrets: mediumConfidence,
		};
	}

	// Low confidence or few medium confidence - safe with warning
	return {
		safe: true,
		reason: `Found ${detection.secrets.length} potential secret(s) with low/medium confidence`,
		secrets: detection.secrets,
	};
}

/**
 * Get a user-friendly summary of detected secrets
 */
export function getSecretsSummary(detection: SecretDetection): string {
	if (!detection.found) {
		return 'No secrets detected';
	}

	const byType = new Map<SecretType, number>();
	for (const secret of detection.secrets) {
		byType.set(secret.type, (byType.get(secret.type) ?? 0) + 1);
	}

	const summary = Array.from(byType.entries())
		.map(([type, count]) => `${count} ${type.replace(/_/g, ' ')}(s)`)
		.join(', ');

	const highConfidence = detection.secrets.filter(
		(s) => s.confidence === 'high',
	).length;

	return `Detected: ${summary} (${highConfidence} high confidence)`;
}
