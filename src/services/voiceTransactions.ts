import type { Account } from '../hooks/useAccounts';
import type { Category } from '../hooks/useCategories';

const API_BASE_URL = (import.meta.env.VITE_PUSH_API_BASE_URL || '').replace(/\/$/, '');

export const VOICE_MAX_DURATION_MS = 2 * 60 * 1000;
export const VOICE_MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

const LEARNING_STORAGE_KEY = 'voice_learning_examples_v1';
const MAX_LEARNING_EXAMPLES = 300;

type TransactionType = 'income' | 'expense';

type TypeDetection = {
  type: TransactionType;
  explicit: boolean;
};

type CategoryMatch = {
  categoryName: string;
  subCategory: string;
  type: TransactionType;
  score: number;
};

type VoiceLearningExample = {
  text: string;
  type: TransactionType;
  category: string;
  subCategory: string;
  account: string;
  note: string;
  updatedAt: number;
};

export type VoiceDraftTransaction = {
  id: string;
  amount: number;
  type: TransactionType;
  category: string;
  subCategory: string;
  account: string;
  description: string;
  rawText: string;
  confidence: number;
};

type AiExtractionItem = {
  amount: number;
  type?: unknown;
  category?: unknown;
  subCategory?: unknown;
  account?: unknown;
  note?: unknown;
  sourceText?: unknown;
  confidence?: unknown;
};

const EXPENSE_HINTS = [
  'spent',
  'pay',
  'paid',
  'expense',
  'debit',
  'bought',
  'purchase',
  'kharch',
  'kharcha',
  'diya',
  'nikaal',
  'withdraw',
  'de diya',
  'खर्च',
  'दे दिया',
  'दिया',
];

const INCOME_HINTS = [
  'received',
  'got',
  'income',
  'credit',
  'credited',
  'refund',
  'salary',
  'bonus',
  'kamaya',
  'aaya',
  'mila',
  'deposit',
  'आया',
  'मिला',
  'क्रेडिट',
  'इनकम',
];

const CATEGORY_HINTS: Record<string, string[]> = {
  food: ['khana', 'food', 'meal', 'nashta', 'nasta', 'breakfast', 'lunch', 'dinner'],
  transport: ['transport', 'travel', 'cab', 'auto', 'taxi', 'uber', 'ola', 'airport', 'metro', 'bus'],
  shopping: ['shopping', 'amazon', 'flipkart', 'kapde', 'clothes', 'electronics', 'mall'],
  entertainment: ['movie', 'movies', 'game', 'event', 'netflix', 'ott'],
  bills: ['bill', 'electricity', 'water', 'internet', 'wifi', 'recharge'],
  health: ['health', 'doctor', 'medicine', 'hospital', 'fitness', 'gym', 'dawai'],
  salary: ['salary', 'stipend', 'paycheck'],
  investment: ['investment', 'stock', 'stocks', 'sip', 'mutual fund', 'crypto'],
  miscellaneous: ['misc', 'miscellaneous', 'other', 'others', 'baaki'],
  vices: ['sutta', 'alcohol', 'ganja', 'hash', 'cigarette', 'smoke', 'beer', 'vodka'],
};

const SUBCATEGORY_HINTS: Record<string, string[]> = {
  breakfast: ['breakfast', 'nashta', 'nasta'],
  lunch: ['lunch'],
  dinner: ['dinner'],
  airport: ['airport'],
  cab: ['cab', 'uber', 'ola', 'taxi'],
  auto: ['auto', 'rikshaw', 'rickshaw'],
  sutta: ['sutta', 'cigarette', 'smoke', 'ciggi'],
  alcohol: ['alcohol', 'beer', 'vodka', 'whisky', 'whiskey', 'daru'],
  ganja: ['ganja', 'weed'],
  hash: ['hash'],
};

