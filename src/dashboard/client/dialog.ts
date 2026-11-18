// A centred dialog over a scrim, used for confirmations, MFA set-up and new API tokens. It
// lives outside the app's render loop, so background refreshes never wipe what is typed.
import { esc, icon } from "./ui.ts";

export interface DialogOptions {
  title: string;
  body: string;
  /** Primary button label; omit for a dialog that only has its own controls. */
  primary?: string;
  danger?: boolean;
  cancel?: string;
  /** Runs on submit; return an error message to stay open, or nothing to close. */
  onSubmit?: (el: HTMLElement) => Promise<string | void> | string | void;
  onOpen?: (el: HTMLElement, close: (ok: boolean) => void) => void;
  wide?: boolean;
}

export function openDialog(o: DialogOptions): Promise<boolean> {
  const prev = document.activeElement as HTMLElement | null;
  const host = document.createElement("div");
  host.className = "dialog-host";
  host.innerHTML = `<div class="scrim anim"></div>
    <div class="dialog anim${o.wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <form class="dialog-f" novalidate>
        <div class="dialog-h"><h3 id="dlg-t">${esc(o.title)}</h3><button type="button" class="btn icon ghost" data-close aria-label="Close">${icon("x")}</button></div>
        <div class="dialog-b">${o.body}<div class="auth-err" role="alert" hidden></div></div>
        ${o.primary ? `<div class="dialog-a"><button type="button" class="btn" data-close>${esc(o.cancel ?? "Cancel")}</button><button type="submit" class="btn ${o.danger ? "danger" : "primary"}">${esc(o.primary)}</button></div>` : ""}
      </form>
    </div>`;
  document.body.append(host);
  const form = host.querySelector("form") as HTMLFormElement;
  const err = host.querySelector<HTMLElement>(".auth-err") as HTMLElement;
  return new Promise((resolve) => {
    let done = false;
    const close = (ok: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      host.remove();
      prev?.focus?.();
      resolve(ok);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(false);
      }
      if (e.key === "Tab") {
        // Keep focus inside the dialog.
        const f = [
          ...host.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]"),
        ].filter((x) => !x.hasAttribute("disabled"));
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    for (const b of host.querySelectorAll("[data-close]"))
      b.addEventListener("click", () => close(false));
    host.querySelector(".scrim")?.addEventListener("click", () => close(false));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!o.onSubmit) return close(true);
      const btn = form.querySelector<HTMLButtonElement>("button[type=submit]");
      if (btn) btn.disabled = true;
      err.hidden = true;
      try {
        const msg = await o.onSubmit(host);
        if (msg) {
          err.hidden = false;
          err.innerHTML = `${icon("alertCircle")}<span>${esc(msg)}</span>`;
        } else close(true);
      } catch (x) {
        err.hidden = false;
        err.innerHTML = `${icon("alertCircle")}<span>${esc((x as Error).message)}</span>`;
      } finally {
        if (btn) btn.disabled = false;
      }
    });
    o.onOpen?.(host, close);
    (
      host.querySelector<HTMLElement>(
        ".dialog-b input, .dialog-b button, .dialog-a button[type=submit]",
      ) ?? host.querySelector<HTMLElement>("[data-close]")
    )?.focus();
  });
}

export const confirmDialog = (title: string, text: string, primary: string, danger = false) =>
  openDialog({ title, body: `<p class="dialog-p">${esc(text)}</p>`, primary, danger });
