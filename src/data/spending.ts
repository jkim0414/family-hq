import type { SpendCategory } from "./types";

/** Spending categories (receipts are tagged with one when they're read). Shared by the API and the app. */
export const SPEND_CATEGORIES: { id: SpendCategory; label: string }[] = [
  { id: "groceries", label: "Groceries" },
  { id: "dining", label: "Dining & takeout" },
  { id: "kids", label: "Kids: school, activities, care" },
  { id: "household", label: "Home & utilities" },
  { id: "shopping", label: "Shopping" },
  { id: "travel", label: "Travel" },
  { id: "health", label: "Health" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "gifts", label: "Gifts & donations" },
  { id: "other", label: "Other" },
];

/** A category id from what a model wrote (the id, or its label). */
export function toSpendCategory(v: unknown): SpendCategory {
  const t = String(v || "").trim().toLowerCase();
  return SPEND_CATEGORIES.find((c) => c.id === t || c.label.toLowerCase() === t)?.id || "other";
}
