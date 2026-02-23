/**
 * Tests for the secrets-detector service
 */

import { describe, it, expect } from 'vitest';
import {
	detectSecrets,
	sanitizeContent,
	isSafeToStore,
	getSecretsSummary,
} from '../secrets-detector.js';

// ── detectSecrets ────────────────────────────────────────────────────────────

describe('detectSecrets', () => {
	it('returns found:false for clean content', () => {
		const result = detectSecrets('This is a normal piece of text about TypeScript.');
		expect(result.found).toBe(false);
		expect(result.secrets).toHaveLength(0);
		expect(result.sanitized).toBeUndefined();
	});

	it('detects OpenAI API key (high confidence)', () => {
		const key = 'sk-' + 'a'.repeat(48);
		const result = detectSecrets(`My config: OPENAI_KEY=${key} end`);
		expect(result.found).toBe(true);
		const openai = result.secrets.find((s) => s.type === 'openai_key');
		expect(openai).toBeDefined();
		expect(openai?.confidence).toBe('high');
	});

	it('detects JWT token (high confidence)', () => {
		// Minimal structurally-valid JWT (header.payload.signature), NOT wrapped in Bearer
		// so the jwt_token pattern wins deduplication over bearer_token
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
		const result = detectSecrets(`token=${jwt}`);
		expect(result.found).toBe(true);
		const jwtSecret = result.secrets.find((s) => s.type === 'jwt_token');
		expect(jwtSecret).toBeDefined();
		expect(jwtSecret?.confidence).toBe('high');
	});

	it('detects database URL with credentials (high confidence)', () => {
		const result = detectSecrets('Connect using postgres://admin:s3cret@db.example.com/mydb');
		expect(result.found).toBe(true);
		const dbUrl = result.secrets.find((s) => s.type === 'database_url');
		expect(dbUrl).toBeDefined();
		expect(dbUrl?.confidence).toBe('high');
	});

	it('detects AWS access key (high confidence)', () => {
		const result = detectSecrets('aws_access_key_id = AKIAIOSFODNN7EXAMPLE');
		expect(result.found).toBe(true);
		const aws = result.secrets.find((s) => s.type === 'aws_credentials');
		expect(aws).toBeDefined();
		expect(aws?.confidence).toBe('high');
	});

	it('detects Stripe secret key (high confidence)', () => {
		const result = detectSecrets(`stripe_key=sk_live_${'x'.repeat(24)}`);
		expect(result.found).toBe(true);
		const stripe = result.secrets.find((s) => s.type === 'stripe_key');
		expect(stripe).toBeDefined();
		expect(stripe?.confidence).toBe('high');
	});

	it('detects GitHub token (high confidence)', () => {
		const result = detectSecrets(`token: ghp_${'A'.repeat(36)}`);
		expect(result.found).toBe(true);
		const gh = result.secrets.find((s) => s.type === 'github_token');
		expect(gh).toBeDefined();
		expect(gh?.confidence).toBe('high');
	});

	it('detects email address (low confidence)', () => {
		const result = detectSecrets('Contact me at user@example.com for details.');
		expect(result.found).toBe(true);
		const email = result.secrets.find((s) => s.type === 'email');
		expect(email).toBeDefined();
		expect(email?.confidence).toBe('low');
	});

	it('deduplicates overlapping matches, keeping highest confidence', () => {
		// Both openai_key (high) and a generic api_key (medium) pattern can match the same region.
		// The higher-confidence detection should replace the lower one.
		const key = 'sk-' + 'z'.repeat(48);
		// Wrap in a generic api_key pattern so both patterns try to match
		const content = `"api_key": "${key}"`;
		const result = detectSecrets(content);
		// No two detected secrets should overlap
		for (let i = 0; i < result.secrets.length; i++) {
			for (let j = i + 1; j < result.secrets.length; j++) {
				const a = result.secrets[i];
				const b = result.secrets[j];
				const overlap =
					(b.location.start >= a.location.start && b.location.start <= a.location.end) ||
          (b.location.end >= a.location.start && b.location.end <= a.location.end);
				expect(overlap).toBe(false);
			}
		}
		// The openai_key (high confidence) should win over any overlapping medium-confidence match
		const highSecret = result.secrets.find((s) => s.type === 'openai_key');
		expect(highSecret).toBeDefined();
	});

	it('does NOT flag git commit SHA as a secret', () => {
		// A 40-character hex string (typical git SHA) should not trigger a detection
		const sha = 'a'.repeat(40); // 40 lowercase hex chars
		const result = detectSecrets(`Merged commit ${sha} into main`);
		// No detections expected for a bare git SHA
		const hexDetection = result.secrets.filter(
			(s) => s.type === 'api_key' && s.pattern.toLowerCase().includes('hex'),
		);
		expect(hexDetection).toHaveLength(0);
	});

	it('includes location information in detections', () => {
		const key = 'sk-' + 'b'.repeat(48);
		const content = `prefix ${key} suffix`;
		const result = detectSecrets(content);
		expect(result.found).toBe(true);
		const [secret] = result.secrets;
		expect(secret.location.start).toBeGreaterThanOrEqual(0);
		expect(secret.location.end).toBeGreaterThan(secret.location.start);
		// The matched region should correspond to the key
		expect(content.slice(secret.location.start, secret.location.end)).toContain('sk-');
	});

	it('includes sanitized version when secrets are found', () => {
		const key = 'sk-' + 'c'.repeat(48);
		const result = detectSecrets(`key=${key}`);
		expect(result.sanitized).toBeDefined();
		expect(result.sanitized).not.toContain(key);
		expect(result.sanitized).toContain('[REDACTED_');
	});

	it('does NOT set sanitized when no secrets are found', () => {
		const result = detectSecrets('clean content here');
		expect(result.sanitized).toBeUndefined();
	});
});

