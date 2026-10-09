import { useState } from "react";
import { api } from "../studio/model";
import { libraryGenerationOrder, normalizeLibraryPage, type LibraryEntry } from "../studio/film-library";
import FilmGenerationStatus from "../studio/FilmGenerationStatus";

// Owner-only operator controls are mounted only in administration. Customer
// checkout and library use the sanitized progress snapshot, never this panel.
export default function FilmGenerationOperations({ disabled = false }: { disabled?: boolean }) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]), [selected, setSelected] = useState("");
  const [cursor, setCursor] = useState<string>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  async function load(more = false) {
    if (disabled || busy) return;
    setBusy(true); setError("");
    try {
      const page = normalizeLibraryPage(await api(`/api/library?view=active${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), "active");
      const next = page.entries.filter(entry => libraryGenerationOrder(entry));
      setEntries(current => more ? [...current.filter(entry => !next.some(row => row.id === entry.id)), ...next] : next);
      if (!more) setSelected("");
      setCursor(page.cursor); setLoaded(true);
    } catch { setError("The owner's paid film requests could not be loaded. Please refresh."); }
    finally { setBusy(false); }
  }
  const entry = entries.find(row => row.id === selected), order = entry ? libraryGenerationOrder(entry) : null;
  return <section className="admin-section" aria-label="Paid film production operations">
    <h2>Paid film production operations</h2>
    <p>Owner diagnostics and recovery for your saved paid films. Customers see Lineage Theatre progress and delivery estimates in their film library.</p>
    <button className="button secondary small" disabled={disabled || busy} onClick={() => void load()}>{busy ? "Loading requests…" : "Review paid film requests"}</button>
    {loaded && <label>Paid film<select value={selected} disabled={disabled || busy} onChange={event => setSelected(event.target.value)}>
      <option value="">Choose a saved paid film</option>{entries.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></label>}
    {loaded && !entries.length && <p>No active paid films were found on this page.</p>}
    {cursor && <button className="button secondary small" disabled={disabled || busy} onClick={() => void load(true)}>Load more requests</button>}
    {entry && order && entry.manifestHash && <FilmGenerationStatus key={`${entry.id}:${order.id}`} allowed={!disabled} preparedId={entry.id} filmId={entry.filmId} manifestHash={entry.manifestHash} orderId={order.id} onApproved={() => void load()} />}
    {error && <p role="alert">{error}</p>}
  </section>;
}
