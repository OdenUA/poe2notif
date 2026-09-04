// Рендер описания предмета «как в попапе на сайте» из данных fetch API.

interface TradeValue {
  values?: [string, number][];
  name?: string;
}

const MOD_SECTIONS: [string, string | null][] = [
  ["enchantMods", null],
  ["implicitMods", null],
  ["runeMods", null],
  ["explicitMods", null],
  ["craftedMods", "(crafted)"],
  ["fracturedMods", "(fractured)"],
  ["desecratedMods", null],
  ["veiledMods", "(veiled)"],
];

function renderProps(entries: TradeValue[] | undefined): string[] {
  return (entries ?? []).map((p) => {
    const vals = (p.values ?? [])
      .map((v) => v[0])
      .filter((v) => v && v.length > 0)
      .join(", ");
    if (!p.name) return vals;
    return vals ? `${p.name}: ${vals}` : p.name;
  }).filter((l) => l.length > 0);
}

// В текстах API встречаются плейсхолдеры вида [Spell] и [Physical|Physical Damage].
// На сайте они рендерятся переводом; здесь берём читаемый вариант.
function cleanPlaceholders(text: string): string {
  return text
    .replace(/\[([^\]|]*)\|([^\]]*)\]/g, (_m, _a, b) => b)
    .replace(/\[([^\]]+)\]/g, (_m, a) => a);
}

export function describeItem(item: any, listing: any): string {
  const lines: string[] = [];

  const title = item.name
    ? `${item.name}, ${item.typeLine ?? item.baseType ?? ""}`
    : (item.typeLine ?? item.baseType ?? "Unknown item");
  lines.push(cleanPlaceholders(title));
  if (item.rarity) lines.push(`Rarity: ${item.rarity}`);

  lines.push(...renderProps(item.properties));
  lines.push(...renderProps(item.additionalProperties));

  const reqs = renderProps(item.requirements);
  if (reqs.length > 0) lines.push(`Requirements: ${reqs.join(", ")}`);

  if (item.ilvl) lines.push(`Item Level: ${item.ilvl}`);

  if (Array.isArray(item.socketedItems) && item.socketedItems.length > 0) {
    for (const s of item.socketedItems) {
      lines.push(`Socketed: ${s.name ? `${s.name}, ` : ""}${s.typeLine ?? s.baseType ?? ""}`.trim());
    }
  }

  for (const [key, suffix] of MOD_SECTIONS) {
    for (const mod of item[key] ?? []) {
      // В trade2 fetch моды - объекты {description, ...}; в старых ответах - строки
      const text = typeof mod === "string" ? mod : (mod?.description ?? JSON.stringify(mod));
      lines.push(suffix ? `${text} ${suffix}` : text);
    }
  }

  if (item.identified === false) lines.push("Unidentified");
  if (item.corrupted) lines.push("Corrupted");
  if (item.split) lines.push("Split");
  if (item.mirrored) lines.push("Mirrored");
  if (item.duplicated) lines.push("Mirrored (copy)");

  if (item.note) lines.push(`Note: ${item.note}`);
  if (listing?.stash?.name) lines.push(`Stash: ${listing.stash.name}`);

  if (listing?.price) {
    lines.push(`Цена: ${listing.price.amount} ${listing.price.currency}`);
  }

  return lines.map(cleanPlaceholders).join("\n");
}

export function itemTitle(item: any): string {
  if (!item) return "Unknown item";
  return item.name
    ? `${item.name} (${item.typeLine ?? item.baseType ?? "?"})`
    : (item.typeLine ?? item.baseType ?? "Unknown item");
}
