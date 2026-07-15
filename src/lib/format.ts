export function formatJpy(value: number): string {
  const rounded = Math.round(value);
  const abs = Math.abs(rounded).toLocaleString('ja-JP');
  return rounded < 0 ? `-¥${abs}` : `¥${abs}`;
}

export function formatUsd(value: number): string {
  const abs = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-$${abs}` : `$${abs}`;
}

/** rate は 0.185 のような小数。'18.5%' を返す */
export function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatFoil(isFoil: boolean | null): string {
  if (isFoil === true) return 'Foil';
  if (isFoil === false) return '—';
  return '不明';
}
