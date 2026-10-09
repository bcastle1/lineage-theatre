import { useEffect, useState } from "react";
import { filmProductionProgress, type FilmProductionProgressInput } from "./film-production-progress";
import "./film-production-progress.css";

const stages = [["queued", "Queued"], ["creating", "Creating your film"], ["finishing", "Finishing checks"], ["ready", "Ready to watch"]] as const;
const windowTime = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export default function FilmProductionProgress(props: FilmProductionProgressInput) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!props.paid || props.ready) return;
    const tick = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    const timer = setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [props.paid, props.ready]);
  if (!props.paid) return null;
  const progress = filmProductionProgress({ ...props, now: props.now ?? now });
  const current = stages.findIndex(([stage]) => stage === progress.stageKey);
  return <section className="film-production-progress" aria-label="Film production progress" data-timing={progress.timing}>
    <div className="film-production-progress-heading"><span>{progress.label}</span><span>{progress.percent === null ? "Paused" : `${progress.percent}%`}</span></div>
    {progress.percent === null ? <div className="film-progress-paused" role="progressbar" aria-label="Film production paused" aria-valuemin={0} aria-valuemax={100} aria-valuetext={progress.stage} />
      : <progress max={100} value={progress.percent} aria-label={progress.label} aria-valuetext={`${progress.percent}% · ${progress.stage}`} />}
    <p className="film-progress-stage" role="status">{progress.stage}</p>
    <ol className="film-progress-stages" aria-label="Film production stages">{stages.map(([key, label], index) =>
      <li key={key} data-complete={current > index || progress.stageKey === "ready"} aria-current={current === index ? "step" : undefined}><span aria-hidden="true">{index + 1}</span>{label}</li>)}</ol>
    <div className="film-progress-estimate"><span>Estimated delivery</span><p>{progress.remaining}</p>
      {progress.estimate && <p className="field-note">Delivery window: <time dateTime={progress.estimate.earliestAt}>{windowTime(progress.estimate.earliestAt)}</time> – <time dateTime={progress.estimate.latestAt}>{windowTime(progress.estimate.latestAt)}</time></p>}
    </div>
    <p className="field-note">{progress.explanation}</p>
    {progress.updatedAt && <p className="field-note">Last production update <time dateTime={progress.updatedAt}>{windowTime(progress.updatedAt)}</time>. This page updates automatically.</p>}
  </section>;
}
