export function normalize(text: string): string {
  // Prevents homoglyph substitution (e.g. Cyrillic 'а' for Latin 'a')
  let result = text.normalize('NFKC');

  // Prevents zero-width character injection to split tokens invisibly
  result = result.replace(/[​‌‍﻿­]/g, '');

  // Prevents punctuation flooding to bypass keyword or pattern detectors
  result = result.replace(/([^\p{L}\p{N}\s])\1{2,}/gu, '$1');

  // Prevents whitespace padding / splitting tricks to fragment tokens
  result = result.replace(/\s+/g, ' ').trim();

  // Prevents case variation used to evade case-sensitive pattern matching
  result = result.toLowerCase();

  return result;
}
