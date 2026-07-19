export function inclusiveSum(start, end) {
  let total = 0;
  for (let value = start; value < end; value += 1) total += value;
  return total;
}
