export type StablePaginatedSnapshotErrorCode =
  | "query_error"
  | "exact_total_unavailable"
  | "total_changed"
  | "pagination_ended_early"
  | "duplicate_identity"
  | "snapshot_changed";

type PageResult<T> = {
  rows: T[];
  count: number | null;
  error: string | null;
};

type SnapshotPass<T> = {
  rows: T[];
  fingerprints: string[];
  exactTotal: number | null;
  includedTotal: number;
  errorCode: StablePaginatedSnapshotErrorCode | null;
  errorMessage: string | null;
};

export type StablePaginatedSnapshotResult<T> = {
  rows: T[];
  exactTotal: number | null;
  errorCode: StablePaginatedSnapshotErrorCode | null;
  errorMessage: string | null;
};

type Options<T> = {
  pageSize: number;
  renderLimit: number;
  loadPage: (start: number, end: number) => Promise<PageResult<T>>;
  identity: (row: T) => string;
  fingerprint: (row: T) => string;
  include?: (row: T) => boolean;
};

export async function loadStablePaginatedSnapshot<T>({
  pageSize,
  renderLimit,
  loadPage,
  identity,
  fingerprint,
  include = () => true,
}: Options<T>): Promise<StablePaginatedSnapshotResult<T>> {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error("pageSize must be a positive safe integer");
  }
  if (!Number.isSafeInteger(renderLimit) || renderLimit < 0) {
    throw new Error("renderLimit must be a non-negative safe integer");
  }

  const first = await scanSnapshotPass({
    pageSize,
    renderLimit,
    loadPage,
    identity,
    fingerprint,
    include,
  });
  if (first.errorCode) return resultFromPass(first);

  const second = await scanSnapshotPass({
    pageSize,
    renderLimit,
    loadPage,
    identity,
    fingerprint,
    include,
  });
  if (second.errorCode) {
    return {
      rows: first.rows,
      exactTotal: null,
      errorCode: second.errorCode,
      errorMessage: second.errorMessage,
    };
  }

  if (
    first.exactTotal !== second.exactTotal ||
    first.includedTotal !== second.includedTotal ||
    first.fingerprints.length !== second.fingerprints.length ||
    first.fingerprints.some((value, index) => value !== second.fingerprints[index])
  ) {
    return {
      rows: first.rows,
      exactTotal: null,
      errorCode: "snapshot_changed",
      errorMessage: null,
    };
  }

  return {
    rows: second.rows,
    exactTotal: second.includedTotal,
    errorCode: null,
    errorMessage: null,
  };
}

async function scanSnapshotPass<T>({
  pageSize,
  renderLimit,
  loadPage,
  identity,
  fingerprint,
  include,
}: Required<Pick<Options<T>, "pageSize" | "renderLimit" | "loadPage" | "identity" | "fingerprint">> & {
  include: (row: T) => boolean;
}): Promise<SnapshotPass<T>> {
  const rows: T[] = [];
  const fingerprints: string[] = [];
  const identities = new Set<string>();
  let expectedTotal: number | null = null;
  let includedTotal = 0;
  let start = 0;

  for (;;) {
    const page = await loadPage(start, start + pageSize - 1);
    if (page.error) {
      return failedPass(rows, fingerprints, includedTotal, "query_error", page.error);
    }
    if (
      page.count === null ||
      !Number.isSafeInteger(page.count) ||
      page.count < 0 ||
      page.count < start + page.rows.length
    ) {
      return failedPass(
        rows,
        fingerprints,
        includedTotal,
        "exact_total_unavailable",
      );
    }
    if (expectedTotal === null) expectedTotal = page.count;
    if (page.count !== expectedTotal) {
      return failedPass(rows, fingerprints, includedTotal, "total_changed");
    }
    if (page.rows.length === 0 && start < expectedTotal) {
      return failedPass(rows, fingerprints, includedTotal, "pagination_ended_early");
    }

    for (const row of page.rows) {
      const rowIdentity = identity(row);
      if (!rowIdentity || identities.has(rowIdentity)) {
        return failedPass(rows, fingerprints, includedTotal, "duplicate_identity");
      }
      identities.add(rowIdentity);
      fingerprints.push(`${rowIdentity}\u0000${fingerprint(row)}`);
      if (include(row)) {
        includedTotal += 1;
        if (rows.length < renderLimit) rows.push(row);
      }
    }

    start += page.rows.length;
    if (start >= expectedTotal) break;
  }

  if (fingerprints.length !== expectedTotal) {
    return failedPass(rows, fingerprints, includedTotal, "pagination_ended_early");
  }
  return {
    rows,
    fingerprints,
    exactTotal: expectedTotal,
    includedTotal,
    errorCode: null,
    errorMessage: null,
  };
}

function failedPass<T>(
  rows: T[],
  fingerprints: string[],
  includedTotal: number,
  errorCode: StablePaginatedSnapshotErrorCode,
  errorMessage: string | null = null,
): SnapshotPass<T> {
  return {
    rows,
    fingerprints,
    exactTotal: null,
    includedTotal,
    errorCode,
    errorMessage,
  };
}

function resultFromPass<T>(pass: SnapshotPass<T>): StablePaginatedSnapshotResult<T> {
  return {
    rows: pass.rows,
    exactTotal: null,
    errorCode: pass.errorCode,
    errorMessage: pass.errorMessage,
  };
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableJsonValue(child)]),
    );
  }
  return value;
}
