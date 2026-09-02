const DEFAULT_DISPLAY_MEDIA_SELECTION_TTL_MS = 15_000;

function normalizeSourceId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function supportsDisplayMediaSystemAudio(platform) {
  return platform === "win32";
}

function createDisplayMediaSelectionController(options = {}) {
  if (typeof options.getSources !== "function") {
    throw new TypeError("getSources must be a function.");
  }

  const getSources = options.getSources;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const platform = typeof options.platform === "string" ? options.platform : process.platform;
  const configuredTtlMs = Number(options.ttlMs);
  const ttlMs = Number.isFinite(configuredTtlMs) && configuredTtlMs >= 0
    ? configuredTtlMs
    : DEFAULT_DISPLAY_MEDIA_SELECTION_TTL_MS;

  let listGeneration = 0;
  let availableSources = new Map();
  let pendingSelection = null;

  function clear() {
    listGeneration += 1;
    availableSources = new Map();
    pendingSelection = null;
  }

  async function list(sourceOptions) {
    const generation = ++listGeneration;
    availableSources = new Map();
    pendingSelection = null;

    try {
      const listedSources = await getSources(sourceOptions);
      const sources = Array.isArray(listedSources) ? listedSources : [];

      if (generation !== listGeneration) {
        return [];
      }

      availableSources = new Map(
        sources.flatMap((source) => {
          const id = normalizeSourceId(source?.id);
          return id ? [[id, source]] : [];
        })
      );

      return sources;
    } catch (error) {
      if (generation === listGeneration) {
        clear();
      }
      throw error;
    }
  }

  function prepare(selection) {
    pendingSelection = null;
    const sourceId = normalizeSourceId(selection?.id);
    const source = sourceId ? availableSources.get(sourceId) : null;

    if (!source) {
      return false;
    }

    pendingSelection = {
      source,
      includeSystemAudio: Boolean(selection?.includeSystemAudio),
      createdAt: now()
    };
    return true;
  }

  function consumeGrant() {
    const selection = pendingSelection;
    clear();

    if (!selection || now() - selection.createdAt > ttlMs) {
      return null;
    }

    return {
      video: selection.source,
      ...(supportsDisplayMediaSystemAudio(platform) && selection.includeSystemAudio
        ? { audio: "loopback" }
        : {})
    };
  }

  return {
    clear,
    consumeGrant,
    list,
    prepare
  };
}

module.exports = {
  DEFAULT_DISPLAY_MEDIA_SELECTION_TTL_MS,
  createDisplayMediaSelectionController,
  supportsDisplayMediaSystemAudio
};
