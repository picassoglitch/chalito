import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n.js";
import { IpcUnavailableError } from "../../lib/ipc.js";
import {
  connectionsSearchIpc,
  type CheckView,
  type ConnectionsSearchIpc,
  type ConnectorEntry,
  type ConnectorRef,
  type InstalledView,
  type SearchItem,
  type SearchView,
} from "./search-ipc.js";

// ADR 0023 + owner decisions 2026-11-01: badges Verificado / Comunidad, OAuth "próximamente", one warning + one confirmation.

const ERRORS = new Set([
  "held_oauth",
  "warning_required",
  "already_installed",
  "missing_input",
  "bad_input",
  "bad_url",
  "command_not_found",
  "state_corrupt",
  "keychain",
  "unreachable",
  "not_found",
  "query_too_short",
  "registry_unreachable",
  "registry_bad_response",
]);

const Badge = ({ entry, held }: { entry: ConnectorEntry; held: boolean }) => {
  const t = useT();
  const kind = held ? "soon" : entry.source === "verified" ? "verified" : "community";
  return (
    <span className="badge" data-badge={kind}>
      {t(`connections.search.badge.${kind}`)}
    </span>
  );
};

/** What the person confirms once: the server, the unverified warning when it applies, and any token. */
const InstallDialog = ({
  check,
  busy,
  onInstall,
  onCancel,
}: {
  check: CheckView;
  busy: boolean;
  onInstall: (values: Record<string, string>) => void;
  onCancel: () => void;
}) => {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>({});
  const { entry, inputs } = check;
  const unverified = entry.source !== "verified";
  const where =
    "url" in entry.server && entry.server.url
      ? entry.server.url
      : "command" in entry.server
        ? [entry.server.command, ...entry.server.args].join(" ")
        : "";
  const missing = inputs.some((i) => i.required && !values[i.name]?.trim());
  return (
    <form
      role="dialog"
      aria-modal="true"
      aria-labelledby="connection-install-title"
      className="card"
      data-install-dialog={entry.source}
      onSubmit={(e) => {
        e.preventDefault();
        if (!missing) onInstall(values);
      }}
    >
      <h3 id="connection-install-title">{t("connections.search.install.title", { name: entry.name })}</h3>
      <p>
        <Badge entry={entry} held={false} /> <code className="mono">{where}</code>
      </p>
      {unverified && (
        <p className="warn" role="alert" data-unverified-warning>
          {t("connections.search.install.warning")}
        </p>
      )}
      {inputs.map((i) => (
        <label key={i.name}>
          {i.description || i.name}
          <input
            type={i.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            required={i.required}
            value={values[i.name] ?? ""}
            onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}
            aria-label={i.name}
          />
        </label>
      ))}
      {inputs.some((i) => i.secret) && <p className="muted">{t("connections.search.install.keychain")}</p>}
      <p className="muted">{t("connections.search.install.allAgents")}</p>
      <div className="row">
        <button type="submit" disabled={busy || missing}>
          {t(unverified ? "connections.search.install.confirmUnverified" : "connections.search.install.confirm")}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {t("connections.search.cancel")}
        </button>
      </div>
    </form>
  );
};

