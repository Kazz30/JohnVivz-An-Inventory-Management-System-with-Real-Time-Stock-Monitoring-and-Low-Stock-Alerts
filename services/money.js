// Money is handled as exact decimal strings with two places ("12.50"), matching the
// DECIMAL(12,2) columns. Event payloads always carry these strings, never JSON numbers.

const MAX_INTEGER_DIGITS = 10; // DECIMAL(12,2)

// Parses user or database input into a canonical "123.45" string, rounding half-up at
// two decimals exactly as MySQL does. Returns null for anything that is not a plain,
// non-negative decimal that fits DECIMAL(12,2).
export const parseMoney = input => {
  let text;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) return null;
    text = input.toFixed(6);
  } else {
    text = String(input ?? "").trim();
  }
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return null;
  const fraction = (match[2] || "").padEnd(3, "0");
  let cents = BigInt(match[1]) * 100n + BigInt(fraction.slice(0, 2));
  if (Number(fraction[2]) >= 5) cents += 1n;
  const whole = cents / 100n;
  if (whole.toString().length > MAX_INTEGER_DIGITS) return null;
  return `${whole}.${String(cents % 100n).padStart(2, "0")}`;
};

// For values already stored (DECIMAL strings) or validated earlier.
export const formatMoney = value => {
  const parsed = parseMoney(value);
  if (parsed === null) throw new Error(`Invalid money value: ${value}`);
  return parsed;
};

// Exact unitCost × quantity as a money string.
export const multiplyMoney = (unitCost, quantity) => {
  const [whole, fraction] = formatMoney(unitCost).split(".");
  const cents = (BigInt(whole) * 100n + BigInt(fraction)) * BigInt(quantity);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};
