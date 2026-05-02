export const OPEN_WORKSPACE_FILE_EVENT = "t3code:workspace-editor:open-file";

interface OpenWorkspaceFileEventDetail {
  readonly relativePath: string;
}

export function dispatchOpenWorkspaceFile(relativePath: string): void {
  window.dispatchEvent(
    new CustomEvent<OpenWorkspaceFileEventDetail>(OPEN_WORKSPACE_FILE_EVENT, {
      detail: { relativePath },
    }),
  );
}

export function isOpenWorkspaceFileEvent(
  event: Event,
): event is CustomEvent<OpenWorkspaceFileEventDetail> {
  if (!(event instanceof CustomEvent)) return false;
  const detail = event.detail as Partial<OpenWorkspaceFileEventDetail> | undefined;
  return typeof detail?.relativePath === "string" && detail.relativePath.length > 0;
}
