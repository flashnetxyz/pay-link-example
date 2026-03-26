/**
 * BigInt-based amount formatting. No floats.
 */

const ZERO = BigInt(0);
const TEN = BigInt(10);

export function formatDecimal(amountSmallest: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }

  const raw = BigInt(amountSmallest);
  const negative = raw < ZERO;
  const value = negative ? -raw : raw;

  const base = TEN ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;

  const wholeStr = whole.toString();
  if (decimals === 0) {
    return negative ? `-${wholeStr}` : wholeStr;
  }

  const fracStr = frac.toString().padStart(decimals, "0");
  const result = `${wholeStr}.${fracStr}`;
  return negative ? `-${result}` : result;
}

function trimTrailingZeros(value: string): string {
  if (!value.includes(".")) return value;
  let trimmed = value.replace(/0+$/, "");
  if (trimmed.endsWith(".")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

export function formatBtcDisplay(sats: string): string {
  return trimTrailingZeros(formatDecimal(sats, 8));
}

export function formatUsdcDisplay(amountSmallest: string): string {
  return trimTrailingZeros(formatDecimal(amountSmallest, 6));
}
