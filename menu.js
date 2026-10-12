// Menu helpers for the billing screen. Order always follows the menu sheet.

export function kitchens(items) {
  return [...new Set(items.map((i) => i.kitchen))];
}

export function groupByCategory(items, kitchen) {
  const groups = new Map();
  for (const item of items) {
    if (item.kitchen !== kitchen) continue;
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  return [...groups].map(([category, list]) => ({ category, items: list }));
}

export function searchItems(items, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return items.filter((i) => i.item.toLowerCase().includes(q));
}
