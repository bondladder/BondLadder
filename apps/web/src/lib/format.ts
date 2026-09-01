/** Amount formatting: `1,004.35 USDC` — two decimals, thousands separator, always the unit. */
export function usdc(value: number): string {
    return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
}

/** Plain number with two decimals and a thousands separator, no unit. */
export function amount(value: number): string {
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
