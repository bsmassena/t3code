import type { ReactElement } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  providers: Symbol("providers"),
  upsert: Symbol("upsert"),
  delete: Symbol("delete"),
  runNow: Symbol("runNow"),
}));

const commands = vi.hoisted(() => ({
  upsert: vi.fn(),
  delete: vi.fn(),
  runNow: vi.fn(),
}));

const routing = vi.hoisted(() => ({
  settingsEnvironmentIds: [] as EnvironmentId[],
  providerEnvironmentIds: [] as EnvironmentId[],
}));

const task: ScheduledTask = {
  id: ScheduledTaskId.make("scheduled-task:test"),
  title: "Remote task",
  prompt: "Check the remote service",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("remote-project"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

const remoteProject: EnvironmentProject = {
  environmentId: EnvironmentId.make("remote-device"),
  id: task.projectId,
  title: "Remote project",
  workspaceRoot: "/work/remote-project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

const localProject: EnvironmentProject = {
  ...remoteProject,
  environmentId: EnvironmentId.make("local-device"),
  id: ProjectId.make("local-project"),
  title: "Local project",
  workspaceRoot: "C:\\work\\local-project",
};

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: vi.fn(),
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [],
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (environmentId: EnvironmentId) => {
    routing.settingsEnvironmentIds.push(environmentId);
    return DEFAULT_UNIFIED_SETTINGS;
  },
}));

vi.mock("../../state/query", () => ({
  formatEnvironmentQueryError: () => "Environment request failed.",
}));

vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: (environmentId: EnvironmentId) => {
      routing.providerEnvironmentIds.push(environmentId);
      return atoms.providers;
    },
    scheduledTasksLive: vi.fn(),
    upsertScheduledTask: atoms.upsert,
    deleteScheduledTask: atoms.delete,
    runScheduledTaskNow: atoms.runNow,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    if (atom === atoms.upsert) return commands.upsert;
    if (atom === atoms.delete) return commands.delete;
    return commands.runNow;
  },
}));

import { ScheduledTasksSettingsPanel } from "./ScheduledTasksSettings";

const environmentId = EnvironmentId.make("remote-device");

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function renderSettings(
  projects: ReadonlyArray<EnvironmentProject> = [],
  tasks = [{ environmentId, task }],
  defaultEnvironmentId = environmentId,
): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ScheduledTasksSettingsPanel({
    defaultEnvironmentId,
    projects,
    tasks,
    tasksError: null,
  }) as ReactElement<Record<string, unknown>>;
}

describe("scheduled task environment routing", () => {
  beforeEach(() => {
    hooks.reset();
    routing.settingsEnvironmentIds = [];
    routing.providerEnvironmentIds = [];
    commands.upsert.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.delete.mockReset().mockResolvedValue({ _tag: "Success" });
    commands.runNow.mockReset().mockResolvedValue({ _tag: "Success" });
  });

  it("reads configuration from the project environment", () => {
    renderSettings();

    expect(routing.settingsEnvironmentIds).toEqual([environmentId]);
    expect(routing.providerEnvironmentIds).toEqual([environmentId]);
  });

  it("keeps local and remote projects in the same project dropdown", () => {
    const panel = renderSettings([localProject, remoteProject]);
    const remoteOption = visitElements(
      panel,
      (element) =>
        element.props.children === remoteProject.title &&
        element.props.value === JSON.stringify([remoteProject.environmentId, remoteProject.id]),
    );

    expect(remoteOption).not.toBeNull();
  });

  it("infers the remote environment when a remote project is selected", async () => {
    const projects = [localProject, remoteProject];
    const localEnvironmentId = localProject.environmentId;
    const newButton = visitElements(
      renderSettings(projects, [], localEnvironmentId),
      (element) => Array.isArray(element.props.children) && element.props.children.includes("New"),
    );
    expect(newButton).not.toBeNull();
    (newButton?.props.onClick as (() => void) | undefined)?.();

    const projectSelect = visitElements(
      renderSettings(projects, [], localEnvironmentId),
      (element) =>
        element.props.value === JSON.stringify([localProject.environmentId, localProject.id]) &&
        typeof element.props.onValueChange === "function",
    );
    expect(projectSelect).not.toBeNull();
    (projectSelect?.props.onValueChange as ((value: string) => void) | undefined)?.(
      JSON.stringify([remoteProject.environmentId, remoteProject.id]),
    );

    const remoteDraft = renderSettings(projects, [], localEnvironmentId);
    const titleInput = visitElements(
      remoteDraft,
      (element) => element.props.id === "scheduled-task-title",
    );
    const promptInput = visitElements(
      remoteDraft,
      (element) => element.props.id === "scheduled-task-prompt",
    );
    const modelPicker = visitElements(
      remoteDraft,
      (element) => typeof element.props.onInstanceModelChange === "function",
    );
    (titleInput?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.({
      target: { value: "Remote schedule" },
    });
    (promptInput?.props.onChange as ((event: { target: { value: string } }) => void) | undefined)?.(
      {
        target: { value: "Check the remote service" },
      },
    );
    (
      modelPicker?.props.onInstanceModelChange as
        | ((instanceId: ProviderInstanceId, model: string) => void)
        | undefined
    )?.(ProviderInstanceId.make("codex"), "gpt-5");

    const createButton = visitElements(
      renderSettings(projects, [], localEnvironmentId),
      (element) => element.props.children === "Create task",
    );
    expect(createButton).not.toBeNull();
    (createButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.upsert).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ projectId: remoteProject.id }),
    });
    expect(routing.settingsEnvironmentIds).toContain(environmentId);
    expect(routing.providerEnvironmentIds).toContain(environmentId);
  });

  it("runs and deletes tasks through the environment that owns their list", async () => {
    const panel = renderSettings();
    const runButton = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Run Remote task",
    );
    const deleteButton = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Delete Remote task",
    );

    expect(runButton).not.toBeNull();
    expect(deleteButton).not.toBeNull();
    (runButton?.props.onClick as (() => void) | undefined)?.();
    (deleteButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.runNow).toHaveBeenCalledWith({ environmentId, input: { id: task.id } });
    expect(commands.delete).toHaveBeenCalledWith({ environmentId, input: { id: task.id } });
  });

  it("updates a task through the selected environment", async () => {
    const panel = renderSettings([remoteProject]);
    const editButton = visitElements(
      panel,
      (element) => element.props["aria-label"] === "Edit Remote task",
    );
    expect(editButton).not.toBeNull();
    (editButton?.props.onClick as (() => void) | undefined)?.();

    const editPanel = renderSettings([remoteProject]);
    const saveButton = visitElements(
      editPanel,
      (element) => element.props.children === "Save task",
    );
    expect(saveButton).not.toBeNull();
    (saveButton?.props.onClick as (() => void) | undefined)?.();
    await flushPromises();

    expect(commands.upsert).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ id: task.id, projectId: remoteProject.id }),
    });
  });
});
