import { Link } from "react-router-dom";
import { useData } from "../dataStore";
import { Card, PageHeader, SectionHeader } from "../components/ui";
import { DirectorySections } from "../components/DirectorySections";
import { HouseholdProfile } from "../components/HouseholdProfile";

function age(dob: string): string {
  const b = new Date(dob);
  const now = new Date();
  let years = now.getFullYear() - b.getFullYear();
  let months = now.getMonth() - b.getMonth();
  if (now.getDate() < b.getDate()) months--;
  if (months < 0) {
    years--;
    months += 12;
  }
  return `${years}y ${months}m`;
}

const JUMPS = [
  ["kids", "Kids"],
  ["places", "Places"],
  ["contacts", "Contacts"],
  ["routines", "Drop-off"],
  ["facts", "Facts"],
  ["people", "People"],
] as const;

// The people, places, and standing facts Kimi works from.
export default function Household() {
  const { data } = useData();

  return (
    <div className="space-y-8">
      <PageHeader title="Household" subtitle="The people, places, and facts Kimi works from." />

      <div className="no-scrollbar -mx-4 -mt-3 flex gap-2 overflow-x-auto px-4 py-1 md:mx-0 md:px-0.5">
        {JUMPS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="min-h-[36px] shrink-0 rounded-full bg-surface px-3 text-xs font-medium leading-[36px] text-ink-2 ring-1 ring-line">
            {label}
          </a>
        ))}
      </div>

      <section id="kids">
        <SectionHeader title="Kids" />
        <div className="space-y-2">
          {data.kids.map((k) => (
            <Link key={k.id} to={`/household/kids/${k.id}`} className="block">
              <Card className="p-4" accent={k.color}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-base font-bold leading-tight text-ink">{k.fullName}</div>
                    <div className="mt-1 text-sm text-ink-2">
                      {k.current.program} · {k.current.school}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-3">
                      {age(k.dob)} · Teacher{k.current.teachers.length > 1 ? "s" : ""}: {k.current.teachers.join(", ")}
                    </div>
                  </div>
                  <span className="mt-0.5 shrink-0 text-lg leading-none text-ink-4">›</span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <div id="directory" className="space-y-6">
        <DirectorySections />
      </div>

      <div id="profile" className="space-y-6">
        <HouseholdProfile />
      </div>
    </div>
  );
}
