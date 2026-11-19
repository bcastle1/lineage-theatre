import { useEffect, useRef } from "react";

// When a press opens another step, view or film, the page under a pointer that has not moved changes: the second
// press of a double click, or of a quick double tap, would land on whatever the new screen shows there (a
// consent box, the next step's main action, a navigation item). For a moment after such a change, presses
// are ignored everywhere in the document: half a second for any press, and a second and a half for a press
// the browser counts as part of a double click. Activation from the keyboard, from assistive technology and
// from script reports no press count: it is never ignored and never starts the quiet period.
const QUIET_ANY_MS = 500;
const QUIET_DOUBLE_MS = 1500;
// A change of screen counts as caused by a press when it follows that press this closely.
const PRESS_TO_CHANGE_MS = 500;

export function useQuietAfterPressedChange(screen: string) {
  // No press yet: a change of screen as the page loads (a redirect, a link) was not caused by one.
  const state = useRef({ any: 0, multi: 0, lastPress: -Infinity });
  useEffect(() => {
    if (typeof document === "undefined") return;
    // Whether the press under way began in the quiet period. A press is seen first as a pointer going
    // down, which does not know its press count, then as a mouse button going down, which does.
    let pressIgnored = false;
    const quiet = (count: number, at: number) =>
      count > 0 && at < (count > 1 ? Math.max(state.current.any, state.current.multi) : state.current.any);
    const onPointerDown = (event: PointerEvent) => {
      const now = performance.now();
      pressIgnored = quiet(1, now);
      // An ignored press does nothing at all: no focus change, caret or opened list. A switched-off
      // control sends nothing further, but would still take the focus.
      if (pressIgnored || (quiet(2, now) && (event.target as Element | null)?.closest?.(":disabled")))
        event.preventDefault();
    };
    const onMouseDown = (event: MouseEvent) => {
      pressIgnored = pressIgnored || quiet(event.detail, performance.now());
      if (pressIgnored) event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (event.detail === 0) return;
      const now = performance.now();
      const ignored = pressIgnored || quiet(event.detail, now);
      pressIgnored = false;
      if (ignored) {
        // Cancel the default action (a checkbox, label, link or disclosure) and keep it from every handler.
        event.preventDefault();
        event.stopPropagation();
        state.current.any = Math.max(state.current.any, Math.min(now + QUIET_ANY_MS, state.current.multi));
        return;
      }
      state.current.lastPress = now;
      // A first press that gets through starts a double press of its own.
      if (event.detail === 1) state.current.multi = 0;
    };
    // On the document and before anything else sees the press: what arrives under the pointer can be
    // anywhere on the page.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("click", onClick, true);
      state.current = { any: 0, multi: 0, lastPress: -Infinity };
    };
  }, []);
  const shown = useRef(screen);
  useEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    const now = performance.now();
    if (now - state.current.lastPress < PRESS_TO_CHANGE_MS)
      state.current = { ...state.current, any: now + QUIET_ANY_MS, multi: now + QUIET_DOUBLE_MS };
  }, [screen]);
}
