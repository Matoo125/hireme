// Amounts sort as numbers with blanks last either way; text sorts naturally.
for (const order of [0, 1]) {
  grid.orderBy(cx("salary_max"), order);
  await wait(150);
  const values = grid.getData().map((r) => r[cx("salary_max")]);
  const firstBlank = values.findIndex((v) => v === "" || v == null);
  const numbers = values.slice(0, firstBlank).map(Number);
  const label = order ? "descending" : "ascending";
  check(`Max ${label}: numbers in order`, numbers.length > 5 &&
    numbers.every((n, i) => !i || (order ? numbers[i - 1] >= n : numbers[i - 1] <= n)), numbers.slice(0, 5).join(","));
  check(`Max ${label}: blanks last`, firstBlank > 0 && values.slice(firstBlank).every((v) => v === "" || v == null));
}
grid.orderBy(cx("organization"), 0);
await wait(150);
const orgs = grid.getData().map((r) => String(r[cx("organization")])).filter(Boolean);
check("organizations A to Z", orgs.every((o, i) => !i || orgs[i - 1].localeCompare(o, undefined, { numeric: true, sensitivity: "base" }) <= 0),
  `${orgs[0]} … ${orgs.at(-1)}`);
