export type LiveKitErrorDetails = {
  error?: string;
  errorName?: string;
  errorCode?: string | number;
  status?: string | number;
  closeCode?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function readNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

export function getLiveKitErrorDetails(error: unknown): LiveKitErrorDetails {
  if (error instanceof Error) {
    const record = error as Error & Record<string, unknown>;
    const errorCode = readString(record, ["code", "errorCode"]);
    const status = readNumber(record, ["status", "statusCode"]);
    const closeCode = readNumber(record, ["closeCode"]);

    return {
      error: error.message || error.name,
      errorName: error.name || undefined,
      errorCode: errorCode ?? undefined,
      status: status ?? undefined,
      closeCode: closeCode ?? undefined
    };
  }

  if (isRecord(error)) {
    const nested = "error" in error && error.error !== error
      ? getLiveKitErrorDetails(error.error)
      : {};
    const message = readString(error, ["message", "reason"]);
    const errorName = readString(error, ["name", "errorName"]);
    const stringCode = readString(error, ["code", "errorCode"]);
    const numericCode = readNumber(error, ["code", "errorCode"]);
    const status = readNumber(error, ["status", "statusCode"]);
    const closeCode = readNumber(error, ["closeCode"]);

    return {
      ...nested,
      error: message ?? nested.error,
      errorName: errorName ?? nested.errorName,
      errorCode: stringCode ?? numericCode ?? nested.errorCode,
      status: status ?? nested.status,
      closeCode: closeCode ?? nested.closeCode
    };
  }

  if (typeof error === "string" && error.trim()) {
    return { error: error.trim() };
  }

  return {};
}

export function getLiveKitErrorMessage(error: unknown, fallback = "LiveKit connection failed.") {
  return getLiveKitErrorDetails(error).error ?? fallback;
}

export function summarizeLiveKitLogContext(context: unknown) {
  if (!isRecord(context)) {
    return {} satisfies LiveKitErrorDetails;
  }

  const nestedError = "error" in context ? getLiveKitErrorDetails(context.error) : {};
  const directError = getLiveKitErrorDetails(context);

  return {
    ...directError,
    ...nestedError,
    closeCode: readNumber(context, ["closeCode", "code"]) ??
      nestedError.closeCode ??
      directError.closeCode,
    status: readString(context, ["state", "status"]) ??
      readNumber(context, ["status", "statusCode"]) ??
      nestedError.status ??
      directError.status
  } satisfies LiveKitErrorDetails;
}
