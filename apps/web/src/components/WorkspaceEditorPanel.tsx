import type { EnvironmentId, ProjectListDirectoryEntry } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PanelRightCloseIcon,
  Loader2Icon,
  RefreshCwIcon,
  SaveIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { getSetiFileIconUrl } from "../file-explorer-icons";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { CodeEditor } from "./CodeEditor";
import { stackedThreadToast, toastManager } from "./ui/toast";

const ROOT_PATH = ".";
const WORKSPACE_EDITOR_STATE_STORAGE_PREFIX = "t3code:workspace-editor:v1:";
const DEFAULT_PANEL_WIDTH = 720;
const MIN_PANEL_WIDTH = 420;
const MIN_CHAT_WIDTH = 420;

interface WorkspaceEditorPanelProps {
  environmentId: EnvironmentId;
  cwd: string | null | undefined;
  fallbackCwd?: string | null | undefined;
  fallbackCwds?: ReadonlyArray<string | null | undefined>;
  openFileRequest?: { readonly relativePath: string; readonly requestId: number } | null;
  toggleShortcutLabel: string;
  onClose: () => void;
}

interface OpenFileState {
  readonly path: string;
  readonly savedContents: string;
  readonly draftContents: string;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly error: string | null;
}

interface PersistedWorkspaceEditorState {
  readonly openFilePath: string | null;
  readonly expandedDirectories: readonly string[];
  readonly panelWidth: number | null;
}

const EMPTY_ENTRIES: readonly ProjectListDirectoryEntry[] = [];
const DEFAULT_WORKSPACE_EDITOR_STATE: PersistedWorkspaceEditorState = {
  openFilePath: null,
  expandedDirectories: [ROOT_PATH],
  panelWidth: DEFAULT_PANEL_WIDTH,
};

function dirname(pathValue: string): string {
  const index = pathValue.lastIndexOf("/");
  return index === -1 ? ROOT_PATH : pathValue.slice(0, index);
}

function ancestorDirectoryPaths(pathValue: string): string[] {
  const directories: string[] = [];
  let current = dirname(pathValue);
  while (current !== ROOT_PATH) {
    directories.unshift(current);
    current = dirname(current);
  }
  return directories;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function joinPath(parentPath: string, name: string): string {
  return parentPath === ROOT_PATH ? name : `${parentPath}/${name}`;
}

function clampWorkspaceEditorPanelWidth(width: number): number {
  const maxWidth =
    typeof window === "undefined"
      ? 960
      : Math.max(MIN_PANEL_WIDTH, window.innerWidth - MIN_CHAT_WIDTH);
  return Math.min(Math.max(width, MIN_PANEL_WIDTH), maxWidth);
}

function workspaceEditorStateStorageKey(environmentId: EnvironmentId, cwd: string): string {
  return `${WORKSPACE_EDITOR_STATE_STORAGE_PREFIX}${environmentId}:${cwd}`;
}

function normalizeWorkspaceEditorState(input: unknown): PersistedWorkspaceEditorState {
  if (!input || typeof input !== "object") {
    return DEFAULT_WORKSPACE_EDITOR_STATE;
  }
  const parsed = input as Partial<PersistedWorkspaceEditorState>;
  const expandedDirectories =
    Array.isArray(parsed.expandedDirectories) && parsed.expandedDirectories.length > 0
      ? parsed.expandedDirectories.filter(
          (path): path is string => typeof path === "string" && path.length > 0,
        )
      : DEFAULT_WORKSPACE_EDITOR_STATE.expandedDirectories;
  const openFilePath =
    typeof parsed.openFilePath === "string" && parsed.openFilePath.length > 0
      ? parsed.openFilePath
      : null;
  const panelWidth =
    typeof parsed.panelWidth === "number" && Number.isFinite(parsed.panelWidth)
      ? clampWorkspaceEditorPanelWidth(parsed.panelWidth)
      : DEFAULT_PANEL_WIDTH;

  return {
    openFilePath,
    expandedDirectories: Array.from(new Set([ROOT_PATH, ...expandedDirectories])),
    panelWidth,
  };
}

function readWorkspaceEditorState(storageKey: string): PersistedWorkspaceEditorState {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_EDITOR_STATE;

  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? normalizeWorkspaceEditorState(JSON.parse(raw)) : DEFAULT_WORKSPACE_EDITOR_STATE;
  } catch {
    return DEFAULT_WORKSPACE_EDITOR_STATE;
  }
}

function writeWorkspaceEditorState(storageKey: string, state: PersistedWorkspaceEditorState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Ignore localStorage failures; the editor should remain usable without persistence.
  }
}

