/**
 * 낱말 끝소리에 맞는 조사를 붙인다. josa("서윤", "이", "가") → "서윤이", josa("원고", "을", "를") → "원고를".
 * 숫자나 영문으로 끝나면 읽는 소리를 어림한다 ("1"은 일, "l·m·n·r"은 받침 있는 것으로).
 */
export function josa(word: string, withFinal: string, without: string): string {
  const last = word.trim().replace(/[\s'"’”`)\]]+$/, "").slice(-1);
  const code = last.charCodeAt(0);
  const hangul = code >= 0xac00 && code <= 0xd7a3;
  const final = hangul ? (code - 0xac00) % 28 !== 0 : /[013678lmnr]/i.test(last);
  return word + (final ? withFinal : without);
}
