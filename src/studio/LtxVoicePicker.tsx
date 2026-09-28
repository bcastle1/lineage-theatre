import { useState } from "react";
import voices from "../../shared/ltx-voices.json";

export const voiceName = (id: string) => voices.find(voice => voice.id === id)?.name || id;

export default function LtxVoicePicker({ value, onChange, label, inherit }: {
  value: string; onChange: (value: string) => void; label: string; inherit?: string;
}) {
  const selected = voices.find(voice => voice.id === (value || inherit));
  return <div className="ltx-voice-picker">
    <label className="field"><span>{label}</span><select value={value} onChange={event => onChange(event.target.value)}>
      {inherit && <option value="">Use film narrator · {voiceName(inherit)}</option>}
      {(["American", "British", "Classic"] as const).map(group => <optgroup key={group} label={group === "Classic" ? "Classic Windows voices" : `${group} English · Neural voices`}>
        {voices.filter(voice => group === "Classic" ? voice.engine === "Windows" : voice.engine === "Kokoro" && voice.accent === group)
          .map(voice => <option value={voice.id} key={voice.id}>{voice.name} · {voice.gender}{voice.id === "af_heart" ? " · Recommended" : ""}</option>)}
      </optgroup>)}
    </select></label>
    {selected && <VoiceSample key={selected.id} voice={selected} label={label} />}
  </div>;
}

function VoiceSample({ voice, label }: { voice: typeof voices[number]; label: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="ltx-voice-sample">
    <p className="field-note">{voice.name} · {voice.accent} English · {voice.engine === "Kokoro" ? "Neural narration" : "Classic narration"}</p>
    <audio controls preload="none" aria-label={`${label}: listen to ${voice.name}`} src={`/voices/${voice.id}.mp3`}
      onError={() => setFailed(true)} onPlay={event => {
        // Audition one voice at a time, including samples in other scene editors.
        const current = event.currentTarget;
        document.querySelectorAll<HTMLAudioElement>(".ltx-voice-sample audio").forEach(audio => { if (audio !== current) audio.pause(); });
      }} />
    <p className="field-note">{failed ? "This sample could not load. Reload the page to try again." : "Voice sample at normal pace. Your film reads the narration you enter below."}</p>
  </div>;
}
