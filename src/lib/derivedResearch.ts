import {
  canonicalRecordKey,
  type ProjectV2CanonicalRecord,
  type ProjectV2DerivedPreviewRecord,
  type ProjectV2Manifest,
  type ProjectV2ScreenshotEvidenceRecord,
} from "../types/projectV2";

export interface DerivedResearchEntry {
  recordType: ProjectV2CanonicalRecord["recordType"];
  recordId: string;
  label: string;
  searchText: string;
}

export interface DerivedResearchIndex {
  cacheVersion: 1;
  entries: DerivedResearchEntry[];
}

const TEXT_FIELDS = [
  "title",
  "label",
  "description",
  "observation",
  "interpretation",
  "hypothesis",
  "followUp",
  "note",
  "game",
  "build",
  "platform",
  "level",
  "testLabel",
] as const;

export function buildDerivedResearchIndex(
  records: Record<string, ProjectV2CanonicalRecord>,
): DerivedResearchIndex {
  const entries = Object.values(records)
    .filter((record) => record.recordType !== "trash")
    .map((record) => {
      const valuesByField = record as Record<string, unknown>;
      const values = TEXT_FIELDS.flatMap((field) => {
        const value = valuesByField[field];
        return typeof value === "string" && value.trim() ? [value.trim()] : [];
      });
      return {
        recordType: record.recordType,
        recordId: record.id,
        label: values[0] ?? `${record.recordType} ${record.id}`,
        searchText: values.join("\n").normalize("NFKC").toLocaleLowerCase(),
      } satisfies DerivedResearchEntry;
    })
    .sort((left, right) =>
      canonicalRecordKey(left.recordType, left.recordId).localeCompare(
        canonicalRecordKey(right.recordType, right.recordId),
      ),
    );
  return { cacheVersion: 1, entries };
}

export function usableDerivedPreviews(
  manifest: ProjectV2Manifest,
  evidence: Record<string, ProjectV2ScreenshotEvidenceRecord>,
): ProjectV2DerivedPreviewRecord[] {
  return (manifest.derivedPreviews ?? []).filter((preview) => {
    const source = evidence[preview.evidenceId];
    return (
      source?.assetDigest === preview.sourceDigest &&
      /^[a-f0-9]{64}$/.test(preview.previewDigest)
    );
  });
}
