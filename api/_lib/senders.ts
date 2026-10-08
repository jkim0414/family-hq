import { CONFIG } from "../../src/data/config.js";

/** The email address in a From header ("Name" <a@b.com> → a@b.com), lowercased. */
export function senderAddress(from: string): string {
  const m = (from || "").match(/<([^>]+)>/);
  return (m ? m[1] : from || "").trim().toLowerCase();
}

// Senders that are always household-relevant. Add here as misses show up in History.
export const KNOWN_SENDERS: RegExp[] = [
  // Add your school district's and schools' email domains here, e.g. /yourdistrict\.org/i,
  /brightwheel/i,
  /band\.us/i,
  /parentsquare/i,
  /leagueapps/i,
  /teamsnap/i,
  /ayso/i,
  /signupgenius/i,
  // Add your pediatrician's / health system's email domain here if you want it filed.
  /activecommunities|activenet/i,
  /dentist|pediatric|orthodont/i,
];

// The school's and activities' own domains, exactly (a pattern like /yourschool\.org/ would also pass yourschool.org.example.com).
// EDIT: your school district's and activities' own email domains.
const TRUSTED_DOMAINS = ["mybrightwheel.com", "brightwheel.com", "band.us", "parentsquare.com", "leagueapps.com", "teamsnap.com", "ayso.org", "signupgenius.com", "activecommunities.com"];

/**
 * Mail whose word can change the family's records on its own (a teacher's new email, a pickup
 * time): from a parent (a forward), or from a known school/activity address. Anyone else's is a
 * suggestion a parent confirms — an email can claim to be from anyone in its display name.
 */
export function trustedSender(from: string): boolean {
  const addr = senderAddress(from);
  const family = [CONFIG.parents.alex.email, CONFIG.parents.sam.email, CONFIG.caregivers.grandma.email].filter(Boolean).map((e) => e!.toLowerCase());
  if (family.includes(addr)) return true;
  const domain = addr.split("@")[1] || "";
  return TRUSTED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}
