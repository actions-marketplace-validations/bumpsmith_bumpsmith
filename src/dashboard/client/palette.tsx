// The ⌘K command menu, built on cmdk (the same library and layout as poth's command menu).
// The rest of the dashboard is plain DOM; this one component is React, mounted into its own
// host element so the app's re-renders never touch it.
import { Command, defaultFilter } from "cmdk";
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

export interface PaletteItem {
  group: string;
  /** Icon markup from ui.ts icon(). */
  icon: string;
  title: string;
  meta?: string;
  run: () => void;
}

const SearchIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);
const EnterIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 10 4 15l5 5" />
    <path d="M20 4v7a4 4 0 0 1-4 4H4" />
  </svg>
);

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function Menu({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const mac = isMac();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, []);
  const groups = [...new Set(items.map((i) => i.group))];
  return (
    <>
      <div className="cmdk-overlay" onClick={onClose} aria-hidden="true" />
      <div className="cmdk-dialog" role="dialog" aria-modal="true" aria-label="Command menu">
        <Command
          className="cmdk"
          label="Command menu"
          loop
          // Match on what people read (title, version, group), never on the internal value.
          filter={(_value, search, keywords) => defaultFilter(keywords?.join(" ") ?? "", search)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        >
          <div className="cmdk-input-row">
            <span className="cmdk-search">
              <SearchIcon />
            </span>
            <Command.Input
              autoFocus
              className="cmdk-input"
              value={q}
              onValueChange={setQ}
              placeholder="Search upgrades, packages and actions"
              spellCheck={false}
            />
            <kbd className="cmdk-esc">Esc</kbd>
          </div>
          <Command.List className="cmdk-list">
            <Command.Empty className="cmdk-empty">No matches for “{q}”</Command.Empty>
            {groups.map((g) => (
              <Command.Group key={g} heading={g} className="cmdk-group">
                {items
                  .map((it, i) => ({ it, i }))
                  .filter(({ it }) => it.group === g)
                  .map(({ it, i }) => (
                    <Command.Item
                      key={i}
                      value={`${i}`}
                      keywords={[it.title, it.meta ?? "", it.group]}
                      className="cmdk-item"
                      onSelect={() => {
                        onClose();
                        it.run();
                      }}
                    >
                      <span
                        className="cmdk-icon"
                        // biome-ignore lint/security/noDangerouslySetInnerHtml: constant SVG from ui.ts icon(), never user input
                        dangerouslySetInnerHTML={{ __html: it.icon }}
                      />
                      <span className="cmdk-text">{it.title}</span>
                      {it.meta ? <em className="cmdk-meta">{it.meta}</em> : null}
                      <span className="cmdk-enter">
                        <EnterIcon />
                      </span>
                    </Command.Item>
                  ))}
              </Command.Group>
            ))}
          </Command.List>
          <div className="cmdk-foot">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd>to move
            </span>
            <span>
              <kbd>↵</kbd>to open
            </span>
            <span>
              <kbd>{mac ? "⌘" : "Ctrl"}</kbd>
              <kbd>K</kbd>to close
            </span>
          </div>
        </Command>
      </div>
    </>
  );
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let open = false;

export const paletteOpen = () => open;

export function closePalette() {
  if (!open) return;
  open = false;
  root?.render(null);
}

/** Open the menu with these items. Filtering matches titles, details and group names (cmdk). */
export function openPalette(items: PaletteItem[]) {
  if (!host) {
    host = document.createElement("div");
    host.id = "cmdk-host";
    document.body.append(host);
    root = createRoot(host);
  }
  open = true;
  root?.render(<Menu items={items} onClose={closePalette} />);
}

export function togglePalette(items: () => PaletteItem[]) {
  if (open) closePalette();
  else openPalette(items());
}
