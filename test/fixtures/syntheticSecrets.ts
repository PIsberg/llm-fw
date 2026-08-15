/**
 * Secret-shaped strings for tests, assembled at runtime rather than written
 * out as literals.
 *
 * None of these are credentials. They are invented, and they exist only so the
 * DLP detectors have something to detect. They are still built by
 * concatenation, because a complete AWS-key-shaped literal anywhere in the
 * repository trips GitHub push protection and the push is rejected outright.
 *
 * That constraint is a direct consequence of ruleset 2026.08.8 exempting
 * vendor-documented example credentials. Before it, the suite could simply use
 * AWS's own AKIAIOSFODNN7EXAMPLE: secret scanners allowlist the documented
 * examples, which is precisely why it was the fixture. Now that llm-fw treats
 * those as non-credentials, a fixture that must be DETECTED can no longer
 * contain the EXAMPLE marker — so it necessarily looks real, and has to be
 * assembled to get past push protection.
 *
 * Keep it that way. Inlining any of these as a single literal will block the
 * next push for everyone.
 */

/** Long-term AWS access key id shape (AKIA + 16). Must be DETECTED. */
export const SYNTHETIC_AWS_KEY = 'AKIA' + '4T7WQ2XKPLM9ZC3B'

/** Temporary/STS access key id shape (ASIA + 16). Must be DETECTED. */
export const SYNTHETIC_AWS_STS_KEY = 'ASIA' + '4T7WQ2XKPLM9ZC3B'

/** 40-char secret access key shape. Must be DETECTED. */
export const SYNTHETIC_AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/' + 'bPxRfiCYzQ8vN2mK4t'

/**
 * A key containing EXAMPLE in the middle rather than as a suffix. Must still
 * be DETECTED — the exemption is the documented `…EXAMPLE` suffix convention,
 * not the substring appearing anywhere.
 */
export const SYNTHETIC_AWS_KEY_EXAMPLE_MIDDLE = 'AKIA' + 'EXAMPLE7DNNFOSOI'
