import { indexHeaders } from "./rowShape.js";

// Each year's tab has a slightly different column set. Rather than one big
// branchy parser, we detect which "shape" a sheet is and hand back a small
// column-map describing where to find each concept — the row parser then
// works purely off that map.
//
// Known shapes (column presence, not exact header text — normalizeHeader
// already lowercases and collapses whitespace):
//   A) "direct expense" shape:  date, monthly rents, direct expense, notes, reconciled...
//   B) "gross/type" shape:      date, gross, type, category, notes
//   C) "deposits/implied" shape: date, deposits received, implied expense, expense, notes

const HEADER_ALIASES = {
  date: ["date", "month", "transaction date"],
  rents: ["monthly rents", "rent", "rents", "rent received", "deposits received"],
  directExpense: ["direct expense"],
  impliedExpense: ["implied expense"],
  expense: ["expense", "expenses"],
  gross: ["gross", "gross income", "gross amount"],
  type: ["type", "transaction type"],
  category: ["category", "cat"],
  notes: ["notes", "note", "memo", "description"],
  reconciled: ["reconciled out of reserve account", "reconciled", "reconciled via reserve"],
  daysRented: ["days rented"],
  daysPersonal: ["days personal use", "days personal"],
};

export function detectColumnMap(headerRow) {
  const idx = indexHeaders(headerRow);
  const find = (aliasKey) => {
    for (const alias of HEADER_ALIASES[aliasKey]) {
      if (idx[alias] !== undefined) return idx[alias];
    }
    return undefined;
  };
  const map = {};
  for (const key of Object.keys(HEADER_ALIASES)) map[key] = find(key);

  let shape = "unknown";
  if (map.directExpense !== undefined) shape = "direct_expense";
  else if (map.gross !== undefined || map.type !== undefined) shape = "gross_type";
  else if (map.impliedExpense !== undefined || map.expense !== undefined) shape = "deposits_implied";

  return { ...map, shape };
}
