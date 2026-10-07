// Family roster used to tag who an item concerns / is assigned to. Items can also
// reference ad-hoc guests by free-text name (e.g. "Grandma") — those render as a
// neutral chip. Shared by the frontend and the serverless API.

export interface Person {
  id: string;
  name: string;
  color: string;
  kind: "parent" | "caregiver" | "kid";
  /** Other names the family uses for this person (matched case-insensitively). */
  aliases?: string[];
}

export const PEOPLE: Person[] = [
  { id: "alex", name: "Alex", color: "#7c3aed", kind: "parent" },
  { id: "sam", name: "Sam", color: "#ea580c", kind: "parent" },
  { id: "grandma", name: "Grandma", color: "#0d9488", kind: "caregiver" },
  { id: "max", name: "Max", color: "#2563eb", kind: "kid" },
  { id: "theo", name: "Theo", color: "#16a34a", kind: "kid" },
  { id: "ava", name: "Ava", color: "#db2777", kind: "kid" },
];

export const personById = (id: string) => {
  const k = (id || "").toLowerCase();
  return PEOPLE.find((p) => p.id === id || p.name.toLowerCase() === k || p.aliases?.some((a) => a.toLowerCase() === k));
};
export const personName = (id: string) => personById(id)?.name ?? id; // guest → raw name
export const personColor = (id: string) => personById(id)?.color ?? "#64748b";

/** Who the item is FOR / about. Back-compat: items used `kidIds`, then `people`. */
export function peopleOf(item: { people?: string[]; kidIds?: string[] }): string[] {
  return item.people ?? item.kidIds ?? [];
}

/** Who is RESPONSIBLE for acting on the item (usually a parent). */
export function ownerOf(item: { owner?: string[] }): string[] {
  return item.owner ?? [];
}