// ── Credit card Luhn check ───────────────────────────────────────────────────

describe('detectSecrets — credit card Luhn validation', () => {
	it('detects a valid Visa card number (passes Luhn)', () => {
		// 4532015112830366 is a known-valid Visa test number
		const result = detectSecrets('card: 4532015112830366 end');
		const cc = result.secrets.find((s) => s.type === 'credit_card');
		expect(cc).toBeDefined();
	});

	it('does NOT detect an invalid card number (fails Luhn)', () => {
		// 4532015112830367 — last digit off by one, fails Luhn
		const result = detectSecrets('card: 4532015112830367 end');
		const cc = result.secrets.find((s) => s.type === 'credit_card');
		expect(cc).toBeUndefined();
	});

	it('detects a valid Mastercard number (passes Luhn)', () => {
		// 5425233430109903 is a known-valid Mastercard test number
		const result = detectSecrets('pay with 5425233430109903');
		const cc = result.secrets.find((s) => s.type === 'credit_card');
		expect(cc).toBeDefined();
	});
});

// ── sanitizeContent ──────────────────────────────────────────────────────────

describe('sanitizeContent', () => {
	it('replaces detected secrets with [REDACTED_TYPE] placeholders', () => {
		const key = 'sk-' + 'd'.repeat(48);
		const content = `config: ${key} end`;
		const result = sanitizeContent(content);
		expect(result).not.toContain(key);
		expect(result).toContain('[REDACTED_OPENAI_KEY]');
	});

	it('returns the original content unchanged when no secrets are found', () => {
		const content = 'This text has nothing sensitive in it.';
		expect(sanitizeContent(content)).toBe(content);
	});

	it('does NOT cause a stack overflow (mutual recursion guard)', () => {
		// If sanitizeContent → detectSecrets → sanitizeContent is not broken, this throws
		const key = 'sk-' + 'e'.repeat(48);
		expect(() => sanitizeContent(`key=${key}`)).not.toThrow();
	});

	it('handles multiple secrets in the same content', () => {
		const key = 'sk-' + 'f'.repeat(48);
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
		const content = `openai=${key} token=${jwt}`;
		const result = sanitizeContent(content);
		expect(result).not.toContain(key);
		expect(result).not.toContain(jwt);
		expect(result).toContain('[REDACTED_');
	});
});

