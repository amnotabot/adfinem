const secretKeyFragments = [
    "password",
    "passwd",
    "pwd",
    "token",
    "authorization",
    "apikey",
    "api_key",
    "privatekey",
    "private_key",
    "jwt",
    "secret",
    "credential",
    "bearer",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "servicepassword",
    "apikey",
    "session",
    "cookie",
    "pin",
    "cvv",
    "cvc",
    "cvv2"
];
const cardKeyExact = new Set([
    "pan",
    "pans",
    "cardnumber",
    "cardnumbers",
    "cardno",
    "primaryaccountnumber",
    "primaryaccountnumbers"
]);
const REDACTED = "<redacted>";
export function redactSecrets(value) {
    return redact(value);
}
export function evidenceVisibilityMode() {
    return process.env.ADFINEM_EVIDENCE_VISIBILITY?.toLowerCase() === "redacted" ? "redacted" : "raw";
}
export function applyEvidenceVisibility(value, mode = evidenceVisibilityMode()) {
    return mode === "redacted" ? redactSecrets(value) : value;
}
/**
 * Heavier redaction intended for shared evidence artifacts.
 * Combines key-based redaction with inline PAN-pattern scrubbing on every string.
 */
export function redactEvidence(value) {
    return redactDeep(value, true);
}
export function maskInlinePans(text) {
    if (!text)
        return text;
    return text.replace(/(?<!\d)(\d[\d\s.-]{10,21}\d)(?!\d)/g, (match) => {
        const digits = match.replace(/\D+/g, "");
        if (digits.length < 12 || digits.length > 19)
            return match;
        if (!isLuhnValid(digits))
            return match;
        return `****${digits.slice(-4)}`;
    });
}
export function isLuhnValid(digits) {
    if (!/^\d+$/.test(digits))
        return false;
    let sum = 0;
    let alt = false;
    for (let index = digits.length - 1; index >= 0; index--) {
        let n = digits.charCodeAt(index) - 48;
        if (alt) {
            n *= 2;
            if (n > 9)
                n -= 9;
        }
        sum += n;
        alt = !alt;
    }
    return sum > 0 && sum % 10 === 0;
}
function redact(value) {
    return redactDeep(value, false);
}
function redactDeep(value, scrubStrings) {
    if (typeof value === "string")
        return scrubStrings ? maskInlinePans(value) : value;
    if (Array.isArray(value))
        return value.map((entry) => redactDeep(entry, scrubStrings));
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (secretKeyFragments.some((fragment) => normalized.includes(fragment))) {
            return [key, REDACTED];
        }
        if (cardKeyExact.has(normalized)) {
            return [key, maskCardLike(entry, scrubStrings)];
        }
        return [key, redactDeep(entry, scrubStrings)];
    }));
}
function maskCardLike(value, scrubStrings) {
    if (Array.isArray(value))
        return value.map((entry) => maskCardLike(entry, scrubStrings));
    if (typeof value === "string" || typeof value === "number") {
        return maskPan(String(value));
    }
    if (value && typeof value === "object") {
        return redactDeep(value, scrubStrings);
    }
    return value;
}
function maskPan(value) {
    const digits = value.replace(/\D+/g, "");
    if (digits.length < 12)
        return value;
    if (digits.length >= 12 && digits.length <= 19) {
        return `${digits.slice(0, 4)}${"*".repeat(Math.max(4, digits.length - 8))}${digits.slice(-4)}`;
    }
    const last4 = digits.slice(-4);
    return `****${last4}`;
}