const ACCOUNT_STOP_WORDS = new Set(['bank', 'card', 'account', 'upi', 'credit', 'debit']);
const NOTE_STOP_WORDS = new Set([
  'expense',
  'income',
  'spent',
  'paid',
  'received',
  'credit',
  'debit',
  'rupees',
  'rupee',
  'rs',
  'inr',
  'category',
  'subcategory',
  'account',
  'from',
  'via',
  'using',
  'for',
  'on',
  'then',
  'and',
  'phir',
  'aur',
  'entry',
  'transaction',
  'ka',
  'ki',
  'ke',
  'hai',
]);

const AMOUNT_REGEX_PATTERN =
  '(?:₹|rs\\.?|inr|rupees?|rupaye|रुपये|रुपया)?\\s*([0-9]+(?:,[0-9]{2,3})*(?:\\.[0-9]{1,2})?)';

function apiUrl(path: string) {
  return `${API_BASE_URL}${path}`;
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0900-\u097f\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesPhrase(text: string, phrase: string) {
  if (!phrase) {
    return false;
  }

  return (` ${text} `).includes(` ${phrase} `);
}

function tokenize(value: string) {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1 && !/^\d+$/.test(token));
}

function jaccardSimilarity(a: string[], b: string[]) {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const left = new Set(a);
  const right = new Set(b);
  let intersection = 0;

  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function getAmountMatches(value: string) {
  return [...value.matchAll(new RegExp(AMOUNT_REGEX_PATTERN, 'gi'))];
}

async function buildHttpError(response: Response, context: string) {
  let details = '';
  let messageOverride = '';

  try {
    const raw = await response.text();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: unknown; details?: unknown };
        const parsedError = typeof parsed.error === 'string' ? parsed.error : '';
        const parsedDetails = typeof parsed.details === 'string' ? parsed.details : '';

        if (parsedError) {
          messageOverride = parsedError;
        }

        if (parsedDetails) {
          details = parsedDetails.length > 500 ? `${parsedDetails.slice(0, 500)}...` : parsedDetails;
        } else if (!parsedError) {
          details = raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
        }
      } catch {
        details = raw.length > 500 ? `${raw.slice(0, 500)}...` : raw;
      }
    }
  } catch {
    // Ignore body parse failures.
  }

  const suffix = details ? ` | details: ${details}` : '';
  const message = messageOverride || context;
  return new Error(`${message} (HTTP ${response.status})${suffix}`);
}

function detectType(text: string): TypeDetection {
  const expenseHits = EXPENSE_HINTS.reduce((count, hint) => count + (includesPhrase(text, normalizeText(hint)) ? 1 : 0), 0);
  const incomeHits = INCOME_HINTS.reduce((count, hint) => count + (includesPhrase(text, normalizeText(hint)) ? 1 : 0), 0);

  if (expenseHits === 0 && incomeHits === 0) {
    return { type: 'expense', explicit: false };
  }

  return {
    type: incomeHits > expenseHits ? 'income' : 'expense',
    explicit: true,
  };
}

function parseAmount(segment: string) {
  const matches = getAmountMatches(segment);
  if (matches.length === 0) {
    return null;
  }

  for (const match of matches) {
    const amountRaw = (match[1] || '').replace(/,/g, '').trim();
    if (!amountRaw) {
      continue;
    }

    const parsed = Number.parseFloat(amountRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed * 100) / 100;
    }
  }

  return null;
}

function splitTranscript(transcript: string) {
  const base = transcript.replace(/\n+/g, '. ');
  const firstPass = base
    .split(/\b(?:then|next|phir|fir|aur phir|uske baad|after that|and then)\b|[.;!?]+/gi)
    .map((part) => part.trim())
    .filter(Boolean);

  const expanded: string[] = [];

  for (const segment of firstPass) {
    const amountCount = getAmountMatches(segment).length;
    if (amountCount <= 1) {
      expanded.push(segment);
      continue;
    }

    const commaSplit = segment
      .split(/,\s*|\s+\band\b\s+/gi)
      .map((part) => part.trim())
      .filter(Boolean);

    if (commaSplit.length > 1) {
      expanded.push(...commaSplit);
      continue;
    }

    expanded.push(segment);
  }

  return expanded;
}

