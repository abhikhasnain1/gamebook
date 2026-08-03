import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rel = (...parts) => path.join(root, ...parts);
const paths = {
  projectSchema: rel("docs/schemas/project-v2.schema.json"),
  settingsSchema: rel("docs/schemas/global-settings-v1.schema.json"),
  workspaceSchema: rel("docs/schemas/workspace-v1.schema.json"),
  migrationSchema: rel("docs/schemas/migration-repair-v1.schema.json"),
  projectFixture: rel("docs/schemas/fixtures/project-v2-records.valid.json"),
  supportFixture: rel("docs/schemas/fixtures/workspace-settings-migration.valid.json"),
  invalidFixture: rel("docs/schemas/fixtures/project-v2.invalid.json"),
};

const fail = (message) => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const clone = (value) => structuredClone(value);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const digest = async (file) => {
  const canonicalText = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
  return createHash("sha256").update(canonicalText, "utf8").digest("hex");
};

function resolveRef(rootSchema, ref) {
  assert(ref.startsWith("#/"), `Only local schema references are allowed: ${ref}`);
  return ref.slice(2).split("/").reduce((value, segment) => {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    assert(value && Object.hasOwn(value, key), `Unresolved schema reference: ${ref}`);
    return value[key];
  }, rootSchema);
}

function isType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function schemaErrors(schema, value, rootSchema = schema, at = "$") {
  const errors = [];
  const visit = (node, current, location) => {
    if (node.$ref) return visit(resolveRef(rootSchema, node.$ref), current, location);
    if (node.allOf) for (const child of node.allOf) visit(child, current, location);
    if (node.anyOf) {
      const branches = node.anyOf.map((child) => schemaErrors(child, current, rootSchema, location));
      if (!branches.some((branch) => branch.length === 0)) errors.push(`${location}: no anyOf branch matched`);
    }
    if (node.oneOf) {
      const matches = node.oneOf.filter((child) => schemaErrors(child, current, rootSchema, location).length === 0).length;
      if (matches !== 1) errors.push(`${location}: expected one oneOf match, received ${matches}`);
    }
    if (node.if) {
      const matched = schemaErrors(node.if, current, rootSchema, location).length === 0;
      if (matched && node.then) visit(node.then, current, location);
      if (!matched && node.else) visit(node.else, current, location);
    }
    if (node.not && schemaErrors(node.not, current, rootSchema, location).length === 0) errors.push(`${location}: forbidden schema matched`);
    if (Object.hasOwn(node, "const") && !equal(current, node.const)) errors.push(`${location}: const mismatch`);
    if (node.enum && !node.enum.some((entry) => equal(entry, current))) errors.push(`${location}: enum mismatch`);
    if (node.type) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.some((type) => isType(current, type))) {
        errors.push(`${location}: expected ${types.join("|")}`);
        return;
      }
    }
    if (typeof current === "string") {
      if (node.minLength !== undefined && current.length < node.minLength) errors.push(`${location}: shorter than minLength`);
      if (node.maxLength !== undefined && current.length > node.maxLength) errors.push(`${location}: longer than maxLength`);
      if (node.pattern && !new RegExp(node.pattern).test(current)) errors.push(`${location}: pattern mismatch`);
      if (node.format === "date-time" && Number.isNaN(Date.parse(current))) errors.push(`${location}: invalid date-time`);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) errors.push(`${location}: non-finite number`);
      if (node.minimum !== undefined && current < node.minimum) errors.push(`${location}: below minimum`);
      if (node.maximum !== undefined && current > node.maximum) errors.push(`${location}: above maximum`);
      if (node.exclusiveMinimum !== undefined && current <= node.exclusiveMinimum) errors.push(`${location}: not above exclusiveMinimum`);
      if (node.exclusiveMaximum !== undefined && current >= node.exclusiveMaximum) errors.push(`${location}: not below exclusiveMaximum`);
    }
    if (Array.isArray(current)) {
      if (node.minItems !== undefined && current.length < node.minItems) errors.push(`${location}: too few items`);
      if (node.maxItems !== undefined && current.length > node.maxItems) errors.push(`${location}: too many items`);
      if (node.uniqueItems && new Set(current.map(JSON.stringify)).size !== current.length) errors.push(`${location}: duplicate items`);
      if (node.items) current.forEach((item, index) => visit(node.items, item, `${location}[${index}]`));
    }
    if (current && typeof current === "object" && !Array.isArray(current)) {
      if (node.required) for (const key of node.required) if (!Object.hasOwn(current, key)) errors.push(`${location}: missing ${key}`);
      if (node.maxProperties !== undefined && Object.keys(current).length > node.maxProperties) errors.push(`${location}: too many properties`);
      const properties = node.properties ?? {};
      for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(current, key)) visit(child, current[key], `${location}.${key}`);
      if (node.additionalProperties === false) {
        for (const key of Object.keys(current)) if (!Object.hasOwn(properties, key)) errors.push(`${location}: additional property ${key}`);
      } else if (node.additionalProperties && typeof node.additionalProperties === "object") {
        for (const key of Object.keys(current)) if (!Object.hasOwn(properties, key)) visit(node.additionalProperties, current[key], `${location}.${key}`);
      }
    }
  };
  visit(schema, value, at);
  return errors;
}