/** "Agregar la tuya": a remote server by URL or a local command (stdio). Always community rules. */
const AddYourOwn = ({ busy, onNext }: { busy: boolean; onNext: (ref: ConnectorRef) => void }) => {
  const t = useT();
  const [mode, setMode] = useState<"url" | "command">("url");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState(false);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const ready = name.trim() && (mode === "url" ? url.trim() : command.trim());
  return (
    <details data-add-own>
      <summary>{t("connections.search.own.title")}</summary>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready) return;
          onNext(
            mode === "url"
              ? { kind: "url", name: name.trim(), url: url.trim(), token }
              : {
                  kind: "command",
                  name: name.trim(),
                  command: command.trim(),
                  args: args.split("\n").filter((a) => a.trim() !== ""),
                  env: env
                    .split(/[\s,]+/)
                    .map((e) => e.trim())
                    .filter(Boolean),
                },
          );
        }}
      >
        <div className="row" role="radiogroup" aria-label={t("connections.search.own.mode")}>
          {(["url", "command"] as const).map((m) => (
            <label key={m}>
              <input type="radio" name="own-mode" checked={mode === m} onChange={() => setMode(m)} />
              {t(`connections.search.own.${m}`)}
            </label>
          ))}
        </div>
        <label>
          {t("connections.search.own.name")}
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </label>
        {mode === "url" ? (
          <>
            <label>
              {t("connections.search.own.urlLabel")}
              <input
                type="url"
                inputMode="url"
                placeholder="https://"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label>
              <input type="checkbox" checked={token} onChange={(e) => setToken(e.target.checked)} />
              {t("connections.search.own.token")}
            </label>
          </>
        ) : (
          <>
            <label>
              {t("connections.search.own.commandLabel")}
              <input spellCheck={false} value={command} onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label>
              {t("connections.search.own.args")}
              <textarea spellCheck={false} rows={3} value={args} onChange={(e) => setArgs(e.target.value)} />
            </label>
            <label>
              {t("connections.search.own.env")}
              <input spellCheck={false} value={env} onChange={(e) => setEnv(e.target.value)} />
            </label>
          </>
        )}
        <div className="row">
          <button type="submit" disabled={busy || !ready}>
            {t("connections.search.own.next")}
          </button>
        </div>
      </form>
    </details>
  );
};

