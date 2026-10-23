import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("syntax highlighting preference", () => {
  it("persists the syntax highlighting preference and ignores unknown values", async () => {
    const storage = createStorage();
    vi.stubGlobal("window", { localStorage: storage });

    const { readSyntaxThemePreference, writeSyntaxThemePreference } = await import("./useTheme");

    expect(readSyntaxThemePreference()).toBe("t3-code");
    writeSyntaxThemePreference("vs-code");
    expect(readSyntaxThemePreference()).toBe("vs-code");

    storage.setItem("t3code:syntax-theme", "unknown");
    expect(readSyntaxThemePreference()).toBe("t3-code");
  });
});