function verifySchemaShape(schemas) {
  const { project, settings, workspace, migration } = schemas;
  assert(project.$schema.endsWith("2020-12/schema"), "Project schema must use JSON Schema 2020-12");
  assert(project.$id === "urn:gamebook:schema:project:v2", "Project schema ID changed");
  assert(settings.$id === "urn:gamebook:schema:global-settings:v1", "Settings schema ID changed");
  assert(workspace.$id === "urn:gamebook:schema:workspace:v1", "Workspace schema ID changed");
  assert(migration.$id === "urn:gamebook:schema:migration-repair:v1", "Migration schema ID changed");
  const canonical = ["manifest", "asset", "evidence", "timeline", "page", "placement", "annotation", "finding", "tag", "collection", "relationship", "session", "trashRecord"];
  for (const key of canonical) assert(project.$defs[key], `Missing canonical schema definition: ${key}`);
  for (const key of ["evidence", "timeline", "page", "finding", "tag", "collection", "relationship", "session", "trashRecord"])
    assert(project.$defs[key].required.includes("recordVersion"), `${key} must require recordVersion`);
  assert(project.$defs.manifest.properties.formatVersion.const === 2, "Manifest major version must be 2");
  assert(project.$defs.placement.additionalProperties === false, "Placement runtime fields must fail closed");
  assert(equal(Object.keys(project.$defs.placement.properties).sort(), ["angle", "crop", "evidenceId", "id", "left", "placementVersion", "posterTimestampUs", "scaleX", "scaleY", "top", "type", "zIndex"].sort()), "Placement fields differ from ADR-0001");
  assert(project.$defs.trashRecord.additionalProperties === false && !project.$defs.trashRecord.properties.autoDelete, "Trash cannot persist automatic deletion state");
  assert(settings.properties.capture.properties.includeMicrophone.type === "boolean", "Microphone setting must remain user-configurable");
  assert(settings.properties.capture.allOf?.length === 1, "Microphone consent conditional is required");
  assert(workspace.$defs.workspaceState.properties.protectedClasses.items.enum.includes("project-trash"), "Workspace must protect Project Trash");
  assert(migration.$defs.migrationReport.properties.sourceMutated.const === false, "Migration must not mutate its source");
  assert(migration.$defs.repairReport.properties.mode.const === "read-only", "Repair must remain read-only");
  assert(migration.$defs.repairReport.properties.inventedReplacements.const === false, "Repair must not invent replacements");
  for (const schema of Object.values(schemas)) {
    const refs = JSON.stringify(schema).match(/#\/[^"\\]+/g) ?? [];
    for (const ref of refs) resolveRef(schema, ref);
  }
}

function archiveCodes(fixture) {
  const codes = new Set();
  const entries = fixture.archiveEntries ?? [];
  if ((fixture.declaredEntryCount ?? entries.length) > 250000) codes.add("archive-entry-limit");
  const names = new Set();
  for (const entry of entries) {
    const name = entry.name;
    const segments = name.split("/");
    const unsafe = !name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || segments.includes("..") || segments.includes("") || segments.some((segment) => segment.includes(":"));
    if (unsafe) codes.add("archive-path-unsafe");
    const normalized = name.toLowerCase();
    if (names.has(normalized)) codes.add("archive-name-duplicate");
    names.add(normalized);
    if (entry.kind === "json" && entry.uncompressedBytes > 16 * 1024 * 1024) codes.add("archive-json-limit");
    if (entry.kind === "preview" && entry.uncompressedBytes > 32 * 1024 * 1024) codes.add("archive-preview-limit");
    if (["symlink", "hardlink", "reparse"].includes(entry.linkType)) codes.add("archive-path-unsafe");
  }
  return codes;
}

function semanticCodes(fixture) {
  const codes = archiveCodes(fixture);
  const records = fixture.records ?? [];
  const byId = new Map();
  for (const record of records) {
    if (byId.has(record.id)) codes.add("record-id-duplicate");
    byId.set(record.id, record);
  }
  const active = records.filter((record) => record.recordType !== "trash");
  const byType = (type) => active.filter((record) => record.recordType === type);
  const assets = fixture.manifest.assets;
  if (new Set(assets.map((asset) => asset.digest)).size !== assets.length) codes.add("asset-digest-duplicate");
  const assetDigests = new Set(assets.map((asset) => asset.digest));
  for (const evidence of byType("evidence")) if (evidence.assetDigest && !assetDigests.has(evidence.assetDigest)) codes.add("asset-reference-missing");

  const orderMap = { pages: "page", evidence: "evidence", timelines: "timeline", findings: "finding", tags: "tag", collections: "collection", relationships: "relationship", sessions: "session", trash: "trash" };
  for (const [list, type] of Object.entries(orderMap)) {
    const expected = records.filter((record) => record.recordType === type).map((record) => record.id);
    const actual = fixture.manifest.recordOrder[list];
    if (expected.length !== actual.length || expected.some((id) => !actual.includes(id))) codes.add("record-order-invalid");
  }
  if (fixture.manifest.activePageId && !byId.has(fixture.manifest.activePageId)) codes.add("record-reference-missing");

  const evidenceIds = new Set(byType("evidence").map((record) => record.id));
  const tagIds = new Set(byType("tag").map((record) => record.id));
  const sessionIds = new Set(byType("session").map((record) => record.id));
  for (const evidence of byType("evidence")) {
    if (evidence.sessionId && !sessionIds.has(evidence.sessionId)) codes.add("record-reference-missing");
    if (evidence.tagIds.some((id) => !tagIds.has(id))) codes.add("record-reference-missing");
    if (evidence.kind === "clip" && evidence.sourceStartUs >= evidence.sourceEndUs) codes.add("clip-range-invalid");
    if (["clip", "frame"].includes(evidence.kind) && !evidenceIds.has(evidence.sourceVideoId)) codes.add("record-reference-missing");
  }
  for (const timeline of byType("timeline")) {
    let priorIndex = -1;
    let priorPts = -1;
    for (const entry of timeline.entries) {
      if (entry.sampleIndex <= priorIndex || entry.sourceTimestamp100ns <= priorPts || entry.timestampUs !== Math.floor(entry.sourceTimestamp100ns / 10)) codes.add("timeline-identity-invalid");
      priorIndex = entry.sampleIndex;
      priorPts = entry.sourceTimestamp100ns;
    }
    const source = byId.get(timeline.evidenceId);
    if (!source || source.kind !== "video" || source.video.timelineId !== timeline.id) codes.add("record-reference-missing");
  }
  for (const page of byType("page")) {
    const objectIds = new Set([...page.placements, ...page.annotations].map((item) => item.id));
    if (page.primaryEvidenceId && !evidenceIds.has(page.primaryEvidenceId)) codes.add("record-reference-missing");
    for (const placement of page.placements) if (!evidenceIds.has(placement.evidenceId)) codes.add("record-reference-missing");
    if (!equal(page.annotationOrder, page.annotations.map((annotation) => annotation.id))) codes.add("annotation-order-invalid");
    for (const annotation of page.annotations) if (annotation.scope.kind === "time" && (!evidenceIds.has(annotation.scope.evidenceId) || annotation.scope.startUs > annotation.scope.endUs)) codes.add("record-reference-missing");
    for (const connector of page.connectors) if (!objectIds.has(connector.start.objectId) || !objectIds.has(connector.end.objectId)) codes.add("record-reference-missing");
  }
  const normalizedTags = byType("tag").map((tag) => tag.normalizedName.normalize("NFKC").trim().toLocaleLowerCase("en-US"));
  if (new Set(normalizedTags).size !== normalizedTags.length) codes.add("tag-name-duplicate");
  for (const collection of byType("collection")) if (collection.evidenceIds.some((id) => !evidenceIds.has(id))) codes.add("record-reference-missing");
  for (const session of byType("session")) if (session.evidenceIds.some((id) => !evidenceIds.has(id))) codes.add("record-reference-missing");
  for (const finding of byType("finding")) {
    if (finding.tagIds.some((id) => !tagIds.has(id))) codes.add("record-reference-missing");
    for (const reference of finding.evidenceReferences) if (!evidenceIds.has(reference.evidenceId) || (reference.pageId && !byId.has(reference.pageId))) codes.add("record-reference-missing");
  }
  for (const relation of byType("relationship")) if (!byId.has(relation.source.recordId) || !byId.has(relation.target.recordId)) codes.add("record-reference-missing");
  for (const trash of records.filter((record) => record.recordType === "trash")) if (trash.autoDelete === true) codes.add("trash-auto-delete-forbidden");
  const trashedSources = new Set(records.filter((record) => record.recordType === "trash" && record.originalRecord?.kind === "video").map((record) => record.originalRecordId));
  if (fixture.forcedTrashSourceId) trashedSources.add(fixture.forcedTrashSourceId);
  for (const sourceId of trashedSources) if (byType("evidence").some((record) => record.sourceVideoId === sourceId) || byType("page").some((page) => page.placements.some((placement) => placement.evidenceId === sourceId))) codes.add("source-retention-violation");
  if (records.some((record) => ["search-index", "preview-index", "derived-text-cache"].includes(record.recordType))) codes.add("derived-cache-canonicalized");
  return codes;
}

function validateProjectFixture(fixture, schema) {
  const codes = semanticCodes(fixture);
  const documents = [fixture.manifest, ...fixture.records];
  if (documents.some((document) => schemaErrors(schema, document).length)) codes.add("schema-invalid");
  if (fixture.manifest.formatVersion > 2 || fixture.manifest.minimumReaderVersion > 2) codes.add("future-version-rejected");
  return codes;
}

function validateSupportFixture(fixture, schemas) {
  const codes = new Set();
  if (schemaErrors(schemas.settings, fixture.settings).length) codes.add("schema-invalid");
  if (fixture.workspaceDocuments.some((value) => schemaErrors(schemas.workspace, value).length)) codes.add("schema-invalid");
  if (fixture.reports.some((value) => schemaErrors(schemas.migration, value).length)) codes.add("schema-invalid");
  return codes;
}

function applyInvalid(operation, project, support, value) {
  const record = (type, predicate = () => true) => project.records.find((item) => item.recordType === type && predicate(item));
  switch (operation) {
    case "replace-archive-name": project.archiveEntries[0].name = value; break;
    case "add-link-entry": project.archiveEntries.push({ name: "assets/linked.bin", uncompressedBytes: 1, kind: "asset", linkType: value }); break;
    case "duplicate-archive-name-case": project.archiveEntries.push({ ...project.archiveEntries[0], name: project.archiveEntries[0].name.toUpperCase() }); break;
    case "set-json-entry-size": project.archiveEntries.find((entry) => entry.kind === "json").uncompressedBytes = value; break;
    case "set-preview-entry-size": project.archiveEntries.find((entry) => entry.kind === "preview").uncompressedBytes = value; break;
    case "set-entry-count": project.declaredEntryCount = value; break;
    case "duplicate-asset": project.manifest.assets.push(clone(project.manifest.assets[0])); break;
    case "add-image-video-payload": record("evidence", (item) => item.kind === "image").video = clone(record("evidence", (item) => item.kind === "video").video); break;
    case "missing-placement-evidence": record("page").placements[0].evidenceId = "missing-evidence"; break;
    case "reverse-clip-range": { const clip = record("evidence", (item) => item.kind === "clip"); clip.sourceEndUs = clip.sourceStartUs; break; }
    case "duplicate-timeline-identity": record("timeline").entries[1] = clone(record("timeline").entries[0]); break;
    case "duplicate-normalized-tag": { const tag = clone(record("tag")); tag.id = "tag-duplicate"; project.records.push(tag); project.manifest.recordOrder.tags.push(tag.id); break; }
    case "add-placement-runtime-token": record("page").placements[0].assetToken = "not-persistable"; break;
    case "set-project-version": project.manifest.formatVersion = value; break;
    case "add-trash-auto-delete": record("trash").autoDelete = true; break;
    case "trash-source-video": project.forcedTrashSourceId = "evidence-video"; break;
    case "enable-microphone-without-consent": { support.settings.capture.includeMicrophone = true; support.settings.capture.microphoneConsentVersion = null; break; }
    case "repair-invents-replacement": support.reports.find((item) => item.recordType === "repair-report").inventedReplacements = true; break;
    case "migration-mutates-source": support.reports.find((item) => item.recordType === "migration-report").sourceMutated = true; break;
    default: fail(`Unknown invalid fixture operation: ${operation}`);
  }
}

async function loadInputs() {
  const [project, settings, workspace, migration, projectFixture, supportFixture, invalidFixture] = await Promise.all([
    readJson(paths.projectSchema), readJson(paths.settingsSchema), readJson(paths.workspaceSchema), readJson(paths.migrationSchema),
    readJson(paths.projectFixture), readJson(paths.supportFixture), readJson(paths.invalidFixture),
  ]);
  return { schemas: { project, settings, workspace, migration }, projectFixture, supportFixture, invalidFixture };
}

async function verifyReference(reportPath, inputs) {
  const report = await readJson(path.resolve(root, reportPath));
  assert(report.schema === "gamebook.project-format-contract-reference.v1" && report.status === "accepted" && report.governingIssue === 20, "Invalid project-format freeze report identity");
  assert(report.artifactHashNormalization === "utf8-lf", "Artifact hash normalization changed");
  assert(equal(report.acceptedAdrs, ["ADR-0002", "ADR-0008", "ADR-0009"]), "Accepted ADR set changed");
  const expectedSources = [[17, "gamebook.archive-gate-reference.v1"], [18, "gamebook.native-media-contract-reference.v1"], [19, "gamebook.placement-viewport-contract-reference.v1"]];
  for (const [issue, schema] of expectedSources) {
    const source = report.sources.find((item) => item.issue === issue);
    assert(source?.schema === schema, `Missing accepted source report for Issue #${issue}`);
    const retained = await readJson(rel("docs/spikes", source.path));
    assert(retained.schema === schema && ["passed", "accepted"].includes(retained.status), `Retained source report for Issue #${issue} is not accepted`);
  }
  for (const artifact of report.artifacts) assert(await digest(rel(...artifact.path.split("/"))) === artifact.sha256, `Artifact hash mismatch: ${artifact.path}`);
  const v1Manifest = await readJson(rel("src/test/fixtures/manifest.json"));
  const v1 = v1Manifest.fixtures.find((item) => item.path === "projects/version1/basic-screenshot.gamebook.fixture");
  assert(v1?.sha256 === report.version1Fixture.projectSha256 && v1.metadata.screenshotSha256 === report.version1Fixture.screenshotSha256, "Version 1 compatibility fixture changed");
  assert(report.archiveLimits.jsonBytes === 16777216 && report.archiveLimits.previewBytes === 33554432 && report.archiveLimits.entryCount === 250000, "Archive limits changed");
  assert(report.mediaToken.bits === 256 && report.mediaToken.persisted === false, "Media token boundary changed");
  assert(report.derivedCaches.searchCanonical === false && report.derivedCaches.previewsCanonical === false, "Derived caches became canonical");
  assert(report.trash.automaticDeletionAllowed === false && report.trash.expirationMeans === "eligible-for-explicit-cleanup", "Trash retention boundary changed");
  assert(report.compatibility.productionBehaviorChanged === false && report.compatibility.version1ProjectChanged === false, "Issue #20 must not change production behavior");
  assert(validateProjectFixture(inputs.projectFixture, inputs.schemas.project).size === 0, "Valid project fixture failed during reference verification");
  assert(validateSupportFixture(inputs.supportFixture, inputs.schemas).size === 0, "Valid support fixture failed during reference verification");
}

async function main() {
  const inputs = await loadInputs();
  verifySchemaShape(inputs.schemas);
  const projectCodes = validateProjectFixture(inputs.projectFixture, inputs.schemas.project);
  const supportCodes = validateSupportFixture(inputs.supportFixture, inputs.schemas);
  assert(projectCodes.size === 0, `Valid project fixture failed: ${[...projectCodes].join(", ")}`);
  assert(supportCodes.size === 0, `Valid support fixture failed: ${[...supportCodes].join(", ")}`);

  for (const test of inputs.invalidFixture.cases) {
    const project = clone(inputs.projectFixture);
    const support = clone(inputs.supportFixture);
    applyInvalid(test.operation, project, support, test.value);
    const codes = new Set([...validateProjectFixture(project, inputs.schemas.project), ...validateSupportFixture(support, inputs.schemas)]);
    assert(codes.has(test.expectedCode), `${test.name}: expected ${test.expectedCode}, received ${[...codes].join(", ") || "no failure"}`);
  }

  if (process.argv.includes("--self-test")) {
    const weakened = clone(inputs.schemas);
    weakened.project.$defs.evidence.required = weakened.project.$defs.evidence.required.filter((key) => key !== "recordVersion");
    assertThrows(() => verifySchemaShape(weakened), "weakened record version");
    const runtime = clone(inputs.schemas); runtime.project.$defs.placement.additionalProperties = true;
    assertThrows(() => verifySchemaShape(runtime), "persisted placement runtime state");
    const consent = clone(inputs.schemas); delete consent.settings.properties.capture.allOf;
    assertThrows(() => verifySchemaShape(consent), "implicit microphone consent");
    const repair = clone(inputs.schemas); repair.migration.$defs.repairReport.properties.inventedReplacements.const = true;
    assertThrows(() => verifySchemaShape(repair), "invented repair content");
    console.log(`Project-format contract self-test passed (${inputs.invalidFixture.cases.length} invalid fixtures, 4 weakened-contract checks).`);
    return;
  }

  const referenceIndex = process.argv.indexOf("--reference");
  if (referenceIndex >= 0) {
    assert(process.argv[referenceIndex + 1], "--reference requires a path");
    await verifyReference(process.argv[referenceIndex + 1], inputs);
    console.log(`Project-format reference verification passed (${inputs.invalidFixture.cases.length} invalid fixtures).`);
    return;
  }
  console.log(`Project-format schema verification passed (${inputs.invalidFixture.cases.length} invalid fixtures).`);
}

function assertThrows(action, label) {
  let threw = false;
  try { action(); } catch { threw = true; }
  assert(threw, `Self-test did not reject ${label}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