/** Conexiones → search the MCP Registry, install, and add your own (ADR 0023). */
export const SearchSection = ({ ipc: given }: { ipc?: ConnectionsSearchIpc } = {}) => {
  const t = useT();
  const ipc = useRef(given ?? connectionsSearchIpc()).current;
  const [q, setQ] = useState("");
  const [view, setView] = useState<SearchView | null>(null);
  const [installed, setInstalled] = useState<InstalledView[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ ref: ConnectorRef; check: CheckView } | null>(null);
  const [held, setHeld] = useState<Set<string>>(new Set());
  const seq = useRef(0);

  const fail = useCallback((e: unknown) => {
    if (e instanceof IpcUnavailableError) setUnavailable(true);
    else {
      const code = e instanceof Error ? e.message : "internal";
      setError(ERRORS.has(code) ? code : "other");
    }
  }, []);

  const refreshInstalled = useCallback(() => ipc.installed().then(setInstalled, fail), [ipc, fail]);

  const run = useCallback(
    async (query: string, cursor?: string) => {
      const mine = ++seq.current;
      setBusy(true);
      try {
        const page = await ipc.search(query, cursor);
        if (mine !== seq.current) return; // a newer search answered first
        setError(null);
        setView((prev) =>
          cursor && prev
            ? { ...page, verified: prev.verified, community: [...prev.community, ...page.community] }
            : page,
        );
      } catch (e) {
        if (mine === seq.current) fail(e);
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    },
    [ipc, fail],
  );

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  // Waits for a pause in typing; the registry needs 3+ characters.
  useEffect(() => {
    const query = q.trim();
    if (query.length > 0 && query.length < 3) return;
    const h = setTimeout(() => void run(query), 350);
    return () => clearTimeout(h);
  }, [q, run]);

  const start = async (ref: ConnectorRef, key: string) => {
    setBusy(true);
    try {
      const check = await ipc.check(ref);
      setError(null);
      if (check.held && key.startsWith("own:")) setError("held_oauth");
      else if (check.held) setHeld(new Set(held).add(key));
      else setDialog({ ref, check });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const install = async (values: Record<string, string>) => {
    if (!dialog) return;
    setBusy(true);
    try {
      // The dialog showed the warning (when unverified) and this is the one confirmation.
      await ipc.install({
        ref: dialog.ref,
        values,
        confirmed: true,
        warningAccepted: dialog.check.entry.source !== "verified",
      });
      setDialog(null);
      setError(null);
      await refreshInstalled();
      await run(q.trim().length >= 3 ? q.trim() : "");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await ipc.uninstall(id);
      await refreshInstalled();
      setView((v) =>
        v
          ? {
              ...v,
              verified: v.verified.map((x) => (x.entry.id === id ? { ...x, installed: false } : x)),
              community: v.community.map((x) => (x.entry.id === id ? { ...x, installed: false } : x)),
            }
          : v,
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (unavailable)
    return (
      <section className="card" data-section="connections-search">
        <p className="muted">{t("connections.search.unavailable")}</p>
      </section>
    );

  const row = (item: SearchItem) => {
    const key = item.entry.source === "verified" ? `v:${item.entry.id}` : `c:${item.entry.id}`;
    const isHeld = !!item.entry.held || held.has(key);
    return (
      <li key={key} className="card" data-connector={item.entry.id} data-source={item.entry.source}>
        <div className="row">
          <strong>{item.entry.name}</strong>
          <Badge entry={item.entry} held={isHeld} />
        </div>
        {item.entry.description && <p className="muted">{item.entry.description}</p>}
        <p className="muted">
          {t(`connections.search.transport.${item.entry.transport}`)}
          {item.entry.auth === "token" ? ` · ${t("connections.search.needsToken")}` : ""}
        </p>
        {isHeld ? (
          <p className="muted" data-held>
            {t("connections.search.heldOauth")}
          </p>
        ) : item.installed ? (
          <p className="muted">{t("connections.search.installed")}</p>
        ) : (
          <div className="row">
            <button disabled={busy} onClick={() => void start(item.ref, key)}>
              {t("connections.search.install.button")}
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="card stack" aria-labelledby="connections-search-title" data-section="connections-search">
      <h2 id="connections-search-title">{t("connections.search.title")}</h2>
      <p className="muted">{t("connections.search.intro")}</p>
      <label>
        {t("connections.search.label")}
        <input
          type="search"
          value={q}
          placeholder={t("connections.search.placeholder")}
          onChange={(e) => setQ(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" data-error={error}>
          {t(`connections.search.error.${error}`)}
        </p>
      )}
      {view?.error && (
        <p className="warn" role="status">
          {t("connections.search.error.registry_unreachable")}
        </p>
      )}
      {dialog && (
        <InstallDialog
          check={dialog.check}
          busy={busy}
          onInstall={(v) => void install(v)}
          onCancel={() => setDialog(null)}
        />
      )}
      {installed.length > 0 && (
        <div data-group="installed">
          <h3>{t("connections.search.installedTitle")}</h3>
          <ul className="list">
            {installed.map((c) => (
              <li key={c.id} className="row" data-installed={c.id}>
                <strong>{c.name}</strong>
                <Badge entry={c} held={false} />
                <button disabled={busy} onClick={() => void remove(c.id)}>
                  {t("connections.search.remove")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {view && view.verified.length > 0 && (
        <div data-group="verified">
          <h3>{t("connections.search.verifiedTitle")}</h3>
          <ul className="list">{view.verified.map(row)}</ul>
        </div>
      )}
      {view && (
        <div data-group="community">
          <h3>{t("connections.search.communityTitle")}</h3>
          {view.community.length === 0 && !view.error && !busy && (
            <p className="muted">{t("connections.search.empty")}</p>
          )}
          <ul className="list">{view.community.map(row)}</ul>
          {view.nextCursor && (
            <button disabled={busy} onClick={() => void run(q.trim().length >= 3 ? q.trim() : "", view.nextCursor!)}>
              {t("connections.search.more")}
            </button>
          )}
        </div>
      )}
      <AddYourOwn busy={busy} onNext={(ref) => void start(ref, `own:${ref.kind}`)} />
    </section>
  );
};

export default SearchSection;