function getFallbackCategoryName(type: TransactionType, categories: Category[]) {
  const byType = categories.filter((category) => category.type === type);

  const miscellaneous = byType.find(
    (category) => normalizeText(category.name) === 'miscellaneous' || normalizeText(category.name) === 'misc',
  );
  if (miscellaneous) {
    return miscellaneous.name;
  }

  const crossTypeMisc = categories.find(
    (category) => normalizeText(category.name) === 'miscellaneous' || normalizeText(category.name) === 'misc',
  );
  if (crossTypeMisc) {
    return crossTypeMisc.name;
  }

  if (byType.length > 0) {
    return byType[0].name;
  }

  return categories[0]?.name || 'Miscellaneous';
}

function scoreCategoryMatch(segment: string, category: Category): { score: number; subCategory: string } {
  const normalizedCategoryName = normalizeText(category.name);
  let score = 0;
  let matchedSubCategory = '';

  if (includesPhrase(segment, normalizedCategoryName)) {
    score += 5;
  }

  for (const subCategory of category.subCategories || []) {
    const normalizedSubCategory = normalizeText(subCategory);

    if (includesPhrase(segment, normalizedSubCategory)) {
      score += 4;
      matchedSubCategory = subCategory;
      break;
    }

    const subHints = SUBCATEGORY_HINTS[normalizedSubCategory] || [];
    for (const hint of subHints) {
      if (includesPhrase(segment, normalizeText(hint))) {
        score += 3;
        matchedSubCategory = subCategory;
        break;
      }
    }

    if (matchedSubCategory) {
      break;
    }
  }

  const categoryHints = CATEGORY_HINTS[normalizedCategoryName] || [];
  for (const hint of categoryHints) {
    if (includesPhrase(segment, normalizeText(hint))) {
      score += 2;
      break;
    }
  }

  return { score, subCategory: matchedSubCategory };
}

function detectCategoryMatch(segment: string, assumedType: TransactionType, categories: Category[]): CategoryMatch {
  let bestMatch: CategoryMatch | null = null;

  for (const category of categories) {
    const { score, subCategory } = scoreCategoryMatch(segment, category);

    if (score === 0) {
      continue;
    }

    const weightedScore = category.type === assumedType ? score + 1 : score;
    const candidate: CategoryMatch = {
      categoryName: category.name,
      subCategory,
      type: category.type,
      score: weightedScore,
    };

    if (!bestMatch || candidate.score > bestMatch.score) {
      bestMatch = candidate;
    }
  }

  if (bestMatch) {
    return bestMatch;
  }

  return {
    categoryName: getFallbackCategoryName(assumedType, categories),
    subCategory: '',
    type: assumedType,
    score: 0,
  };
}

function detectAccount(segment: string, accounts: Account[]) {
  if (accounts.length === 0) {
    return 'Cash';
  }

  const normalizedSegment = normalizeText(segment);
  let bestScore = 0;
  let bestAccount = accounts[0].name;

  for (const account of accounts) {
    const normalizedName = normalizeText(account.name);
    let score = 0;

    if (includesPhrase(normalizedSegment, normalizedName)) {
      score += 6;
    }

    const tokens = normalizedName
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !ACCOUNT_STOP_WORDS.has(token));

    for (const token of tokens) {
      if (includesPhrase(normalizedSegment, token)) {
        score += 2;
      }
    }

    if (account.type === 'cash' && (includesPhrase(normalizedSegment, 'cash') || includesPhrase(normalizedSegment, 'नकद'))) {
      score += 4;
    }

    if (score > bestScore) {
      bestScore = score;
      bestAccount = account.name;
    }
  }

  return bestAccount;
}

function ensureValidSubCategory(categoryName: string, subCategory: string, categories: Category[]) {
  if (!subCategory) {
    return '';
  }

  const category = categories.find((item) => item.name === categoryName);
  if (!category) {
    return '';
  }

  const matched = (category.subCategories || []).find(
    (item) => normalizeText(item) === normalizeText(subCategory),
  );

  return matched || '';
}