function EntryRow(props: {
  entry: ProjectListDirectoryEntry;
  depth: number;
  expanded: boolean;
  loading: boolean;
  selected: boolean;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const isDirectory = props.entry.kind === "directory";
  const Icon = props.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <button
      type="button"
      className={cn(
        "flex h-6 w-full min-w-0 items-center gap-1.5 px-2 text-left text-xs hover:bg-accent/60",
        props.selected && "bg-accent text-accent-foreground",
      )}
      style={{ paddingLeft: 8 + props.depth * 14 }}
      onClick={() =>
        isDirectory ? props.onToggleDirectory(props.entry.path) : props.onOpenFile(props.entry.path)
      }
      title={props.entry.path}
    >
      {isDirectory ? (
        props.loading ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        )
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <ExplorerEntryIcon path={props.entry.path} kind={props.entry.kind} />
      <span className="min-w-0 truncate">{props.entry.name}</span>
    </button>
  );
}

function ExplorerEntryIcon(props: { path: string; kind: "file" | "directory" }) {
  const [failedIconUrl, setFailedIconUrl] = useState<string | null>(null);
  if (props.kind === "directory") {
    return null;
  }
  const iconUrl = getSetiFileIconUrl(props.path);
  if (failedIconUrl === iconUrl) {
    return <span className="size-4 shrink-0" />;
  }
  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0"
      loading="lazy"
      onError={() => setFailedIconUrl(iconUrl)}
    />
  );
}

