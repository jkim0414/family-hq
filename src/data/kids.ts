import type { Kid } from "./types";

// Example roster — EDIT THIS for your family (ids must match src/data/people.ts).
// The live roster is stored in the database and editable in the app; this is the seed.
export const KIDS: Kid[] = [
  {
    id: "max",
    firstName: "Max",
    fullName: "Max Carter",
    dob: "2018-07-22",
    color: "#2563eb",
    current: { school: "Maple Grove Elementary", program: "3rd Grade", teachers: ["Ms. Rivera"], aftercare: "Maple Grove After-School" },
    fall: { school: "Maple Grove Elementary", program: "3rd Grade", teachers: ["Ms. Rivera"], aftercare: "Maple Grove After-School" },
    channels: ["parentsquare", "email"],
  },
  {
    id: "theo",
    firstName: "Theo",
    fullName: "Theo Carter",
    dob: "2021-05-03",
    color: "#16a34a",
    current: { school: "Maple Grove Elementary", program: "Kindergarten", teachers: ["Mr. Okafor"], aftercare: "Maple Grove After-School" },
    fall: { school: "Maple Grove Elementary", program: "Kindergarten", teachers: ["Mr. Okafor"], aftercare: "Maple Grove After-School" },
    channels: ["parentsquare", "email"],
  },
  {
    id: "ava",
    firstName: "Ava",
    fullName: "Ava Carter",
    dob: "2023-02-17",
    color: "#db2777",
    current: { school: "Sunny Days Preschool", program: "Twos", teachers: ["Ms. Priya", "Ms. Dana"] },
    fall: { school: "Sunny Days Preschool", program: "Twos", teachers: ["Ms. Priya", "Ms. Dana"] },
    channels: ["email"],
  },
];

export const kidById = (id: string) => KIDS.find((k) => k.id === id);
