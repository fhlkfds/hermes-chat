// Keeping a modal dialog modal for the keyboard: Tab and Shift+Tab stay inside it, the app's shortcuts don't reach
// past it (App.tsx listens on the window, so stopping the key at the dialog is enough), and focus goes back where it
// was, or to `returnTo`, when it closes.
import { useEffect, type KeyboardEvent, type RefObject } from "react";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useModal(box: RefObject<HTMLElement | null>, returnTo?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : undefined;
    return () => {
      const back = returnTo?.current ?? before;
      if (back?.isConnected) back.focus();
    };
  }, []);
  return (e: KeyboardEvent) => {
    e.stopPropagation();
    const root = box.current;
    if (e.key !== "Tab" || !root) return;
    const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0);
    if (!items.length) return e.preventDefault();
    const active = document.activeElement;
    const outside = !root.contains(active);
    if (e.shiftKey && (outside || active === items[0])) {
      e.preventDefault();
      items[items.length - 1].focus();
    } else if (!e.shiftKey && (outside || active === items[items.length - 1])) {
      e.preventDefault();
      items[0].focus();
    }
  };
}