function makeConfidenceScore(input: {
  amountFound: boolean;
  explicitType: boolean;
  categoryScore: number;
  accountMatched: boolean;
}) {
  let confidence = 0.3;

  if (input.amountFound) {
    confidence += 0.3;
  }

  if (input.explicitType) {
    confidence += 0.15;
  }

  if (input.categoryScore > 0) {
    confidence += input.categoryScore >= 5 ? 0.2 : 0.12;
  }

  if (input.accountMatched) {
    confidence += 0.1;
  }

  return Math.min(0.99, Math.round(confidence * 100) / 100);
}

function extractMeaningfulNote(input: {
  original: string;
  category: string;
  subCategory: string;
  account: string;
}) {
  const amountRemoved = input.original.replace(new RegExp(AMOUNT_REGEX_PATTERN, 'gi'), ' ');
  const rawTokens = amountRemoved
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const removable = new Set<string>();
  const phrasePool = [input.category, input.subCategory, input.account, ...EXPENSE_HINTS, ...INCOME_HINTS];

  for (const phrase of phrasePool) {
    for (const token of tokenize(phrase)) {
      removable.add(token);
    }
  }

  const kept = rawTokens.filter((token) => {
    const normalizedToken = normalizeText(token);
    if (!normalizedToken) {
      return false;
    }

    if (/^\d+$/.test(normalizedToken)) {
      return false;
    }

    if (NOTE_STOP_WORDS.has(normalizedToken)) {
      return false;
    }

    if (removable.has(normalizedToken)) {
      return false;
    }

    return true;
  });

  const candidate = kept.join(' ').replace(/\s+/g, ' ').trim();
  if (candidate.length >= 3) {
    return candidate;
  }

  return input.original.trim();
}

function bestStringMatch(candidate: string, options: string[]) {
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedCandidate || options.length === 0) {
    return null;
  }

  let bestValue: string | null = null;
  let bestScore = 0;

  for (const option of options) {
    const normalizedOption = normalizeText(option);
    if (!normalizedOption) {
      continue;
    }

    let score = 0;

    if (normalizedOption === normalizedCandidate) {
      score = 1;
    } else if (
      normalizedOption.includes(normalizedCandidate) ||
      normalizedCandidate.includes(normalizedOption)
    ) {
      score = 0.88;
    } else {
      score = jaccardSimilarity(tokenize(normalizedOption), tokenize(normalizedCandidate));
    }

    if (score > bestScore) {
      bestScore = score;
      bestValue = option;
    }
  }

  if (!bestValue || bestScore < 0.45) {
    return null;
  }

  return bestValue;
}

