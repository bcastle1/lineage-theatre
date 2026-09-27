import { filmProductionProgress, type FilmProductionProgressInput } from "./film-production-progress";
import "./film-production-progress.css";

export default function FilmProductionProgress(props: FilmProductionProgressInput) {
  if (!props.paid) return null;
  const progress = filmProductionProgress(props);
  return <section className="film-production-progress" aria-label="Film production progress">
    <div className="film-production-progress-heading"><span>{progress.label}</span><span>{progress.percent === null ? "Not available" : `${progress.percent}%`}</span></div>
    <progress max={100} value={progress.percent ?? undefined} aria-label={progress.label}
      aria-valuetext={progress.percent === null ? progress.stage : `${progress.percent}% · ${progress.stage}`} />
    <p>{progress.stage}</p>
    <p className="field-note">{progress.explanation}</p>
  </section>;
}
