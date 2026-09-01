import assert from "node:assert/strict";
import test from "node:test";

const STORAGE_KEY = "sovchat.audio-settings";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  constructor(initialValues: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initialValues)) {
      this.values.set(key, value);
    }
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

let importSequence = 0;

async function withAudioSettingsStore<T>(
  storage: MemoryStorage,
  task: (store: typeof import("../lib/audio-settings-store.ts").audioSettingsStore) => T | Promise<T>
) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage }
  });

  try {
    importSequence += 1;
    const module = await import(
      `../lib/audio-settings-store.ts?audio-settings-test=${importSequence}`
    );
    return await task(module.audioSettingsStore);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
}

test("enhanced local noise filtering defaults to enabled", async () => {
  await withAudioSettingsStore(new MemoryStorage(), (store) => {
    assert.equal(store.getState().noiseFilterEnabled, true);
  });
});

test("existing clients are force-enabled once and can opt out afterward", async () => {
  const storage = new MemoryStorage({
    [STORAGE_KEY]: JSON.stringify({
      selectedInputId: "existing-microphone",
      noiseFilterEnabled: false
    })
  });

  await withAudioSettingsStore(storage, (store) => {
    const migratedState = store.getState();
    assert.equal(migratedState.noiseFilterEnabled, true);
    assert.equal(migratedState.selectedInputId, "existing-microphone");

    const migratedSettings = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}") as {
      noiseFilterDefaultRevision?: number;
      noiseFilterEnabled?: boolean;
    };
    assert.equal(migratedSettings.noiseFilterDefaultRevision, 1);
    assert.equal(migratedSettings.noiseFilterEnabled, true);

    store.patch({ noiseFilterEnabled: false });
  });

  await withAudioSettingsStore(storage, (store) => {
    assert.equal(store.getState().noiseFilterEnabled, false);
  });
});