function dedupeDrafts(drafts: VoiceDraftTransaction[]) {
  const seen = new Set<string>();
  const result: VoiceDraftTransaction[] = [];

  for (const draft of drafts) {
    const key = `${Math.round(draft.amount * 100)}|${normalizeText(draft.rawText)}|${normalizeText(draft.category)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(draft);
  }

  return result;
}

function loadLearningExamples(): VoiceLearningExample[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(LEARNING_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const item = entry as {
          text?: unknown;
          type?: unknown;
          category?: unknown;
          subCategory?: unknown;
          account?: unknown;
          note?: unknown;
          updatedAt?: unknown;
        };

        const text = typeof item.text === 'string' ? item.text : '';
        const type = item.type === 'income' ? 'income' : item.type === 'expense' ? 'expense' : null;
        const category = typeof item.category === 'string' ? item.category : '';
        const subCategory = typeof item.subCategory === 'string' ? item.subCategory : '';
        const account = typeof item.account === 'string' ? item.account : '';
        const note = typeof item.note === 'string' ? item.note : '';
        const updatedAt = typeof item.updatedAt === 'number' ? item.updatedAt : Date.now();

        if (!text || !type || !category || !account) {
          return null;
        }

        return {
          text,
          type,
          category,
          subCategory,
          account,
          note,
          updatedAt,
        } satisfies VoiceLearningExample;
      })
      .filter((entry): entry is VoiceLearningExample => entry !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_LEARNING_EXAMPLES);
  } catch {
    return [];
  }
}

function saveLearningExamples(examples: VoiceLearningExample[]) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(LEARNING_STORAGE_KEY, JSON.stringify(examples.slice(0, MAX_LEARNING_EXAMPLES)));
  } catch {
    // Ignore localStorage write failures.
  }
}

function applyLearningToDraft(
  draft: VoiceDraftTransaction,
  examples: VoiceLearningExample[],
  categories: Category[],
  accounts: Account[],
) {
  const draftTokens = tokenize(draft.rawText || draft.description);
  if (draftTokens.length === 0 || examples.length === 0) {
    return draft;
  }

  let bestExample: VoiceLearningExample | null = null;
  let bestScore = 0;

  for (const example of examples) {
    const score = jaccardSimilarity(draftTokens, tokenize(example.text));
    if (score > bestScore) {
      bestScore = score;
      bestExample = example;
    }
  }

  if (!bestExample || bestScore < 0.5) {
    return draft;
  }

  const type = bestScore >= 0.7 ? bestExample.type : draft.type;
  const categoryPool = categories.filter((category) => category.type === type).map((category) => category.name);
  const learnedCategory = bestStringMatch(bestExample.category, categoryPool) || getDefaultCategoryName(type, categories);

  const learnedCategoryObj = categories.find((category) => category.name === learnedCategory);
  const subCategoryPool = learnedCategoryObj?.subCategories || [];
  const learnedSubCategory = bestExample.subCategory
    ? bestStringMatch(bestExample.subCategory, subCategoryPool) || ''
    : '';

  const learnedAccount = bestStringMatch(bestExample.account, accounts.map((account) => account.name)) || draft.account;

  const next: VoiceDraftTransaction = {
    ...draft,
    type,
    category: learnedCategory,
    subCategory: learnedSubCategory,
    account: learnedAccount,
    confidence: Math.min(0.99, Math.max(draft.confidence, bestScore)),
  };

  if (bestScore >= 0.75 && bestExample.note) {
    next.description = bestExample.note;
  }

  return next;
}

async function extractTransactionsWithAi(
  transcript: string,
  categories: Category[],
  accounts: Account[],
): Promise<VoiceDraftTransaction[]> {
  if (!API_BASE_URL) {
    return [];
  }

  const endpoint = apiUrl('/api/voice/extract-transactions');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      transcript,
      categories: categories.map((category) => ({
        name: category.name,
        type: category.type,
        subCategories: category.subCategories || [],
      })),
      accounts: accounts.map((account) => account.name),
    }),
  });

  if (!response.ok) {
    throw await buildHttpError(response, 'Voice extraction failed');
  }

  const data = (await response.json()) as {
    transactions?: unknown;
  };

  if (!Array.isArray(data.transactions)) {
    return [];
  }

  const drafts: VoiceDraftTransaction[] = [];

  for (const item of data.transactions as unknown[]) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const row = item as AiExtractionItem;
    const amount = typeof row.amount === 'number' ? row.amount : Number.parseFloat(String(row.amount));
    if (!Number.isFinite(amount) || amount <= 0) {
      continue;
    }

    const rawText = typeof row.sourceText === 'string' && row.sourceText.trim()
      ? row.sourceText.trim()
      : typeof row.note === 'string' && row.note.trim()
        ? row.note.trim()
        : transcript;

    const normalizedRaw = normalizeText(rawText);
    const typeFromModel = row.type === 'income' ? 'income' : row.type === 'expense' ? 'expense' : null;
    const typeFromText = detectType(normalizedRaw).type;
    const type: TransactionType = typeFromModel || typeFromText;

    const categoryCandidates = categories.filter((category) => category.type === type).map((category) => category.name);
    const categoryFromModel = typeof row.category === 'string' ? row.category : '';

    let category = bestStringMatch(categoryFromModel, categoryCandidates);
    if (!category) {
      category = detectCategoryMatch(normalizedRaw, type, categories).categoryName;
    }

    const categoryObj = categories.find((itemCategory) => itemCategory.name === category);
    const subCategoryCandidates = categoryObj?.subCategories || [];
    const subCategoryFromModel = typeof row.subCategory === 'string' ? row.subCategory : '';
    const subCategory = bestStringMatch(subCategoryFromModel, subCategoryCandidates) || '';

    const accountFromModel = typeof row.account === 'string' ? row.account : '';
    const account =
      bestStringMatch(accountFromModel, accounts.map((entry) => entry.name)) || detectAccount(normalizedRaw, accounts);

    const noteFromModel = typeof row.note === 'string' ? row.note.trim() : '';
    const description =
      noteFromModel ||
      extractMeaningfulNote({
        original: rawText,
        category,
        subCategory,
        account,
      });

    const confidence =
      typeof row.confidence === 'number' && Number.isFinite(row.confidence)
        ? Math.max(0, Math.min(1, row.confidence))
        : makeConfidenceScore({
            amountFound: true,
            explicitType: Boolean(typeFromModel),
            categoryScore: categoryFromModel ? 5 : 2,
            accountMatched: Boolean(accountFromModel),
          });

    drafts.push({
      id: crypto.randomUUID(),
      amount: Math.round(amount * 100) / 100,
      type,
      category,
      subCategory,
      account,
      description,
      rawText,
      confidence,
    });
  }

  return dedupeDrafts(drafts);
}

function mergeDrafts(primary: VoiceDraftTransaction[], fallback: VoiceDraftTransaction[]) {
  if (primary.length === 0) {
    return fallback;
  }

  if (fallback.length === 0) {
    return primary;
  }

  const merged = [...primary];

  for (const candidate of fallback) {
    const duplicate = merged.some((existing) => {
      const amountClose = Math.abs(existing.amount - candidate.amount) <= 1;
      const similarity = jaccardSimilarity(tokenize(existing.rawText), tokenize(candidate.rawText));
      return amountClose && similarity >= 0.7;
    });

    if (!duplicate) {
      merged.push(candidate);
    }
  }

  return dedupeDrafts(merged);
}

export async function transcribeVoiceAudio(blob: Blob) {
  if (!API_BASE_URL) {
    throw new Error('Missing VITE_PUSH_API_BASE_URL. Configure it to call voice transcription API.');
  }

  if (blob.size > VOICE_MAX_UPLOAD_BYTES) {
    throw new Error(`Audio is too large (${blob.size} bytes). Keep recording under 2 minutes.`);
  }

  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  const endpoint = apiUrl('/api/voice/transcribe');
  console.info('[Voice/Frontend] transcription request', {
    endpoint,
    mimeType: blob.type || 'audio/webm',
    bytes: blob.size,
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audioBase64: base64,
      mimeType: blob.type || 'audio/webm',
    }),
  });
  console.info('[Voice/Frontend] transcription response', {
    status: response.status,
    ok: response.ok,
  });

  if (!response.ok) {
    throw await buildHttpError(response, 'Voice transcription failed');
  }

  const data = (await response.json()) as {
    transcript?: unknown;
  };

  if (typeof data.transcript !== 'string' || !data.transcript.trim()) {
    throw new Error('Voice transcription did not return text.');
  }

  return data.transcript.trim();
}

export function parseTranscriptToDrafts(
  transcript: string,
  categories: Category[],
  accounts: Account[],
): VoiceDraftTransaction[] {
  const segments = splitTranscript(transcript);
  const drafts: VoiceDraftTransaction[] = [];

  for (const segmentRaw of segments) {
    const segment = segmentRaw.trim();
    if (!segment) {
      continue;
    }

    const amount = parseAmount(segment);
    if (amount === null) {
      continue;
    }

    const normalizedSegment = normalizeText(segment);
    const typeResult = detectType(normalizedSegment);
    const categoryMatch = detectCategoryMatch(normalizedSegment, typeResult.type, categories);
    const accountName = detectAccount(normalizedSegment, accounts);

    const categoryName = categoryMatch.categoryName;
    const subCategory = ensureValidSubCategory(categoryName, categoryMatch.subCategory, categories);
    const type = categoryMatch.type;

    const description = extractMeaningfulNote({
      original: segment,
      category: categoryName,
      subCategory,
      account: accountName,
    });

    const confidence = makeConfidenceScore({
      amountFound: true,
      explicitType: typeResult.explicit,
      categoryScore: categoryMatch.score,
      accountMatched: accountName.length > 0,
    });

    drafts.push({
      id: crypto.randomUUID(),
      amount,
      type,
      category: categoryName,
      subCategory,
      account: accountName,
      description,
      rawText: segment,
      confidence,
    });
  }

  if (drafts.length > 0) {
    return dedupeDrafts(drafts);
  }

  const fallbackAmount = parseAmount(transcript);
  if (fallbackAmount === null) {
    return [];
  }

  const normalizedTranscript = normalizeText(transcript);
  const fallbackType = detectType(normalizedTranscript);
  const fallbackCategory = detectCategoryMatch(normalizedTranscript, fallbackType.type, categories);
  const fallbackAccount = detectAccount(normalizedTranscript, accounts);

  return [
    {
      id: crypto.randomUUID(),
      amount: fallbackAmount,
      type: fallbackCategory.type,
      category: fallbackCategory.categoryName,
      subCategory: ensureValidSubCategory(fallbackCategory.categoryName, fallbackCategory.subCategory, categories),
      account: fallbackAccount,
      description: extractMeaningfulNote({
        original: transcript.trim(),
        category: fallbackCategory.categoryName,
        subCategory: fallbackCategory.subCategory,
        account: fallbackAccount,
      }),
      rawText: transcript.trim(),
      confidence: makeConfidenceScore({
        amountFound: true,
        explicitType: fallbackType.explicit,
        categoryScore: fallbackCategory.score,
        accountMatched: accounts.length > 0,
      }),
    },
  ];
}

export async function buildVoiceDraftsFromTranscript(
  transcript: string,
  categories: Category[],
  accounts: Account[],
) {
  const fallbackDrafts = parseTranscriptToDrafts(transcript, categories, accounts);

  let aiDrafts: VoiceDraftTransaction[] = [];
  try {
    aiDrafts = await extractTransactionsWithAi(transcript, categories, accounts);
  } catch (error) {
    console.warn('[Voice/Frontend] AI extraction failed. Falling back to rule parser.', error);
  }

  const merged = mergeDrafts(aiDrafts, fallbackDrafts);
  const learningExamples = loadLearningExamples();

  return merged.map((draft) => applyLearningToDraft(draft, learningExamples, categories, accounts));
}

export function learnFromFinalizedDrafts(drafts: VoiceDraftTransaction[]) {
  const existing = loadLearningExamples();
  const next = [...existing];

  for (const draft of drafts) {
    const text = normalizeText(draft.rawText || draft.description);
    if (!text || draft.amount <= 0) {
      continue;
    }

    next.push({
      text,
      type: draft.type,
      category: draft.category,
      subCategory: draft.subCategory,
      account: draft.account,
      note: draft.description,
      updatedAt: Date.now(),
    });
  }

  const dedupedMap = new Map<string, VoiceLearningExample>();
  for (const example of next.sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = `${example.text}|${example.type}|${normalizeText(example.category)}|${normalizeText(example.account)}`;
    if (!dedupedMap.has(key)) {
      dedupedMap.set(key, example);
    }
  }

  const deduped = [...dedupedMap.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_LEARNING_EXAMPLES);
  saveLearningExamples(deduped);
}

export function getCategoryOptionsForType(type: TransactionType, categories: Category[]) {
  return categories.filter((category) => category.type === type);
}

export function getDefaultAccountName(accounts: Account[]) {
  return accounts[0]?.name || 'Cash';
}

export function getDefaultCategoryName(type: TransactionType, categories: Category[]) {
  return getFallbackCategoryName(type, categories);
}
