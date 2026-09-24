// Shared pattern list for privacy-scan.js and scripts/release-check.js.
//
// Only generic, reusable patterns live here. Anything specific to one person's
// machine or identity (a username, a workspace path, a portfolio slug, ...)
// must NOT be hardcoded in this repo — that would defeat the point of the
// scanner. Instead, supply it at run time via:
//
//   - env var BOSSMATE_PRIVATE_PATTERNS: comma- or newline-separated regex
//     source strings (case-insensitive), e.g.
//       BOSSMATE_PRIVATE_PATTERNS="my-username,C:\\\\Users\\\\myname"
//   - an untracked file .privacy-patterns.local at the repo root, one regex
//     source string per line (blank lines and lines starting with # are
//     skipped)
const fs = require('fs');
const path = require('path');

const BASE_PATTERNS = [
  ['windows-user-path', /[A-Z]:\\Users\\[^\\\s]+/i],
  ['phone-number', /(?:\+?86[-\s]?)?1[3-9]\d{9}/],
  ['id-card-number', /\b\d{17}[\dXx]\b/],
  ['email-address', /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i],
  ['cookie-header', /\bcookie\s*[:=]\s*[^\s'";]{20,}/i],
  ['bearer-token', /\b(?:bearer|api[_-]?key|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{16,}/i],
];

function loadExtraPatterns(root) {
  const extra = [];

  const fromEnv = process.env.BOSSMATE_PRIVATE_PATTERNS;
  if (fromEnv) {
    for (const raw of fromEnv.split(/[,\n]/).map(s => s.trim()).filter(Boolean)) {
      extra.push(toPattern(raw, 'env'));
    }
  }

  const localFile = path.join(root, '.privacy-patterns.local');
  if (fs.existsSync(localFile)) {
    const lines = fs.readFileSync(localFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) continue;
      extra.push(toPattern(raw, 'local-file'));
    }
  }

  return extra;
}

function toPattern(source, origin) {
  try {
    return [`private-pattern (${origin})`, new RegExp(source, 'i')];
  } catch {
    // Not a valid regex; fall back to a literal substring match.
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [`private-pattern (${origin})`, new RegExp(escaped, 'i')];
  }
}

function getPatterns(root) {
  return [...BASE_PATTERNS, ...loadExtraPatterns(root)];
}

module.exports = { BASE_PATTERNS, getPatterns, loadExtraPatterns };
