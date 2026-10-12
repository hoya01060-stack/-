"use client";

import { ROLE_LABEL, type SpeakerRole } from "@/lib/types";

const ROLES: SpeakerRole[] = ["me", "other", "third"];

export default function RoleRadios({ name, value, onChange, legend }: { name: string; value?: SpeakerRole; onChange: (r: SpeakerRole) => void; legend: string }) {
  return (
    <fieldset>
      <legend className="sr-only">{legend}</legend>
      <div className="chip-row">
        {ROLES.map((r) => (
          <label key={r} className="chip">
            <input type="radio" name={name} value={r} checked={value === r} onChange={() => onChange(r)} />
            {ROLE_LABEL[r]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
