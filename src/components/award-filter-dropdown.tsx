"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { toggleDirectorySelection } from "@/lib/award-directory-selection";
import styles from "./award-filter-dropdown.module.css";

type Option = { value: string; label: string };

export function AwardFilterDropdown({ id, label, options, value, onChange, describedBy }: {
  id: string;
  label: string;
  options: readonly Option[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  describedBy?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedLabels = options.filter(option => value.includes(option.value)).map(option => option.label);
  const summary = selectedLabels.length > 1 ? `${selectedLabels.length} selected` : selectedLabels[0] || "All";

  // Position the native top-layer popover without relying on CSS anchor support.
  // Keep it inside the viewport on small screens and flip above when necessary.
  const positionPanel = useCallback(() => {
    if (!trigger.current || !panel.current) return;
    const rect = trigger.current.getBoundingClientRect();
    if ((rect.bottom < 12 || rect.top > window.innerHeight - 12) && panel.current.matches(":popover-open")) {
      panel.current.hidePopover();
      return;
    }
    const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24);
    const below = Math.max(0, window.innerHeight - rect.bottom - 20);
    const above = Math.max(0, rect.top - 20);
    const placeAbove = below < 260 && above > below;
    const compactViewport = Math.max(above, below) < 180;
    Object.assign(panel.current.style, {
      width: `${width}px`,
      left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
      top: compactViewport ? "12px" : placeAbove ? "auto" : `${Math.max(12, rect.bottom + 8)}px`,
      bottom: compactViewport || !placeAbove ? "auto" : `${Math.max(12, window.innerHeight - rect.top + 8)}px`,
      maxHeight: `${Math.max(0, Math.min(420, compactViewport ? window.innerHeight - 24 : placeAbove ? above : below))}px`,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    // Search results and selected chips can resize the surrounding controls
    // without scrolling the page. Follow those layout changes as well.
    const observer = new ResizeObserver(positionPanel);
    const controls = trigger.current?.closest(".award-directory-controls");
    if (controls) observer.observe(controls);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [open, positionPanel]);

  return (
    <div className={`award-filter-control ${styles.control}`}>
      <span id={`${id}-label`} className={`award-filter-label ${styles.label}`}>{label}</span>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={styles.trigger}
        data-active={value.length > 0 || undefined}
        popoverTarget={`${id}-options`}
        aria-expanded={open}
        aria-controls={`${id}-options`}
        aria-label={`${label}: ${selectedLabels.join(", ") || "All"}`}
        aria-describedby={describedBy}
        onKeyDown={event => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            panel.current?.showPopover();
            const first = panel.current?.querySelector<HTMLInputElement>("input:checked") || panel.current?.querySelector<HTMLInputElement>('input[type="checkbox"]');
            first?.focus();
          }
        }}
      >
        <span className={styles.summary}>{summary}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <div
        ref={panel}
        id={`${id}-options`}
        className={styles.popover}
        popover="auto"
        role="group"
        aria-labelledby={`${id}-label`}
        onBeforeToggle={event => { if (event.newState === "open") positionPanel(); }}
        onToggle={event => setOpen(event.newState === "open")}
      >
        <p className={styles.hint}>Choose one or more</p>
        <div className={styles.options}>
          {options.map(option => (
            <label className={`award-filter-option ${styles.option}`} key={option.value}>
              <input
                type="checkbox"
                value={option.value}
                checked={value.includes(option.value)}
                onChange={() => onChange(toggleDirectorySelection(value, option.value))}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        <div className={styles.footer}>
          <button type="button" disabled={value.length === 0} onClick={() => onChange([])} aria-label={`Clear ${label.toLowerCase()}`}>Clear</button>
          <button type="button" popoverTarget={`${id}-options`} popoverTargetAction="hide">Done</button>
        </div>
      </div>
    </div>
  );
}
