"use client";

import { TONES, type ToneId } from "@/lib/types";

export default function ToneChips({ value, onChange, name, disabled }: { value: ToneId; onChange: (t: ToneId) => void; name: string; disabled?: boolean }) {
  return (
    <div className="chip-row">
      {TONES.map((t) => (
        <label key={t.id} className="chip">
          <input type="radio" name={name} value={t.id} checked={value === t.id} onChange={() => onChange(t.id)} disabled={disabled} />
          {t.label}
        </label>
      ))}
    </div>
  );
}