export function WorkspaceEditorPanel({
  environmentId,
  cwd,
  fallbackCwd,
  fallbackCwds = [],
  openFileRequest,
  toggleShortcutLabel,
  onClose,
}: WorkspaceEditorPanelProps) {
  const [directoryEntries, setDirectoryEntries] = useState<
    Record<string, readonly ProjectListDirectoryEntry[]>
  >({});
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set([ROOT_PATH]),
  );
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [resolvedCwd, setResolvedCwd] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<OpenFileState | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const pendingRestoredOpenFilePathRef = useRef<string | null>(null);
  const handledOpenFileRequestIdRef = useRef<number | null>(null);
  const restoredDirectoryLoadsRef = useRef<ReadonlySet<string>>(new Set());
  const hydratedWorkspaceStateKeyRef = useRef<string | null>(null);
  const loadVersionRef = useRef(0);
  const loadDirectoryRef = useRef<(relativePath: string) => Promise<void>>(async () => undefined);

  const dirty = openFile ? openFile.draftContents !== openFile.savedContents : false;
  const candidateCwds = useMemo(() => {
    const candidates: string[] = [];
    for (const value of [cwd, fallbackCwd, ...fallbackCwds]) {
      if (value && !candidates.includes(value)) {
        candidates.push(value);
      }
    }
    return candidates;
  }, [cwd, fallbackCwd, fallbackCwds]);
  const effectiveCwd = resolvedCwd ?? candidateCwds[0] ?? null;
  const workspaceStateStorageKey = useMemo(
    () =>
      candidateCwds[0] ? workspaceEditorStateStorageKey(environmentId, candidateCwds[0]) : null,
    [candidateCwds, environmentId],
  );

  const loadDirectory = useCallback(
    async (relativePath: string) => {
      if (!effectiveCwd) return;
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        setDirectoryError("Environment API is unavailable.");
        return;
      }

      setLoadingDirectories((previous) => new Set(previous).add(relativePath));
      setDirectoryError(null);
      try {
        const rootsToTry = relativePath === ROOT_PATH ? candidateCwds : [effectiveCwd];
        let result: Awaited<ReturnType<typeof api.projects.listDirectory>> | null = null;
        let successfulCwd: string | null = null;
        let lastError: unknown = null;
        for (const candidateCwd of rootsToTry) {
          try {
            result = await api.projects.listDirectory({ cwd: candidateCwd, relativePath });
            successfulCwd = candidateCwd;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!result || !successfulCwd) {
          throw lastError ?? new Error("Unable to list workspace directory.");
        }
        setResolvedCwd(successfulCwd);
        setDirectoryEntries((previous) => ({
          ...previous,
          [result.relativePath]: result.entries,
        }));
        if (result.truncated) {
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: "Directory listing truncated",
              description: result.relativePath,
            }),
          );
        }
      } catch (error) {
        setDirectoryError(errorMessage(error));
      } finally {
        setLoadingDirectories((previous) => {
          const next = new Set(previous);
          next.delete(relativePath);
          return next;
        });
      }
    },
    [candidateCwds, effectiveCwd, environmentId],
  );

  useEffect(() => {
    loadDirectoryRef.current = loadDirectory;
  }, [loadDirectory]);

  useEffect(() => {
    loadVersionRef.current += 1;
    const restoredState = workspaceStateStorageKey
      ? readWorkspaceEditorState(workspaceStateStorageKey)
      : DEFAULT_WORKSPACE_EDITOR_STATE;
    pendingRestoredOpenFilePathRef.current = restoredState.openFilePath;
    restoredDirectoryLoadsRef.current = new Set([ROOT_PATH]);
    hydratedWorkspaceStateKeyRef.current = null;
    setDirectoryEntries({});
    setExpandedDirectories(new Set(restoredState.expandedDirectories));
    setPanelWidth(restoredState.panelWidth ?? DEFAULT_PANEL_WIDTH);
    setLoadingDirectories(new Set());
    setDirectoryError(null);
    setResolvedCwd(null);
    setOpenFile(null);
    queueMicrotask(() => {
      hydratedWorkspaceStateKeyRef.current = workspaceStateStorageKey;
    });
    if (cwd || fallbackCwd) {
      void loadDirectoryRef.current(ROOT_PATH);
    }
  }, [cwd, fallbackCwd, fallbackCwds, workspaceStateStorageKey]);

  const openFilePath = useCallback(
    async (relativePath: string, options?: { skipDirtyPrompt?: boolean }) => {
      if (!effectiveCwd) return;
      if (!options?.skipDirtyPrompt && dirty && !window.confirm("Discard unsaved changes?")) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        toastManager.add({ type: "error", title: "Environment API is unavailable." });
        return;
      }

      const requestVersion = loadVersionRef.current;
      setOpenFile({
        path: relativePath,
        savedContents: "",
        draftContents: "",
        loading: true,
        saving: false,
        error: null,
      });
      try {
        const result = await api.projects.readFile({ cwd: effectiveCwd, relativePath });
        if (requestVersion !== loadVersionRef.current) return;
        setOpenFile({
          path: result.relativePath,
          savedContents: result.contents,
          draftContents: result.contents,
          loading: false,
          saving: false,
          error: null,
        });
      } catch (error) {
        if (requestVersion !== loadVersionRef.current) return;
        setOpenFile((previous) =>
          previous?.path === relativePath
            ? { ...previous, loading: false, error: errorMessage(error) }
            : previous,
        );
      }
    },
    [dirty, effectiveCwd, environmentId],
  );

  useEffect(() => {
    if (!workspaceStateStorageKey) return;
    if (hydratedWorkspaceStateKeyRef.current !== workspaceStateStorageKey) return;
    writeWorkspaceEditorState(workspaceStateStorageKey, {
      openFilePath: openFile?.path ?? null,
      expandedDirectories: Array.from(expandedDirectories),
      panelWidth,
    });
  }, [expandedDirectories, openFile?.path, panelWidth, workspaceStateStorageKey]);

  useEffect(() => {
    if (!effectiveCwd) return;
    if (!directoryEntries[ROOT_PATH]) return;

    for (const relativePath of expandedDirectories) {
      if (relativePath === ROOT_PATH) continue;
      if (directoryEntries[relativePath]) continue;
      if (loadingDirectories.has(relativePath)) continue;
      if (restoredDirectoryLoadsRef.current.has(relativePath)) continue;
      restoredDirectoryLoadsRef.current = new Set(restoredDirectoryLoadsRef.current).add(
        relativePath,
      );
      void loadDirectory(relativePath);
    }

    const restoredOpenFilePath = pendingRestoredOpenFilePathRef.current;
    if (!restoredOpenFilePath || openFile) return;
    pendingRestoredOpenFilePathRef.current = null;
    void openFilePath(restoredOpenFilePath, { skipDirtyPrompt: true });
  }, [
    directoryEntries,
    effectiveCwd,
    expandedDirectories,
    loadDirectory,
    loadingDirectories,
    openFile,
    openFilePath,
  ]);

  useEffect(() => {
    if (!openFileRequest) return;
    if (handledOpenFileRequestIdRef.current === openFileRequest.requestId) return;
    if (!effectiveCwd) return;
    if (!directoryEntries[ROOT_PATH]) return;

    handledOpenFileRequestIdRef.current = openFileRequest.requestId;
    const relativePath = openFileRequest.relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
    const parentDirectories = ancestorDirectoryPaths(relativePath);
    if (parentDirectories.length > 0) {
      setExpandedDirectories((previous) => new Set([...previous, ...parentDirectories]));
    }
    for (const directoryPath of parentDirectories) {
      if (directoryEntries[directoryPath] || loadingDirectories.has(directoryPath)) continue;
      void loadDirectory(directoryPath);
    }
    void openFilePath(relativePath);
  }, [
    directoryEntries,
    effectiveCwd,
    loadDirectory,
    loadingDirectories,
    openFilePath,
    openFileRequest,
  ]);

  const saveOpenFile = useCallback(async () => {
    if (!effectiveCwd || !openFile || !dirty) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      toastManager.add({ type: "error", title: "Environment API is unavailable." });
      return;
    }

    setOpenFile((previous) => (previous ? { ...previous, saving: true, error: null } : previous));
    try {
      const result = await api.projects.writeFile({
        cwd: effectiveCwd,
        relativePath: openFile.path,
        contents: openFile.draftContents,
      });
      setOpenFile((previous) =>
        previous?.path === openFile.path
          ? {
              ...previous,
              path: result.relativePath,
              savedContents: previous.draftContents,
              saving: false,
            }
          : previous,
      );
      void loadDirectory(dirname(openFile.path));
    } catch (error) {
      setOpenFile((previous) =>
        previous?.path === openFile.path
          ? { ...previous, saving: false, error: errorMessage(error) }
          : previous,
      );
    }
  }, [dirty, effectiveCwd, environmentId, loadDirectory, openFile]);

  const toggleDirectory = useCallback(
    (relativePath: string) => {
      setExpandedDirectories((previous) => {
        const next = new Set(previous);
        if (next.has(relativePath)) {
          next.delete(relativePath);
        } else {
          next.add(relativePath);
          if (!directoryEntries[relativePath]) {
            void loadDirectory(relativePath);
          }
        }
        return next;
      });
    },
    [directoryEntries, loadDirectory],
  );

  const startPanelResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panelWidth;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setPanelWidth(clampWorkspaceEditorPanelWidth(startWidth + startX - moveEvent.clientX));
      };
      const handlePointerUp = () => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [panelWidth],
  );

  const renderedEntries = useMemo(() => {
    const rows: Array<{ entry: ProjectListDirectoryEntry; depth: number }> = [];
    const visit = (parentPath: string, depth: number) => {
      for (const entry of directoryEntries[parentPath] ?? EMPTY_ENTRIES) {
        rows.push({ entry, depth });
        if (entry.kind === "directory" && expandedDirectories.has(entry.path)) {
          visit(joinPath(parentPath, entry.name), depth + 1);
        }
      }
    };
    visit(ROOT_PATH, 0);
    return rows;
  }, [directoryEntries, expandedDirectories]);

  if (candidateCwds.length === 0) {
    return null;
  }

  return (
    <aside
      className="relative hidden min-h-0 shrink-0 border-l border-border bg-background xl:flex"
      style={{ width: panelWidth }}
    >
      <div
        aria-label="Resize workspace editor"
        className="-left-1 absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none hover:bg-primary/20"
        role="separator"
        onPointerDown={startPanelResize}
      />
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 min-w-0 items-center gap-2 border-b border-border px-2">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Hide workspace editor"
            title={`Hide workspace editor (${toggleShortcutLabel})`}
            onClick={onClose}
          >
            <PanelRightCloseIcon className="size-3.5" />
          </Button>
          <div className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {openFile ? openFile.path : "No file open"}
            {dirty ? " * Unsaved" : ""}
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Save file"
            title="Save file"
            disabled={!dirty || openFile?.saving || openFile?.loading}
            onClick={saveOpenFile}
          >
            {openFile?.saving ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SaveIcon className="size-3.5" />
            )}
          </Button>
        </div>
        {openFile ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {openFile.error ? (
              <div className="border-b border-border bg-destructive/8 px-3 py-2 text-destructive text-xs">
                {openFile.error}
              </div>
            ) : null}
            {openFile.loading ? (
              <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                Loading file...
              </div>
            ) : (
              <CodeEditor
                path={openFile.path}
                value={openFile.draftContents}
                disabled={openFile.saving}
                onChange={(value) =>
                  setOpenFile((previous) =>
                    previous
                      ? {
                          ...previous,
                          draftContents: value,
                        }
                      : previous,
                  )
                }
              />
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-muted-foreground text-sm">
            Select a file from the explorer.
          </div>
        )}
      </section>

      <section className="flex min-h-0 w-64 shrink-0 flex-col border-l border-border bg-muted/20">
        <div className="flex h-9 items-center gap-2 border-b border-border px-2">
          <div className="min-w-0 flex-1 truncate text-muted-foreground text-xs">Files</div>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh files"
            title="Refresh files"
            onClick={() => void loadDirectory(ROOT_PATH)}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        {directoryError ? (
          <div className="border-b border-border px-2 py-1.5 text-muted-foreground text-xs">
            {directoryError}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {loadingDirectories.has(ROOT_PATH) && renderedEntries.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
              <Loader2Icon className="size-3.5 animate-spin" />
              Loading files...
            </div>
          ) : (
            renderedEntries.map(({ entry, depth }) => (
              <EntryRow
                key={entry.path}
                entry={entry}
                depth={depth}
                expanded={expandedDirectories.has(entry.path)}
                loading={loadingDirectories.has(entry.path)}
                selected={openFile?.path === entry.path}
                onToggleDirectory={toggleDirectory}
                onOpenFile={openFilePath}
              />
            ))
          )}
        </div>
      </section>
    </aside>
  );
}
