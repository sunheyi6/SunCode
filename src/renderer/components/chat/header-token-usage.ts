export function formatHeaderTokenUsage(total: number): string {
  return total > 0 ? `${total.toLocaleString()} tokens` : '';
}