// ── isSafeToStore ────────────────────────────────────────────────────────────

describe('isSafeToStore', () => {
	it('returns safe:true for clean content', () => {
		const result = isSafeToStore('The quick brown fox jumps over the lazy dog.');
		expect(result.safe).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it('returns safe:false for high-confidence secrets', () => {
		const key = 'sk-' + 'g'.repeat(48);
		const result = isSafeToStore(`api_key=${key}`);
		expect(result.safe).toBe(false);
		expect(result.reason).toMatch(/high-confidence/i);
		expect(result.secrets?.every((s) => s.confidence === 'high')).toBe(true);
	});

	it('returns safe:false for 5+ medium-confidence secrets', () => {
		// Five distinct medium-confidence patterns in one string
		const content = [
			'"api_key": "abcdefghijklmnopqrst"',         // Generic API key (medium)
			'"access_token": "abcdefghijklmnopqrstu"',   // OAuth token (medium)
			'MY_SERVICE_SECRET=supersecretvalue12345',    // Generic env var (medium)
			'OTHER_TOKEN=anothersecretvalue9876543',      // Generic env var (medium)
			'"api_secret": "zyxwvutsrqponmlkjihg"',      // Generic API key (medium)
		].join(' ');
		const result = isSafeToStore(content);
		expect(result.safe).toBe(false);
		expect(result.reason).toMatch(/medium-confidence/i);
	});

	it('returns safe:true with warning for 1-4 medium-confidence secrets', () => {
		const content = '"api_key": "abcdefghijklmnopqrst"';
		const result = isSafeToStore(content);
		expect(result.safe).toBe(true);
		expect(result.reason).toBeDefined(); // Warning reason present
		expect(result.secrets).toBeDefined();
		expect(result.secrets!.length).toBeGreaterThan(0);
	});

	it('returns safe:true for low-confidence only (email)', () => {
		const result = isSafeToStore('Send results to admin@example.com');
		expect(result.safe).toBe(true);
	});
});

// ── getSecretsSummary ────────────────────────────────────────────────────────

describe('getSecretsSummary', () => {
	it('returns "No secrets detected" for empty detection', () => {
		const detection = { found: false, secrets: [] };
		expect(getSecretsSummary(detection)).toBe('No secrets detected');
	});

	it('returns a human-readable summary when secrets are found', () => {
		const key = 'sk-' + 'h'.repeat(48);
		const detection = detectSecrets(`key=${key}`);
		const summary = getSecretsSummary(detection);
		expect(summary).toMatch(/Detected:/i);
		expect(summary).toMatch(/high confidence/i);
	});
});

// ── Additional credit card patterns ──────────────────────────────────────────

describe('detectSecrets — additional credit card patterns', () => {
	it('detects a valid American Express card number (passes Luhn)', () => {
		// 378282246310005 is a known-valid Amex test number
		const result = detectSecrets('amex: 378282246310005 end');
		const cc = result.secrets.find((s) => s.type === 'credit_card');
		expect(cc).toBeDefined();
	});

	it('detects a valid Discover card number (passes Luhn)', () => {
		// 6011111111111117 is a known-valid Discover test number
		const result = detectSecrets('discover: 6011111111111117 end');
		const cc = result.secrets.find((s) => s.type === 'credit_card');
		expect(cc).toBeDefined();
	});

	it('does NOT detect an invalid Amex number (fails Luhn)', () => {
		// 378282246310006 — last digit off, fails Luhn
		const result = detectSecrets('bad amex: 378282246310006 end');
		const cc = result.secrets.find((s) => s.type === 'credit_card');
		expect(cc).toBeUndefined();
	});
});

// ── SSN boundary tests ────────────────────────────────────────────────────────

describe('detectSecrets — SSN patterns', () => {
	it('detects a properly-formatted SSN', () => {
		const result = detectSecrets('SSN: 123-45-6789');
		const ssn = result.secrets.find((s) => s.type === 'ssn');
		expect(ssn).toBeDefined();
	});

	it('does NOT detect SSN without word boundaries (prefix digit)', () => {
		// "0123-45-6789" — preceded by digit, no word boundary before first group
		const result = detectSecrets('bad: 0123-45-6789 end');
		const ssn = result.secrets.find((s) => s.type === 'ssn');
		expect(ssn).toBeUndefined();
	});

	it('does NOT detect SSN without word boundaries (suffix digit)', () => {
		// "123-45-67890" — followed by digit, no word boundary after last group
		const result = detectSecrets('bad: 123-45-67890 end');
		const ssn = result.secrets.find((s) => s.type === 'ssn');
		expect(ssn).toBeUndefined();
	});
});

// ── Password placeholder exclusions ──────────────────────────────────────────

describe('detectSecrets — password placeholder exclusions', () => {
	it('does NOT flag password=***** as a secret', () => {
		const result = detectSecrets('Set password=***** in your config');
		const pw = result.secrets.filter((s) => s.type === 'password' && s.confidence === 'low');
		expect(pw).toHaveLength(0);
	});

	it('does NOT flag password=<YOUR_PASSWORD> as a secret', () => {
		const result = detectSecrets('Use password=<YOUR_PASSWORD> here');
		const pw = result.secrets.filter((s) => s.type === 'password' && s.confidence === 'low');
		expect(pw).toHaveLength(0);
	});

	it('does NOT flag password=[PLACEHOLDER] as a secret', () => {
		const result = detectSecrets('Use password=[PLACEHOLDER] in config');
		const pw = result.secrets.filter((s) => s.type === 'password' && s.confidence === 'low');
		expect(pw).toHaveLength(0);
	});

	it('DOES flag password=actualpassword as a secret', () => {
		const result = detectSecrets('password=actualpassword here');
		const pw = result.secrets.filter((s) => s.type === 'password');
		expect(pw.length).toBeGreaterThan(0);
	});
});

// ── Medium-confidence threshold ───────────────────────────────────────────────

describe('isSafeToStore — medium-confidence threshold', () => {
	it('returns safe:false only when 5+ medium-confidence secrets are found', () => {
		// Five distinct medium-confidence patterns
		const content = [
			'"api_key": "abcdefghijklmnopqrst"',         // Generic API key (medium)
			'"access_token": "abcdefghijklmnopqrstu"',   // OAuth token (medium)
			'MY_SERVICE_SECRET=supersecretvalue12345',    // Generic env var (medium)
			'OTHER_SERVICE_TOKEN=anothersecretvalue9876', // Generic env var (medium)
			'"api_secret": "zyxwvutsrqponmlkjihg"',      // Generic API key (medium)
		].join(' ');
		const result = isSafeToStore(content);
		expect(result.safe).toBe(false);
		expect(result.reason).toMatch(/medium-confidence/i);
	});

	it('returns safe:true with warning for exactly 4 medium-confidence secrets', () => {
		const content = [
			'"api_key": "abcdefghijklmnopqrst"',
			'"access_token": "abcdefghijklmnopqrstu"',
			'MY_SERVICE_SECRET=supersecretvalue12345',
			'OTHER_SERVICE_TOKEN=anothersecretvalue9876',
		].join(' ');
		const result = isSafeToStore(content);
		expect(result.safe).toBe(true);
	});

	it('returns safe:true for legitimate docs with multiple emails', () => {
		const content = 'Contact alice@example.com, bob@example.com, carol@example.com for support.';
		const result = isSafeToStore(content);
		// Three emails are low-confidence; should not block
		expect(result.safe).toBe(true);
	});
});
