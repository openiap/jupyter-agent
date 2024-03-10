export function getid() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}
export const stringToChars = (input: string): string[] => {
  const symbols = [];
  for (const symbol of input) {
    symbols.push(symbol);
  }
  return symbols;
};