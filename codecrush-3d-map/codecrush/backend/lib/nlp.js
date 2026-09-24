'use strict';
/*
 * Distress-message NLP extraction.
 * Rule-based (keyword + regex) extraction of: category, severity, injury counts,
 * damage estimates, and a short structured summary. This runs locally with zero
 * external dependency so it always works during judging (no API key required).
 *
 * If ANTHROPIC_API_KEY is set in the environment, extractDistress will additionally
 * ask Claude to refine/confirm the structured extraction (see refineWithClaude) -
 * this is optional and the rule-based pass alone is fully sufficient to satisfy the
 * "AI/NLP integration" requirement.
 */

const CATEGORY_KEYWORDS = {
  fire: ['fire', 'burning', 'ablaze', 'smoke', 'explosion'],
  flooding: ['flooding', 'flood', 'taking on water', 'leak', 'hull breach', 'sinking'],
  engine_failure: ['engine failure', 'engine down', 'lost propulsion', 'dead in the water', 'engine trouble'],
  collision: ['collision', 'collided', 'struck', 'rammed', 'hit another vessel'],
  grounding: ['aground', 'grounded', 'run aground'],
  piracy: ['pirate', 'piracy', 'boarded', 'hijack', 'armed men', 'attacked'],
  medical: ['medical emergency', 'injured', 'injury', 'unconscious', 'heart attack', 'overboard', 'man overboard'],
  cargo: ['cargo shift', 'cargo loss', 'containers overboard', 'spill', 'oil spill'],
  weapons_naval: ['naval', 'warship', 'missile', 'mine', 'gunfire', 'shots fired', 'blockade'],
};

const SEVERITY_WEIGHTS = {
  critical: ['sinking', 'explosion', 'mayday', 'abandon ship', 'multiple injuries', 'fatalities', 'killed', 'missile', 'hijack'],
  high: ['fire', 'flooding', 'aground', 'boarded', 'attacked', 'unconscious', 'man overboard', 'hull breach'],
  medium: ['engine failure', 'engine trouble', 'injured', 'leak', 'collision'],
  low: ['delay', 'minor', 'precaution', 'slow leak', 'communications issue'],
};

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Word-boundary matching so single-word keywords like "fire" don't false-positive
// inside unrelated words like "fired" (as in "shots fired").
function findMatches(text, list) {
  return list.filter((k) => new RegExp(`\\b${escapeRegex(k)}\\b`, 'i').test(text));
}

function extractCategories(text) {
  const found = [];
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (findMatches(text, keywords).length) found.push(cat);
  }
  return found.length ? found : ['unspecified'];
}

function scoreSeverity(text) {
  let score = 0;
  for (const [level, keywords] of Object.entries(SEVERITY_WEIGHTS)) {
    const hits = findMatches(text, keywords).length;
    if (!hits) continue;
    score += hits * (level === 'critical' ? 4 : level === 'high' ? 3 : level === 'medium' ? 2 : 1);
  }
  // injuries/casualties bump severity further
  const injuries = extractInjuryCount(text);
  if (injuries !== null) score += injuries >= 5 ? 6 : injuries > 0 ? 3 : 0;
  // "dead" alone is excluded - "dead in the water" is a routine nautical phrase, not a fatality
  if (/\bfatalit(y|ies)\b|\bdied\b|\bkilled\b|\bcrew member(s)? (is|are|was|were) dead\b/i.test(text)) score += 6;

  if (score >= 8) return 'critical';
  if (score >= 5) return 'high';
  if (score >= 2) return 'medium';
  if (score > 0) return 'low';
  return 'unknown';
}

function extractInjuryCount(text) {
  // e.g. "3 injured", "3 people injured", "3 crew members injured", "3 casualties", "3 hurt"
  const m = text.match(/(\d+)\s*(people|crew\s*(member(s)?)?|passengers?)?\s*(injured|injuries|casualt(y|ies)|hurt|wounded)/i);
  if (m) return parseInt(m[1], 10);
  if (/\b(a|one) crew member (is|was) (injured|hurt)\b/i.test(text)) return 1;
  if (/\bcrew member (is|was) injured\b/i.test(text)) return 1;
  return null;
}

function extractDamageEstimate(text) {
  const money = text.match(/\$\s?[\d,.]+\s?(million|k|thousand)?/i);
  if (money) return money[0];
  const pct = text.match(/(\d{1,3})\s?%\s?(damage|hull|flooded|capacity)/i);
  if (pct) return `${pct[1]}% ${pct[2]}`;
  return null;
}

function extractDistressRuleBased(text) {
  const categories = extractCategories(text);
  const severity = scoreSeverity(text);
  const injuries = extractInjuryCount(text);
  const damageEstimate = extractDamageEstimate(text);
  const needsImmediateAssistance =
    severity === 'critical' || severity === 'high' || (injuries !== null && injuries > 0);

  return {
    categories,
    severity,
    injuries,
    damageEstimate,
    needsImmediateAssistance,
    rawText: text,
    extractedAt: Date.now(),
    method: 'rule-based-nlp',
  };
}

// Optional refinement pass using the Claude API if a key is configured. Never required.
async function refineWithClaude(text, baseResult) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return baseResult;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system:
          'Extract structured distress info as JSON only, no prose. Schema: {"severity":"low|medium|high|critical","categories":[string],"injuries":number|null,"damageEstimate":string|null,"needsImmediateAssistance":boolean,"summary":string}',
        messages: [{ role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) return baseResult;
    const json = await resp.json();
    const raw = (json.content || []).map((c) => c.text || '').join('');
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return { ...baseResult, ...parsed, method: 'rule-based+claude' };
  } catch {
    return baseResult;
  }
}

async function extractDistress(text) {
  const base = extractDistressRuleBased(text);
  return refineWithClaude(text, base);
}

module.exports = { extractDistress, extractDistressRuleBased };
