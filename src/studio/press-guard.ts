import { useEffect, useRef } from "react";

// When a press opens another step, view or film, the page under a pointer that has not moved changes: the second
// press of a double click, or of a quick double tap, would land on whatever the new screen shows there (a
// consent box, a running time, the next step's main action, a navigation item, a Remove). For a moment after
// such a change, presses are ignored everywhere in the document: half a second for any press, and a second and a
// half for a press the browser counts as part of a double click or one that begins close to the press that
// changed the screen (a slow second tap, which the browser does not count, lands there). Activation from the
// keyboard, from assistive technology and from script reports no press count: it is never ignored and never
// starts the quiet period.
// The studio's Remove buttons ([data-remove]: a source, a character, a scene, an assumption) are kept from the
// second press of a double press the same way: after a Remove made with a pointer, the next item's Remove can
// come to rest under it, so a press on any Remove is ignored for two and a half seconds.
const QUIET_ANY_MS = 500;
const QUIET_DOUBLE_MS = 1500;
const QUIET_NEAR_MS = 1500, NEAR_PX = 40;
const REMOVE_GUARD_MS = 2500;
// A change of screen counts as caused by a press when it follows that press this closely.
const PRESS_TO_CHANGE_MS = 500;

// No press yet: a change of screen as the page loads (a redirect, a link) was not caused by one.
const idle = () => ({ any: 0, multi: 0, near: 0, removes: 0, lastPress: -Infinity, x: 0, y: 0, nearX: 0, nearY: 0 });

export function useQuietAfterPressedChange(screen: string) {
  const state = useRef(idle());
  useEffect(() => {
    if (typeof document === "undefined") return;
    // Whether the press under way began in the quiet period, and where it began. A press is seen first as a
    // pointer going down, which does not know its press count, then as a mouse button going down, which does.
    let pressIgnored = false, downX = 0, downY = 0;
    // When the press happened, not when a busy page got round to it.
    const pressTime = (event: Event) => Math.min(performance.now(), event.timeStamp > 0 ? event.timeStamp : Infinity);
    const quiet = (count: number, at: number, target: EventTarget | null) => {
      const s = state.current;
      if (count <= 0) return false;
      if (at < s.any || (count > 1 && at < s.multi)) return true;
      if (at < s.near && Math.hypot(downX - s.nearX, downY - s.nearY) <= NEAR_PX) return true;
      return at < s.removes && Boolean((target as Element | null)?.closest?.("[data-remove]"));
    };
    const onPointerDown = (event: PointerEvent) => {
      const now = pressTime(event);
      downX = event.clientX; downY = event.clientY;
      pressIgnored = quiet(1, now, event.target);
      // An ignored press does nothing at all: no focus change, caret or opened list. A switched-off
      // control sends nothing further, but would still take the focus.
      if (pressIgnored || (quiet(2, now, event.target) && (event.target as Element | null)?.closest?.(":disabled")))
        event.preventDefault();
    };
    const onMouseDown = (event: MouseEvent) => {
      pressIgnored = pressIgnored || quiet(event.detail, pressTime(event), event.target);
      if (pressIgnored) event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      if (event.detail === 0) return;
      const now = pressTime(event);
      const ignored = pressIgnored || quiet(event.detail, now, event.target);
      pressIgnored = false;
      if (ignored) {
        // Cancel the default action (a checkbox, label, link or disclosure) and keep it from every handler.
        event.preventDefault();
        event.stopPropagation();
        state.current.any = Math.max(state.current.any, Math.min(now + QUIET_ANY_MS, state.current.multi));
        return;
      }
      state.current.lastPress = now; state.current.x = downX; state.current.y = downY;
      // A first press that gets through starts a double press of its own.
      if (event.detail === 1) state.current.multi = 0;
      if ((event.target as Element | null)?.closest?.("[data-remove]")) state.current.removes = now + REMOVE_GUARD_MS;
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
      state.current = idle();
    };
  }, []);
  const shown = useRef(screen);
  useEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    const now = performance.now(), s = state.current;
    if (now - s.lastPress < PRESS_TO_CHANGE_MS)
      state.current = { ...s, any: now + QUIET_ANY_MS, multi: now + QUIET_DOUBLE_MS, near: now + QUIET_NEAR_MS, nearX: s.x, nearY: s.y };
  }, [screen]);
}
