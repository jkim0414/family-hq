import type { Contact, Place, Routine } from "./types";

// Example directory seed — EDIT THIS (or leave it and fill the directory in the app).
export const PLACES: Place[] = [
  { id: "maple-grove", name: "Maple Grove Elementary", kind: "school", address: "200 Maple Ave, Springfield", phone: "(555) 010-0141", notes: "Max (3rd grade) and Theo (kindergarten)." },
  { id: "maple-grove-after", name: "Maple Grove After-School", kind: "aftercare", address: "On campus", notes: "Pick up by 6pm." },
  { id: "sunny-days", name: "Sunny Days Preschool", kind: "daycare", address: "88 Elm St, Springfield", phone: "(555) 010-0177" },
];

export const CONTACTS: Contact[] = [
  { id: "ms-rivera", name: "Ms. Rivera", role: "Teacher — Max's 3rd grade", kidIds: ["max"], org: "Maple Grove Elementary", email: "rivera@example.org" },
  { id: "mr-okafor", name: "Mr. Okafor", role: "Teacher — Theo's kindergarten", kidIds: ["theo"], org: "Maple Grove Elementary", email: "okafor@example.org" },
];

export const ROUTINES: Routine[] = [
  { id: "r-max-drop", kidId: "max", label: "Drop-off", detail: "8:05 at the front gate" },
  { id: "r-ava-pick", kidId: "ava", label: "Pick-up", detail: "Sunny Days, by 5:30" },
];
