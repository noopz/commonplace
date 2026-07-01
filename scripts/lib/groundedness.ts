/**
 * Regex-only "is this claim traceable to the source text" check. Deliberately
 * scoped to numbers and quoted strings — NOT named entities, which would
 * require real NER or an LLM call and defeat the zero-cost premise. A soft
 * signal for paper-reflection-agent's Gaps to Address list, never a gate:
 * paraphrase and unit reformatting produce real false positives here.
 */
export interface GroundednessResult {
  ungroundedNumbers: string[];
  ungroundedQuotes: string[];
}

// Requires a decimal point or a percent sign, OR two-plus digits, to exclude
// bare single-digit list/step numbers ("Step 1", "Step 2") that are noise,
// not claims.
const SPECIFIC_NUMBER_RE = /\b\d+(?:\.\d+)?%|\b\d{2,}(?:\.\d+)?\b|\b\d\.\d+\b/g;
const QUOTED_STRING_RE = /"([^"]{3,})"/g;

function extractSpecificNumbers(text: string): Set<string> {
  return new Set(text.match(SPECIFIC_NUMBER_RE) ?? []);
}

function extractQuotedStrings(text: string): string[] {
  return [...text.matchAll(QUOTED_STRING_RE)].map((m) => m[1]);
}

export function checkGroundedness(generatedText: string, sourceText: string): GroundednessResult {
  const genNumbers = extractSpecificNumbers(generatedText);
  const srcNumbers = extractSpecificNumbers(sourceText);
  const ungroundedNumbers = [...genNumbers].filter((n) => !srcNumbers.has(n));

  const genQuotes = extractQuotedStrings(generatedText);
  const ungroundedQuotes = genQuotes.filter((q) => !sourceText.includes(q));

  return { ungroundedNumbers, ungroundedQuotes };
}
