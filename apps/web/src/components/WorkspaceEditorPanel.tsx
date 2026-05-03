import type { EnvironmentId, ProjectListDirectoryEntry } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  PanelRightCloseIcon,
  Loader2Icon,
  RefreshCwIcon,
  Rows3Icon,
  SaveIcon,
  TextWrapIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { getSetiFileIconUrl } from "../file-explorer-icons";
import { refreshGitStatus, useGitStatus } from "../lib/gitStatusState";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { CodeEditor } from "./CodeEditor";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";
import { PatchDiffViewer } from "./PatchDiffViewer";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
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
  viewRequest?: { readonly view: WorkspaceEditorView; readonly requestId: number } | null;
  toggleShortcutLabel: string;
  onViewChange?: (view: WorkspaceEditorView) => void;
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

type WorkspaceEditorView = "project" | "git";
type GitDiffRenderMode = "stacked" | "split";

interface GitDiffState {
  readonly path: string;
  readonly patch: string;
  readonly loading: boolean;
  readonly error: string | null;
}

type GitDiffCache = Readonly<Record<string, string>>;

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

const EMPTY_PATCH = "";

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

function createUntrackedFilePatch(relativePath: string, contents: string): string {
  const lines = contents.length > 0 ? contents.replace(/\r\n/g, "\n").split("\n") : [];
  const lineCount = lines.at(-1) === "" ? Math.max(0, lines.length - 1) : lines.length;
  const addedLines = lines.slice(0, lineCount).map((line) => `+${line}`);
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lineCount} @@`,
    ...addedLines,
  ].join("\n");
}

function gitDiffCacheKey(relativePath: string, fullContext: boolean): string {
  return `${fullContext ? "full" : "hunks"}:${relativePath}`;
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
        "flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 px-2 text-left text-xs transition-colors hover:bg-accent/60",
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

function GitChangeRow(props: {
  path: string;
  insertions: number;
  deletions: number;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const slashIndex = props.path.lastIndexOf("/");
  const name = slashIndex >= 0 ? props.path.slice(slashIndex + 1) : props.path;
  const directory = slashIndex >= 0 ? props.path.slice(0, slashIndex) : "";

  return (
    <button
      type="button"
      className={cn(
        "flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 px-2 text-left text-xs transition-colors hover:bg-accent/60",
        props.selected && "bg-accent text-accent-foreground",
      )}
      title={props.path}
      onClick={() => props.onSelect(props.path)}
    >
      <ExplorerEntryIcon path={props.path} kind="file" />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground">{name}</span>
        {directory ? <span className="ml-1 text-muted-foreground">{directory}</span> : null}
      </span>
      <GitChangeCounts insertions={props.insertions} deletions={props.deletions} />
    </button>
  );
}

function GitChangeCounts(props: { readonly insertions: number; readonly deletions: number }) {
  if (props.insertions === 0 && props.deletions === 0) {
    return null;
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      {props.insertions > 0 ? (
        <span className="text-[11px] text-emerald-400">+{props.insertions}</span>
      ) : null}
      {props.deletions > 0 ? (
        <span className="text-[11px] text-red-400">-{props.deletions}</span>
      ) : null}
    </span>
  );
}

function workspaceEditorHeaderLabel(input: {
  readonly activeView: WorkspaceEditorView;
  readonly dirty: boolean;
  readonly openFile: OpenFileState | null;
  readonly selectedGitPath: string | null;
}): string {
  if (input.activeView === "git") {
    return input.selectedGitPath ? `Diff: ${input.selectedGitPath}` : "No changes selected";
  }
  if (!input.openFile) {
    return "No file open";
  }
  return `${input.openFile.path}${input.dirty ? " * Unsaved" : ""}`;
}

export function WorkspaceEditorPanel({
  environmentId,
  cwd,
  fallbackCwd,
  fallbackCwds = [],
  openFileRequest,
  viewRequest,
  toggleShortcutLabel,
  onViewChange,
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
  const [activeView, setActiveView] = useState<WorkspaceEditorView>("project");
  const [selectedGitPath, setSelectedGitPath] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffState | null>(null);
  const [gitDiffCache, setGitDiffCache] = useState<GitDiffCache>({});
  const [gitDiffRenderMode, setGitDiffRenderMode] = useState<GitDiffRenderMode>("stacked");
  const [gitDiffWordWrap, setGitDiffWordWrap] = useState(false);
  const [gitDiffFullContext, setGitDiffFullContext] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const pendingRestoredOpenFilePathRef = useRef<string | null>(null);
  const handledOpenFileRequestIdRef = useRef<number | null>(null);
  const handledViewRequestIdRef = useRef<number | null>(null);
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
  const gitStatus = useGitStatus({ environmentId, cwd: effectiveCwd });
  const gitFiles = useMemo(() => gitStatus.data?.workingTree.files ?? [], [gitStatus.data]);
  const trackedGitFiles = useMemo(() => gitFiles.filter((file) => file.tracked), [gitFiles]);
  const untrackedGitFiles = useMemo(() => gitFiles.filter((file) => !file.tracked), [gitFiles]);
  const selectedGitFile = useMemo(
    () => gitFiles.find((file) => file.path === selectedGitPath) ?? null,
    [gitFiles, selectedGitPath],
  );
  const gitFilesSignature = useMemo(
    () => gitFiles.map((file) => `${file.path}:${file.insertions}:${file.deletions}`).join("|"),
    [gitFiles],
  );
  const preloadedGitDiffs = useMemo(
    () =>
      gitFiles.flatMap((file) => {
        if (file.path === selectedGitPath) return [];
        const cacheKey = gitDiffCacheKey(file.path, gitDiffFullContext);
        const patch = gitDiffCache[cacheKey];
        return patch === undefined ? [] : [{ path: file.path, patch }];
      }),
    [gitDiffCache, gitDiffFullContext, gitFiles, selectedGitPath],
  );
  const headerLabel = workspaceEditorHeaderLabel({
    activeView,
    dirty,
    openFile,
    selectedGitPath,
  });
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

  const openProjectFileFromDiff = useCallback(
    (relativePath: string) => {
      const normalizedPath = relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
      const parentDirectories = ancestorDirectoryPaths(normalizedPath);
      setActiveView("project");
      if (parentDirectories.length > 0) {
        setExpandedDirectories((previous) => new Set([...previous, ...parentDirectories]));
      }
      for (const directoryPath of parentDirectories) {
        if (directoryEntries[directoryPath] || loadingDirectories.has(directoryPath)) continue;
        void loadDirectory(directoryPath);
      }
      void openFilePath(normalizedPath);
    },
    [directoryEntries, loadDirectory, loadingDirectories, openFilePath],
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
    if (activeView !== "git") return;
    if (selectedGitPath && gitFiles.some((file) => file.path === selectedGitPath)) return;
    setSelectedGitPath(gitFiles[0]?.path ?? null);
  }, [activeView, gitFiles, selectedGitPath]);

  useEffect(() => {
    setGitDiffCache({});
  }, [effectiveCwd, gitFilesSignature]);

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

  useEffect(() => {
    if (!viewRequest) return;
    if (handledViewRequestIdRef.current === viewRequest.requestId) return;
    handledViewRequestIdRef.current = viewRequest.requestId;
    setActiveView(viewRequest.view);
  }, [viewRequest]);

  useEffect(() => {
    onViewChange?.(activeView);
  }, [activeView, onViewChange]);

  const saveOpenFile = useCallback(async () => {
    if (!effectiveCwd || !openFile || !dirty) return;
    if (openFile.loading || openFile.saving) return;
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

  const refreshSidebar = useCallback(() => {
    if (activeView === "git") {
      void refreshGitStatus({ environmentId, cwd: effectiveCwd });
      return;
    }
    void loadDirectory(ROOT_PATH);
  }, [activeView, effectiveCwd, environmentId, loadDirectory]);

  const loadGitDiffPatch = useCallback(
    async (relativePath: string, fullContext: boolean) => {
      if (!effectiveCwd) return EMPTY_PATCH;
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        throw new Error("Environment API is unavailable.");
      }

      const result = await api.git.getWorktreeFileDiff({
        cwd: effectiveCwd,
        relativePath,
        fullContext,
      });
      if (result.patch.trim().length > 0) {
        return result.patch;
      }

      const file = await api.projects.readFile({ cwd: effectiveCwd, relativePath });
      return createUntrackedFilePatch(relativePath, file.contents);
    },
    [effectiveCwd, environmentId],
  );

  useEffect(() => {
    if (activeView !== "git" || !selectedGitPath) {
      setGitDiff(null);
      return;
    }

    const cacheKey = gitDiffCacheKey(selectedGitPath, gitDiffFullContext);
    const cachedPatch = gitDiffCache[cacheKey];
    if (cachedPatch !== undefined) {
      setGitDiff({ path: selectedGitPath, patch: cachedPatch, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setGitDiff({ path: selectedGitPath, patch: EMPTY_PATCH, loading: true, error: null });
    void loadGitDiffPatch(selectedGitPath, gitDiffFullContext)
      .then((patch) => {
        if (cancelled) return;
        setGitDiffCache((previous) => ({ ...previous, [cacheKey]: patch }));
        setGitDiff({ path: selectedGitPath, patch, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setGitDiff({
          path: selectedGitPath,
          patch: EMPTY_PATCH,
          loading: false,
          error: errorMessage(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [activeView, gitDiffCache, gitDiffFullContext, loadGitDiffPatch, selectedGitPath]);

  useEffect(() => {
    if (activeView !== "git" || gitFiles.length === 0) return;

    let cancelled = false;
    const missingFiles = gitFiles.filter(
      (file) => gitDiffCache[gitDiffCacheKey(file.path, gitDiffFullContext)] === undefined,
    );
    if (missingFiles.length === 0) return;

    const prefetch = async (): Promise<void> => {
      let nextIndex = 0;

      const prefetchWorker = async (): Promise<void> => {
        while (true) {
          if (cancelled) return;
          const file = missingFiles[nextIndex];
          nextIndex += 1;
          if (!file) return;

          try {
            const cacheKey = gitDiffCacheKey(file.path, gitDiffFullContext);
            const patch = await loadGitDiffPatch(file.path, gitDiffFullContext);
            if (cancelled) return;
            setGitDiffCache((previous) =>
              previous[cacheKey] === undefined ? { ...previous, [cacheKey]: patch } : previous,
            );
          } catch {
            // Ignore prefetch failures; selecting the file will surface the error.
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(4, missingFiles.length) }, () => prefetchWorker()),
      );
    };

    void prefetch();
    return () => {
      cancelled = true;
    };
  }, [activeView, gitDiffCache, gitDiffFullContext, gitFiles, loadGitDiffPatch]);

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
          <div className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{headerLabel}</div>
          {activeView === "git" && selectedGitFile ? (
            <GitChangeCounts
              insertions={selectedGitFile.insertions}
              deletions={selectedGitFile.deletions}
            />
          ) : null}
          {activeView === "git" ? (
            <div className="flex shrink-0 items-center gap-1">
              <ToggleGroup
                className="shrink-0"
                variant="outline"
                size="xs"
                value={[gitDiffRenderMode]}
                onValueChange={(value) => {
                  const next = value[0];
                  if (next === "stacked" || next === "split") {
                    setGitDiffRenderMode(next);
                  }
                }}
              >
                <Toggle aria-label="Stacked diff view" title="Stacked diff view" value="stacked">
                  <Rows3Icon className="size-3" />
                </Toggle>
                <Toggle aria-label="Split diff view" title="Split diff view" value="split">
                  <Columns2Icon className="size-3" />
                </Toggle>
              </ToggleGroup>
              <Toggle
                aria-label={
                  gitDiffFullContext ? "Show changed hunks only" : "Show full file context"
                }
                title={gitDiffFullContext ? "Show changed hunks only" : "Show full file context"}
                variant="outline"
                size="xs"
                pressed={gitDiffFullContext}
                onPressedChange={(pressed) => setGitDiffFullContext(Boolean(pressed))}
              >
                <FileTextIcon className="size-3" />
              </Toggle>
              <Toggle
                aria-label={
                  gitDiffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"
                }
                title={gitDiffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
                variant="outline"
                size="xs"
                pressed={gitDiffWordWrap}
                onPressedChange={(pressed) => setGitDiffWordWrap(Boolean(pressed))}
              >
                <TextWrapIcon className="size-3" />
              </Toggle>
            </div>
          ) : (
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
          )}
        </div>
        {activeView === "git" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            {gitDiff?.error ? (
              <div className="border-b border-border bg-destructive/8 px-3 py-2 text-destructive text-xs">
                {gitDiff.error}
              </div>
            ) : null}
            {gitDiff?.loading ? (
              <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                <Loader2Icon className="mr-2 size-4 animate-spin" />
                Loading diff...
              </div>
            ) : selectedGitPath ? (
              <DiffWorkerPoolProvider>
                <PatchDiffViewer
                  patch={gitDiff?.patch ?? EMPTY_PATCH}
                  cacheScope={`worktree:${effectiveCwd ?? ""}:${selectedGitPath}:${gitDiffFullContext ? "full" : "hunks"}`}
                  emptyLabel="No diff available for this file."
                  onOpenFile={openProjectFileFromDiff}
                  renderMode={gitDiffRenderMode}
                  showChangeOverview={gitDiffFullContext}
                  wordWrap={gitDiffWordWrap}
                />
                {preloadedGitDiffs.length > 0 ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none fixed top-0 -left-[10000px] h-[720px] w-[960px] overflow-hidden opacity-0"
                  >
                    {preloadedGitDiffs.map((entry) => (
                      <PatchDiffViewer
                        key={`${entry.path}:${gitDiffFullContext ? "full" : "hunks"}`}
                        patch={entry.patch}
                        cacheScope={`worktree:${effectiveCwd ?? ""}:${entry.path}:${gitDiffFullContext ? "full" : "hunks"}`}
                        emptyLabel=""
                        renderMode={gitDiffRenderMode}
                        wordWrap={gitDiffWordWrap}
                      />
                    ))}
                  </div>
                ) : null}
              </DiffWorkerPoolProvider>
            ) : (
              <div className="flex flex-1 items-center justify-center px-4 text-center text-muted-foreground text-sm">
                No worktree changes.
              </div>
            )}
          </div>
        ) : openFile ? (
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
                onSave={saveOpenFile}
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
          <div className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {activeView === "git" ? `${gitFiles.length} Changes` : "Files"}
          </div>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={activeView === "git" ? "Refresh git status" : "Refresh files"}
            title={activeView === "git" ? "Refresh git status" : "Refresh files"}
            onClick={refreshSidebar}
          >
            <RefreshCwIcon className={cn("size-3.5", gitStatus.isPending && "animate-spin")} />
          </Button>
        </div>
        {activeView === "project" && directoryError ? (
          <div className="border-b border-border px-2 py-1.5 text-muted-foreground text-xs">
            {directoryError}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {activeView === "git" ? (
            gitStatus.isPending && gitFiles.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
                <Loader2Icon className="size-3.5 animate-spin" />
                Loading changes...
              </div>
            ) : !gitStatus.data?.isRepo ? (
              <div className="px-3 py-2 text-muted-foreground text-xs">
                Current workspace is not a git repository.
              </div>
            ) : gitFiles.length === 0 ? (
              <div className="px-3 py-2 text-muted-foreground text-xs">No worktree changes.</div>
            ) : (
              <div className="space-y-3">
                {trackedGitFiles.length > 0 ? (
                  <div>
                    <div className="px-2 pb-1 text-[11px] text-muted-foreground">Tracked</div>
                    {trackedGitFiles.map((file) => (
                      <GitChangeRow
                        key={file.path}
                        path={file.path}
                        insertions={file.insertions}
                        deletions={file.deletions}
                        selected={selectedGitPath === file.path}
                        onSelect={setSelectedGitPath}
                      />
                    ))}
                  </div>
                ) : null}
                {untrackedGitFiles.length > 0 ? (
                  <div>
                    <div className="px-2 pb-1 text-[11px] text-muted-foreground">Untracked</div>
                    {untrackedGitFiles.map((file) => (
                      <GitChangeRow
                        key={file.path}
                        path={file.path}
                        insertions={file.insertions}
                        deletions={file.deletions}
                        selected={selectedGitPath === file.path}
                        onSelect={setSelectedGitPath}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            )
          ) : loadingDirectories.has(ROOT_PATH) && renderedEntries.length === 0 ? (
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
        <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-t border-border px-1">
          <Button
            size="icon-xs"
            variant={activeView === "project" ? "secondary" : "ghost"}
            aria-label="Project panel"
            title="Project panel"
            onClick={() => setActiveView("project")}
          >
            <FolderIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant={activeView === "git" ? "secondary" : "ghost"}
            aria-label="Git panel"
            title="Git panel"
            onClick={() => setActiveView("git")}
          >
            <GitBranchIcon className="size-3.5" />
          </Button>
        </div>
      </section>
    </aside>
  );
}
