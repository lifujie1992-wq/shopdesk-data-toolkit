function dateInShanghai(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function todayShanghai(now = new Date()) { return dateInShanghai(now); }
export function yesterdayShanghai(now = new Date()) {
  return dateInShanghai(new Date(now.getTime() - 86_400_000));
}
