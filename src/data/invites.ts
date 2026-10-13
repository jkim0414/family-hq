import type { CalEvent } from "./types";

/** On the calendar: a fixed date, or an invitation the family said yes to. */
export const onCalendar = (e: CalEvent): boolean => !e.invite || e.invite.status === "yes";

/** An invitation still waiting on a parent's decision. */
export const awaitingDecision = (e: CalEvent): boolean => e.invite?.status === "pending";
