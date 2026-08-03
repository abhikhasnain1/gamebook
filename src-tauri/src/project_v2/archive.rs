use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use super::model::{
    record_entry_name, AssetRecord, Manifest, SourceSignature, ValidatedArchive, FORMAT_VERSION,
    MAX_ARCHIVE_ENTRIES, MAX_JSON_BYTES, MAX_PREVIEW_BYTES,
};

const COPY_BUFFER_BYTES: usize = 1024 * 1024;
const FILE_ATTRIBUTE_REPARSE_POINT_VALUE: u32 = 0x400;
static PROJECT_SCHEMA_VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> = OnceLock::new();

#[derive(Clone, Debug)]
struct EntryMetadata {
    size: u64,
    compression: CompressionMethod,
}

struct CancellableReader<'a> {
    inner: File,
    cancelled: &'a AtomicBool,
}

impl Read for CancellableReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "operation-cancelled",
            ));
        }
        self.inner.read(buffer)
    }
}

impl Seek for CancellableReader<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "operation-cancelled",
            ));
        }
        self.inner.seek(position)
    }
}

pub fn validate_archive(path: &Path) -> Result<ValidatedArchive, String> {
    validate_archive_with_depth(path, true)
}

pub fn open_archive_lazy(path: &Path) -> Result<ValidatedArchive, String> {
    validate_archive_with_depth(path, false)
}

fn validate_archive_with_depth(path: &Path, complete: bool) -> Result<ValidatedArchive, String> {
    let file = File::open(path).map_err(|error| format!("archive-open-failed: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("malformed-archive: {error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("entry-count-limit: archive contains too many entries".to_string());
    }

    let mut names = HashSet::with_capacity(archive.len());
    let mut entries = HashMap::with_capacity(archive.len());
    let mut total_uncompressed = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("malformed-archive: {error}"))?;
        let name = validate_archive_name(entry.name_raw())?;
        if !names.insert(name.to_ascii_lowercase()) {
            return Err("case-insensitive-duplicate: duplicate archive destination".to_string());
        }
        validate_entry_metadata(path, &entry, &name)?;
        total_uncompressed = total_uncompressed
            .checked_add(entry.size())
            .ok_or_else(|| "project-size-limit: uncompressed size overflow".to_string())?;
        let _ = total_uncompressed;
        entries.insert(
            name,
            EntryMetadata {
                size: entry.size(),
                compression: entry.compression(),
            },
        );
    }

    let manifest_bytes = read_named_limited(&mut archive, "manifest.json", MAX_JSON_BYTES)?;
    let manifest_value: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "malformed-record: manifest JSON is invalid".to_string())?;
    validate_project_document(&manifest_value)?;
    let manifest: Manifest = serde_json::from_value(manifest_value.clone())
        .map_err(|error| format!("manifest-invalid: {error}"))?;
    if manifest.format_version != FORMAT_VERSION
        || manifest.minimum_reader_version != FORMAT_VERSION
    {
        return Err("unsupported-format: project requires an unsupported reader".to_string());
    }

    let manifest_sha256 = sha256_bytes(&manifest_bytes);
    validate_asset_index(&manifest.assets, &entries)?;

    let expected_records = expected_record_entries(&manifest)?;
    let expected_names: HashSet<_> = expected_records
        .iter()
        .map(|(name, _, _)| name.as_str())
        .collect();
    for name in entries.keys() {
        if (name.starts_with("records/") || name.starts_with("timelines/"))
            && name.ends_with(".json")
            && !expected_names.contains(name.as_str())
        {
            return Err(format!("unlisted-record: {name}"));
        }
    }

    let mut records = BTreeMap::new();
    if complete {
        for (entry_name, expected_type, expected_id) in &expected_records {
            let value =
                read_validated_record(&mut archive, entry_name, expected_type, expected_id)?;
            records.insert(entry_name.clone(), value);
        }
        validate_record_graph(&manifest, records.values())?;
    } else {
        load_initial_records(&mut archive, &manifest, &mut records)?;
        validate_initial_record_graph(&manifest, records.values())?;
    }
    Ok(ValidatedArchive {
        manifest,
        manifest_value,
        manifest_sha256: manifest_sha256.clone(),
        records,
        source_signature: source_signature(path, &manifest_sha256)?,
    })
}

pub fn read_record_from_file(file: File, record_type: &str, id: &str) -> Result<Value, String> {
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("malformed-archive: {error}"))?;
    let name = record_entry_name(record_type, id)?;
    read_validated_record(&mut archive, &name, record_type, id)
}

fn read_validated_record<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    entry_name: &str,
    expected_type: &str,
    expected_id: &str,
) -> Result<Value, String> {
    let bytes = read_named_limited(archive, entry_name, MAX_JSON_BYTES)?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| format!("malformed-record: {entry_name} is invalid JSON"))?;
    validate_project_document(&value)?;
    if value.get("recordType").and_then(Value::as_str) != Some(expected_type)
        || value.get("id").and_then(Value::as_str) != Some(expected_id)
    {
        return Err(format!("record-identity-mismatch: {entry_name}"));
    }
    Ok(value)
}

fn load_initial_records<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    manifest: &Manifest,
    records: &mut BTreeMap<String, Value>,
) -> Result<(), String> {
    let Some(page_id) = &manifest.active_page_id else {
        return Ok(());
    };
    if !manifest.record_order.pages.contains(page_id) {
        return Err("record-reference-missing: active page".to_string());
    }
    let page_name = record_entry_name("page", page_id)?;
    let page = read_validated_record(archive, &page_name, "page", page_id)?;
    let mut evidence_ids = BTreeSet::new();
    if let Some(primary) = page.get("primaryEvidenceId").and_then(Value::as_str) {
        evidence_ids.insert(primary.to_string());
    }
    for placement in array(&page, "placements")? {
        evidence_ids.insert(required_string(placement, "evidenceId")?.to_string());
    }
    records.insert(page_name, page);

    for evidence_id in evidence_ids {
        if !manifest.record_order.evidence.contains(&evidence_id) {
            return Err(format!("record-reference-missing: {evidence_id}"));
        }
        let evidence_name = record_entry_name("evidence", &evidence_id)?;
        let evidence = read_validated_record(archive, &evidence_name, "evidence", &evidence_id)?;
        if let Some(timeline_id) = evidence
            .pointer("/video/timelineId")
            .and_then(Value::as_str)
        {
            if !manifest
                .record_order
                .timelines
                .iter()
                .any(|id| id == timeline_id)
            {
                return Err(format!("record-reference-missing: {timeline_id}"));
            }
            let timeline_name = record_entry_name("timeline", timeline_id)?;
            records.insert(
                timeline_name.clone(),
                read_validated_record(archive, &timeline_name, "timeline", timeline_id)?,
            );
        }
        records.insert(evidence_name, evidence);
    }
    Ok(())
}

fn validate_initial_record_graph<'a>(
    manifest: &Manifest,
    records: impl Iterator<Item = &'a Value>,
) -> Result<(), String> {
    let asset_digests: HashSet<_> = manifest
        .assets
        .iter()
        .map(|asset| asset.digest.as_str())
        .collect();
    let page_ids: HashSet<_> = manifest
        .record_order
        .pages
        .iter()
        .map(String::as_str)
        .collect();
    let evidence_ids: HashSet<_> = manifest
        .record_order
        .evidence
        .iter()
        .map(String::as_str)
        .collect();
    for record in records {
        match record.get("recordType").and_then(Value::as_str) {
            Some("page") => {
                if !page_ids.contains(required_string(record, "id")?) {
                    return Err("record-reference-missing".to_string());
                }
                if let Some(primary) = record.get("primaryEvidenceId").and_then(Value::as_str) {
                    require_reference(&evidence_ids, primary)?;
                }
                for placement in array(record, "placements")? {
                    require_reference(&evidence_ids, required_string(placement, "evidenceId")?)?;
                }
            }
            Some("evidence") => {
                if !evidence_ids.contains(required_string(record, "id")?) {
                    return Err("record-reference-missing".to_string());
                }
                if let Some(digest) = record.get("assetDigest").and_then(Value::as_str) {
                    if !asset_digests.contains(digest) {
                        return Err("asset-reference-missing".to_string());
                    }
                }
            }
            Some("timeline") => {}
            _ => return Err("initial-record-type-invalid".to_string()),
        }
    }
    Ok(())
}

pub(crate) fn validate_project_document(value: &Value) -> Result<(), String> {
    let validator = PROJECT_SCHEMA_VALIDATOR
        .get_or_init(|| {
            let schema: Value =
                serde_json::from_str(include_str!("../../../docs/schemas/project-v2.schema.json"))
                    .map_err(|error| format!("schema-invalid: {error}"))?;
            jsonschema::draft202012::new(&schema)
                .map_err(|error| format!("schema-invalid: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)?;
    validator
        .validate(value)
        .map_err(|error| format!("schema-validation-failed: {error}"))
}

fn validate_entry_metadata<R: Read>(
    archive_path: &Path,
    entry: &zip::read::ZipFile<'_, R>,
    name: &str,
) -> Result<(), String> {
    if entry.encrypted() {
        return Err("encrypted-entry: encrypted archives are unsupported".to_string());
    }
    if entry.is_dir() || entry.is_symlink() || !entry.is_file() {
        return Err(
            "link-entry: links, directories, and special entries are unsupported".to_string(),
        );
    }
    let unix_kind = entry.unix_mode().map(|mode| mode & 0o170000).unwrap_or(0);
    if !matches!(unix_kind, 0 | 0o100000) {
        return Err("link-entry: special Unix entries are unsupported".to_string());
    }
    let attributes = read_external_attributes(archive_path, entry.central_header_start())?;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0 {
        return Err("link-entry: reparse entries are unsupported".to_string());
    }
    validate_extra_fields(entry.extra_data())?;

    let limit = entry_limit(name);
    if entry.size() > limit {
        return Err(format!(
            "{}: entry exceeds its declared limit",
            limit_class(name)
        ));
    }
    let expected_compression = if is_json_entry(name) {
        CompressionMethod::Deflated
    } else {
        CompressionMethod::Stored
    };
    if entry.compression() != expected_compression {
        return Err(format!("compression-policy: invalid method for {name}"));
    }
    if !is_allowed_entry_name(name) {
        return Err(format!("entry-layout-invalid: {name}"));
    }
    Ok(())
}

fn validate_asset_index(
    assets: &[AssetRecord],
    entries: &HashMap<String, EntryMetadata>,
) -> Result<(), String> {
    let mut digests = HashSet::new();
    for asset in assets {
        if asset.digest.len() != 64
            || !asset
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || !digests.insert(asset.digest.clone())
        {
            return Err(
                "asset-digest-invalid: asset digests must be unique lowercase SHA-256".to_string(),
            );
        }
        if asset.storage_method != "stored" {
            return Err("asset-storage-invalid: immutable assets must be stored".to_string());
        }
        let name = asset.entry_name();
        let entry = entries
            .get(&name)
            .ok_or_else(|| format!("asset-entry-missing: {name}"))?;
        if entry.size != asset.byte_length || entry.compression != CompressionMethod::Stored {
            return Err(format!("asset-metadata-mismatch: {name}"));
        }
    }
    Ok(())
}

fn expected_record_entries(
    manifest: &Manifest,
) -> Result<Vec<(String, &'static str, String)>, String> {
    let mut result = Vec::new();
    let mut identities = HashSet::new();
    for (_, record_type, ids) in manifest.record_order.lists() {
        for id in ids {
            if !identities.insert((record_type, id.as_str())) {
                return Err(format!("record-order-duplicate: {record_type}/{id}"));
            }
            result.push((record_entry_name(record_type, id)?, record_type, id.clone()));
        }
    }
    Ok(result)
}

fn validate_record_graph<'a>(
    manifest: &Manifest,
    records: impl Iterator<Item = &'a Value>,
) -> Result<(), String> {
    let records: Vec<&Value> = records.collect();
    let mut by_id = HashMap::new();
    let mut by_type: HashMap<&str, Vec<&Value>> = HashMap::new();
    for record in &records {
        let id = required_string(record, "id")?;
        let record_type = required_string(record, "recordType")?;
        if by_id.insert(id, *record).is_some() {
            return Err(format!("record-id-duplicate: {id}"));
        }
        by_type.entry(record_type).or_default().push(record);
    }

    if let Some(active_page) = &manifest.active_page_id {
        let Some(record) = by_id.get(active_page.as_str()) else {
            return Err("record-reference-missing: active page".to_string());
        };
        if record.get("recordType").and_then(Value::as_str) != Some("page") {
            return Err("record-reference-invalid: active page".to_string());
        }
    }

    let asset_digests: HashSet<_> = manifest
        .assets
        .iter()
        .map(|asset| asset.digest.as_str())
        .collect();
    let evidence_ids = typed_ids(&by_type, "evidence")?;
    let timeline_ids = typed_ids(&by_type, "timeline")?;
    let session_ids = typed_ids(&by_type, "session")?;
    let tag_ids = typed_ids(&by_type, "tag")?;

    for evidence in by_type.get("evidence").into_iter().flatten() {
        if let Some(digest) = evidence.get("assetDigest").and_then(Value::as_str) {
            if !asset_digests.contains(digest) {
                return Err("asset-reference-missing".to_string());
            }
        }
        if let Some(session_id) = evidence.get("sessionId").and_then(Value::as_str) {
            require_reference(&session_ids, session_id)?;
        }
        require_array_references(evidence.get("tagIds"), &tag_ids)?;
        if matches!(
            evidence.get("kind").and_then(Value::as_str),
            Some("clip" | "frame")
        ) {
            let source_id = required_string(evidence, "sourceVideoId")?;
            require_reference(&evidence_ids, source_id)?;
            if by_id[source_id].get("kind").and_then(Value::as_str) != Some("video") {
                return Err("source-video-reference-invalid".to_string());
            }
        }
        if evidence.get("kind").and_then(Value::as_str) == Some("video") {
            require_reference(
                &timeline_ids,
                evidence
                    .pointer("/video/timelineId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "timeline-reference-invalid".to_string())?,
            )?;
        }
        if evidence.get("kind").and_then(Value::as_str) == Some("clip") {
            let start = required_u64(evidence, "sourceStartUs")?;
            let end = required_u64(evidence, "sourceEndUs")?;
            if start >= end {
                return Err("clip-range-invalid".to_string());
            }
        }
    }

    for timeline in by_type.get("timeline").into_iter().flatten() {
        let evidence_id = required_string(timeline, "evidenceId")?;
        require_reference(&evidence_ids, evidence_id)?;
        let evidence = by_id[evidence_id];
        if evidence.get("kind").and_then(Value::as_str) != Some("video")
            || evidence
                .pointer("/video/timelineId")
                .and_then(Value::as_str)
                != timeline.get("id").and_then(Value::as_str)
        {
            return Err("timeline-reference-invalid".to_string());
        }
        let entries = timeline
            .get("entries")
            .and_then(Value::as_array)
            .ok_or_else(|| "timeline-entries-invalid".to_string())?;
        let mut prior_index = None;
        let mut prior_pts = None;
        for entry in entries {
            let sample = required_u64(entry, "sampleIndex")?;
            let pts = required_u64(entry, "sourceTimestamp100ns")?;
            let micros = required_u64(entry, "timestampUs")?;
            if prior_index.is_some_and(|value| sample <= value)
                || prior_pts.is_some_and(|value| pts <= value)
                || micros != pts / 10
            {
                return Err("timeline-identity-invalid".to_string());
            }
            prior_index = Some(sample);
            prior_pts = Some(pts);
        }
    }

    for page in by_type.get("page").into_iter().flatten() {
        if let Some(primary) = page.get("primaryEvidenceId").and_then(Value::as_str) {
            require_reference(&evidence_ids, primary)?;
        }
        let mut object_ids = HashSet::new();
        for placement in array(page, "placements")? {
            require_reference(&evidence_ids, required_string(placement, "evidenceId")?)?;
            if !object_ids.insert(required_string(placement, "id")?) {
                return Err("page-object-id-duplicate".to_string());
            }
        }
        let mut annotation_ids = HashSet::new();
        for annotation in array(page, "annotations")? {
            let annotation_id = required_string(annotation, "id")?;
            if !object_ids.insert(annotation_id) || !annotation_ids.insert(annotation_id) {
                return Err("page-object-id-duplicate".to_string());
            }
            if annotation.pointer("/scope/kind").and_then(Value::as_str) == Some("time") {
                let scope = annotation.get("scope").unwrap_or(&Value::Null);
                require_reference(&evidence_ids, required_string(scope, "evidenceId")?)?;
                if required_u64(scope, "startUs")? > required_u64(scope, "endUs")? {
                    return Err("annotation-range-invalid".to_string());
                }
            }
        }
        let annotation_order = array(page, "annotationOrder")?;
        if annotation_order.len() != annotation_ids.len()
            || annotation_order.iter().any(|id| {
                id.as_str()
                    .is_none_or(|value| !annotation_ids.contains(value))
            })
        {
            return Err("annotation-order-invalid".to_string());
        }
        let mut connector_ids = HashSet::new();
        for connector in array(page, "connectors")? {
            if !connector_ids.insert(required_string(connector, "id")?) {
                return Err("connector-id-duplicate".to_string());
            }
            for pointer in ["/start/objectId", "/end/objectId"] {
                let id = connector
                    .pointer(pointer)
                    .and_then(Value::as_str)
                    .ok_or_else(|| "connector-reference-invalid".to_string())?;
                if !object_ids.contains(id) {
                    return Err("connector-reference-missing".to_string());
                }
            }
        }
    }

    let mut normalized_tags = HashSet::new();
    for tag in by_type.get("tag").into_iter().flatten() {
        let normalized = required_string(tag, "normalizedName")?
            .trim()
            .to_lowercase();
        if !normalized_tags.insert(normalized) {
            return Err("tag-name-duplicate".to_string());
        }
    }
    for collection in by_type.get("collection").into_iter().flatten() {
        require_array_references(collection.get("evidenceIds"), &evidence_ids)?;
    }
    for session in by_type.get("session").into_iter().flatten() {
        require_array_references(session.get("evidenceIds"), &evidence_ids)?;
    }
    for finding in by_type.get("finding").into_iter().flatten() {
        require_array_references(finding.get("tagIds"), &tag_ids)?;
        for reference in array(finding, "evidenceReferences")? {
            require_reference(&evidence_ids, required_string(reference, "evidenceId")?)?;
            if let Some(page_id) = reference.get("pageId").and_then(Value::as_str) {
                let Some(page) = by_id.get(page_id) else {
                    return Err("record-reference-missing".to_string());
                };
                if page.get("recordType").and_then(Value::as_str) != Some("page") {
                    return Err("finding-page-reference-invalid".to_string());
                }
                if let Some(annotation_id) = reference.get("annotationId").and_then(Value::as_str) {
                    let found = page
                        .get("annotations")
                        .and_then(Value::as_array)
                        .is_some_and(|annotations| {
                            annotations.iter().any(|annotation| {
                                annotation.get("id").and_then(Value::as_str) == Some(annotation_id)
                            })
                        });
                    if !found {
                        return Err("finding-annotation-reference-invalid".to_string());
                    }
                }
            } else if reference
                .get("annotationId")
                .and_then(Value::as_str)
                .is_some()
            {
                return Err("finding-annotation-reference-invalid".to_string());
            }
        }
    }
    for relationship in by_type.get("relationship").into_iter().flatten() {
        for pointer in ["/source", "/target"] {
            let reference = relationship
                .pointer(pointer)
                .ok_or_else(|| "relationship-reference-invalid".to_string())?;
            let id = required_string(reference, "recordId")?;
            let expected_type = required_string(reference, "recordType")?;
            let Some(record) = by_id.get(id) else {
                return Err("record-reference-missing".to_string());
            };
            if record.get("recordType").and_then(Value::as_str) != Some(expected_type) {
                return Err("relationship-reference-invalid".to_string());
            }
        }
    }

    let order_lists: HashMap<_, _> = manifest
        .record_order
        .lists()
        .into_iter()
        .map(|(list, record_type, _)| (record_type, list))
        .collect();
    for trash in by_type.get("trash").into_iter().flatten() {
        let original = trash
            .get("originalRecord")
            .ok_or_else(|| "trash-record-invalid".to_string())?;
        let original_id = required_string(trash, "originalRecordId")?;
        let original_type = required_string(trash, "originalRecordType")?;
        if required_string(original, "id")? != original_id
            || required_string(original, "recordType")? != original_type
            || trash.pointer("/originalOrder/list").and_then(Value::as_str)
                != order_lists.get(original_type).copied()
            || by_id.contains_key(original_id)
        {
            return Err("trash-record-invalid".to_string());
        }
    }

    let trashed_sources: HashSet<_> = by_type
        .get("trash")
        .into_iter()
        .flatten()
        .filter(|record| {
            record
                .pointer("/originalRecord/kind")
                .and_then(Value::as_str)
                == Some("video")
        })
        .filter_map(|record| record.get("originalRecordId").and_then(Value::as_str))
        .collect();
    for source_id in trashed_sources {
        let has_evidence_dependents =
            by_type.get("evidence").into_iter().flatten().any(|record| {
                record.get("sourceVideoId").and_then(Value::as_str) == Some(source_id)
            });
        let has_placement_dependents = by_type.get("page").into_iter().flatten().any(|page| {
            page.get("placements")
                .and_then(Value::as_array)
                .is_some_and(|placements| {
                    placements.iter().any(|placement| {
                        placement.get("evidenceId").and_then(Value::as_str) == Some(source_id)
                    })
                })
        });
        let has_timed_annotation_dependents =
            by_type.get("page").into_iter().flatten().any(|page| {
                page.get("annotations")
                    .and_then(Value::as_array)
                    .is_some_and(|annotations| {
                        annotations.iter().any(|annotation| {
                            annotation
                                .pointer("/scope/evidenceId")
                                .and_then(Value::as_str)
                                == Some(source_id)
                        })
                    })
            });
        if has_evidence_dependents || has_placement_dependents || has_timed_annotation_dependents {
            return Err("source-retention-violation".to_string());
        }
    }
    Ok(())
}

fn typed_ids<'a>(
    by_type: &HashMap<&str, Vec<&'a Value>>,
    record_type: &str,
) -> Result<HashSet<&'a str>, String> {
    by_type
        .get(record_type)
        .into_iter()
        .flatten()
        .map(|record| required_string(record, "id"))
        .collect()
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("record-field-invalid: {field}"))
}

fn required_u64(value: &Value, field: &str) -> Result<u64, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("record-field-invalid: {field}"))
}

fn array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
    value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("record-field-invalid: {field}"))
}

fn require_array_references(value: Option<&Value>, valid: &HashSet<&str>) -> Result<(), String> {
    for id in value
        .and_then(Value::as_array)
        .ok_or_else(|| "record-reference-list-invalid".to_string())?
    {
        require_reference(
            valid,
            id.as_str()
                .ok_or_else(|| "record-reference-invalid".to_string())?,
        )?;
    }
    Ok(())
}

fn require_reference(valid: &HashSet<&str>, id: &str) -> Result<(), String> {
    if valid.contains(id) {
        Ok(())
    } else {
        Err(format!("record-reference-missing: {id}"))
    }
}

pub fn materialize_asset(
    archive_file: File,
    cache_dir: &Path,
    asset: &AssetRecord,
    cancelled: &AtomicBool,
) -> Result<PathBuf, String> {
    fs::create_dir_all(cache_dir).map_err(|error| format!("workspace-create-failed: {error}"))?;
    let final_path = cache_dir.join(format!("{}.{}", asset.digest, asset.extension));
    if final_path.exists() {
        if fs::metadata(&final_path)
            .map(|value| value.len())
            .unwrap_or(0)
            == asset.byte_length
            && sha256_file(&final_path)? == asset.digest
        {
            return Ok(final_path);
        }
        return Err(
            "materialized-asset-invalid: existing cache entry failed verification".to_string(),
        );
    }

    let partial = cache_dir.join(format!("{}.partial", asset.digest));
    remove_file_if_exists(&partial)?;
    let mut archive =
        ZipArchive::new(archive_file).map_err(|error| format!("malformed-archive: {error}"))?;
    let mut entry = archive
        .by_name(&asset.entry_name())
        .map_err(|_| "asset-entry-missing".to_string())?;
    if entry.size() != asset.byte_length || entry.compression() != CompressionMethod::Stored {
        return Err("asset-metadata-mismatch".to_string());
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|error| format!("temporary-create-failed: {error}"))?;
    let mut hasher = Sha256::new();
    let mut written = 0_u64;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let result = (|| -> Result<(), String> {
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("operation-cancelled".to_string());
            }
            let count = entry
                .read(&mut buffer)
                .map_err(|error| format!("archive-checksum-failed: {error}"))?;
            if count == 0 {
                break;
            }
            written = written
                .checked_add(count as u64)
                .ok_or_else(|| "actual-size-limit".to_string())?;
            if written > asset.byte_length {
                return Err("actual-size-limit".to_string());
            }
            output
                .write_all(&buffer[..count])
                .map_err(|error| format!("materialization-write-failed: {error}"))?;
            hasher.update(&buffer[..count]);
        }
        output
            .sync_all()
            .map_err(|error| format!("temporary-flush-failed: {error}"))?;
        if written != asset.byte_length || sha256_digest(&hasher.finalize()) != asset.digest {
            return Err("asset-digest-mismatch".to_string());
        }
        Ok(())
    })();
    drop(output);
    if let Err(error) = result {
        let _ = remove_file_if_exists(&partial);
        return Err(error);
    }
    if let Err(error) = fs::rename(&partial, &final_path) {
        let _ = remove_file_if_exists(&partial);
        return Err(format!("atomic-visibility-failed: {error}"));
    }
    Ok(final_path)
}

pub fn write_replacement_archive(
    source_file: Option<File>,
    working_dir: &Path,
    temporary: &Path,
    cancelled: &AtomicBool,
) -> Result<ValidatedArchive, String> {
    check_cancelled(cancelled)?;
    if temporary.exists() {
        return Err("replacement-temporary-exists".to_string());
    }
    let manifest_path = working_dir.join("manifest.json");
    let manifest_bytes =
        fs::read(&manifest_path).map_err(|error| format!("workspace-manifest-missing: {error}"))?;
    if manifest_bytes.len() as u64 > MAX_JSON_BYTES {
        return Err("record-size-limit: manifest exceeds limit".to_string());
    }
    let manifest_value: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "malformed-record: workspace manifest is invalid".to_string())?;
    validate_project_document(&manifest_value)?;
    let manifest: Manifest = serde_json::from_value(manifest_value)
        .map_err(|error| format!("manifest-invalid: {error}"))?;
    let expected_records = expected_record_entries(&manifest)?;

    let mut source_archive = source_file
        .map(|inner| CancellableReader { inner, cancelled })
        .map(ZipArchive::new)
        .transpose()
        .map_err(|error| {
            if cancelled.load(Ordering::Relaxed) {
                "operation-cancelled".to_string()
            } else {
                format!("malformed-archive: {error}")
            }
        })?;

    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .map_err(|error| format!("replacement-create-failed: {error}"))?;
    let result = (|| -> Result<(), String> {
        let mut writer = ZipWriter::new(output);
        write_entry(
            &mut writer,
            "manifest.json",
            &manifest_bytes,
            CompressionMethod::Deflated,
        )?;

        for (name, _, _) in &expected_records {
            check_cancelled(cancelled)?;
            let workspace_path = working_dir.join(posix_to_path(name));
            if workspace_path.is_file() {
                let bytes = read_file_limited(&workspace_path, MAX_JSON_BYTES)?;
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| format!("malformed-record: {name}"))?;
                validate_project_document(&value)?;
                write_entry(&mut writer, name, &bytes, CompressionMethod::Deflated)?;
            } else {
                raw_copy_required(&mut writer, source_archive.as_mut(), name, cancelled)?;
            }
        }

        for asset in &manifest.assets {
            check_cancelled(cancelled)?;
            let name = asset.entry_name();
            let workspace_path = working_dir.join(posix_to_path(&name));
            if workspace_path.is_file() {
                if fs::metadata(&workspace_path)
                    .map_err(|error| format!("asset-read-failed: {error}"))?
                    .len()
                    != asset.byte_length
                    || sha256_file(&workspace_path)? != asset.digest
                {
                    return Err(format!("asset-digest-mismatch: {name}"));
                }
                write_file_entry(&mut writer, &name, &workspace_path, cancelled)?;
            } else {
                raw_copy_required(&mut writer, source_archive.as_mut(), &name, cancelled)?;
            }
        }

        if let Some(archive) = source_archive.as_mut() {
            let expected_previews: BTreeSet<_> = manifest
                .derived_previews
                .iter()
                .map(|preview| format!("previews/{}/{}.jpg", preview.evidence_id, preview.kind))
                .collect();
            for name in expected_previews {
                if archive.index_for_name(&name).is_some() {
                    raw_copy_required(&mut writer, Some(archive), &name, cancelled)?;
                }
            }
        }
        let file = writer
            .finish()
            .map_err(|error| format!("archive-finish-failed: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("replacement-flush-failed: {error}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = remove_file_if_exists(temporary);
        return Err(error);
    }
    match validate_archive(temporary) {
        Ok(archive) => Ok(archive),
        Err(error) => {
            let _ = remove_file_if_exists(temporary);
            Err(error)
        }
    }
}

fn write_entry(
    writer: &mut ZipWriter<File>,
    name: &str,
    bytes: &[u8],
    compression: CompressionMethod,
) -> Result<(), String> {
    writer
        .start_file(
            name,
            SimpleFileOptions::default().compression_method(compression),
        )
        .map_err(|error| format!("archive-entry-start-failed: {error}"))?;
    writer
        .write_all(bytes)
        .map_err(|error| format!("archive-entry-write-failed: {error}"))
}

fn write_file_entry(
    writer: &mut ZipWriter<File>,
    name: &str,
    path: &Path,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    writer
        .start_file(
            name,
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
        )
        .map_err(|error| format!("archive-entry-start-failed: {error}"))?;
    let mut input = File::open(path).map_err(|error| format!("asset-read-failed: {error}"))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        check_cancelled(cancelled)?;
        let count = input
            .read(&mut buffer)
            .map_err(|error| format!("asset-read-failed: {error}"))?;
        if count == 0 {
            break;
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|error| format!("archive-entry-write-failed: {error}"))?;
    }
    Ok(())
}

fn raw_copy_required<R: Read + Seek>(
    writer: &mut ZipWriter<File>,
    archive: Option<&mut ZipArchive<R>>,
    name: &str,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    check_cancelled(cancelled)?;
    let archive = archive.ok_or_else(|| format!("archive-entry-missing: {name}"))?;
    let entry = archive.by_name(name).map_err(|error| {
        if cancelled.load(Ordering::Relaxed) {
            "operation-cancelled".to_string()
        } else {
            format!("archive-entry-missing: {name}: {error}")
        }
    })?;
    writer.raw_copy_file(entry).map_err(|error| {
        if cancelled.load(Ordering::Relaxed) {
            "operation-cancelled".to_string()
        } else {
            format!("archive-raw-copy-failed: {error}")
        }
    })
}

pub fn replace_visible_archive(temporary: &Path, destination: &Path) -> Result<bool, String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "destination-parent-missing".to_string())?;
    let temporary_parent = temporary
        .parent()
        .ok_or_else(|| "replacement-parent-missing".to_string())?;
    if fs::canonicalize(parent).map_err(|error| error.to_string())?
        != fs::canonicalize(temporary_parent).map_err(|error| error.to_string())?
    {
        return Err("replacement-temporary-not-sibling".to_string());
    }
    let replaced_existing = destination.exists();
    replace_file_platform(temporary, destination, replaced_existing)?;
    Ok(replaced_existing)
}

#[cfg(windows)]
fn replace_file_platform(
    temporary: &Path,
    destination: &Path,
    replaced_existing: bool,
) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
        },
    };

    let temporary = windows_extended_path(temporary)?;
    let destination = windows_extended_path(destination)?;
    unsafe {
        if replaced_existing {
            ReplaceFileW(
                PCWSTR(destination.as_ptr()),
                PCWSTR(temporary.as_ptr()),
                PCWSTR::null(),
                REPLACEFILE_WRITE_THROUGH,
                None,
                None,
            )
            .map_err(|error| format!("replacement-failed: {error}"))?;
        } else {
            MoveFileExW(
                PCWSTR(temporary.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|error| format!("replacement-failed: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(windows)]
pub(crate) fn windows_extended_path(path: &Path) -> Result<Vec<u16>, String> {
    use std::{
        ffi::OsString,
        os::windows::ffi::OsStrExt,
        path::{Component, Prefix},
    };

    let mut components = path.components();
    let encoded = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Verbatim(_)
            | Prefix::VerbatimUNC(_, _)
            | Prefix::VerbatimDisk(_)
            | Prefix::DeviceNS(_) => path.as_os_str().to_os_string(),
            Prefix::UNC(server, share) => {
                let mut value = OsString::from(r"\\?\UNC\");
                value.push(server);
                value.push(r"\");
                value.push(share);
                for component in components {
                    if component != Component::RootDir {
                        value.push(r"\");
                        value.push(component.as_os_str());
                    }
                }
                value
            }
            Prefix::Disk(_) => {
                let mut value = OsString::from(r"\\?\");
                value.push(path.as_os_str());
                value
            }
        },
        _ => return Err("windows-path-must-be-absolute".to_string()),
    };
    Ok(encoded.encode_wide().chain(std::iter::once(0)).collect())
}

#[cfg(not(windows))]
fn replace_file_platform(
    temporary: &Path,
    destination: &Path,
    replaced_existing: bool,
) -> Result<(), String> {
    if replaced_existing {
        fs::remove_file(destination).map_err(|error| format!("replacement-failed: {error}"))?;
    }
    fs::rename(temporary, destination).map_err(|error| format!("replacement-failed: {error}"))
}

pub fn flush_directory(path: &Path) -> bool {
    File::open(path).and_then(|file| file.sync_all()).is_ok()
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("file-read-failed: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("file-read-failed: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(sha256_digest(&hasher.finalize()))
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    sha256_digest(&Sha256::digest(bytes))
}

pub fn source_signature(path: &Path, manifest_sha256: &str) -> Result<SourceSignature, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("source-metadata-failed: {error}"))?;
    #[cfg(windows)]
    let modified_100ns = {
        use std::os::windows::fs::MetadataExt;
        metadata.last_write_time()
    };
    #[cfg(not(windows))]
    let modified_100ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_nanos() as u64 / 100)
        .unwrap_or_default();
    Ok(SourceSignature {
        byte_length: metadata.len(),
        modified_100ns,
        manifest_sha256: manifest_sha256.to_string(),
    })
}

pub fn source_path_fingerprint(path: &Path) -> Result<String, String> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("source-canonicalization-failed: {error}"))?;
    Ok(sha256_bytes(
        canonical.to_string_lossy().to_lowercase().as_bytes(),
    ))
}

fn read_named_limited<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("archive-entry-missing: {name}"))?;
    if entry.size() > limit {
        return Err(format!("{}: {name}", limit_class(name)));
    }
    let mut bytes = Vec::with_capacity(entry.size().min(limit) as usize);
    let mut limited = (&mut entry).take(limit + 1);
    limited
        .read_to_end(&mut bytes)
        .map_err(|error| format!("archive-entry-read-failed: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err("actual-size-limit: decompressed record exceeds limit".to_string());
    }
    Ok(bytes)
}

fn read_file_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file =
        File::open(path).map_err(|error| format!("workspace-record-read-failed: {error}"))?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("workspace-record-read-failed: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err("record-size-limit".to_string());
    }
    Ok(bytes)
}

fn validate_archive_name(raw: &[u8]) -> Result<String, String> {
    let name = std::str::from_utf8(raw)
        .map_err(|_| "unsafe-entry-name: entry name is not UTF-8".to_string())?;
    if name.is_empty() || name.contains('\0') || name.contains('\\') || name.starts_with('/') {
        return Err("unsafe-entry-name: entry must be a relative POSIX path".to_string());
    }
    if name
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains(':'))
    {
        return Err("unsafe-entry-name: forbidden path component".to_string());
    }
    Ok(name.to_string())
}

fn is_allowed_entry_name(name: &str) -> bool {
    if name == "manifest.json" {
        return true;
    }
    if name.starts_with("records/") && name.ends_with(".json") {
        return name.split('/').count() == 3;
    }
    if name.starts_with("timelines/") && name.ends_with(".json") {
        return name.split('/').count() == 2;
    }
    if name.starts_with("assets/") {
        let parts: Vec<_> = name.split('/').collect();
        return parts.len() == 3 && parts[1].len() == 2;
    }
    if name.starts_with("previews/") && name.ends_with(".jpg") {
        return name.split('/').count() == 3;
    }
    false
}

fn is_json_entry(name: &str) -> bool {
    name == "manifest.json"
        || ((name.starts_with("records/") || name.starts_with("timelines/"))
            && name.ends_with(".json"))
}

fn entry_limit(name: &str) -> u64 {
    if is_json_entry(name) {
        MAX_JSON_BYTES
    } else if name.starts_with("previews/") {
        MAX_PREVIEW_BYTES
    } else {
        u64::MAX
    }
}

fn limit_class(name: &str) -> &'static str {
    if is_json_entry(name) {
        "record-size-limit"
    } else if name.starts_with("previews/") {
        "preview-size-limit"
    } else {
        "asset-size-limit"
    }
}

fn validate_extra_fields(extra: Option<&[u8]>) -> Result<(), String> {
    let Some(mut remaining) = extra else {
        return Ok(());
    };
    while !remaining.is_empty() {
        if remaining.len() < 4 {
            return Err("malformed-archive: truncated extra field".to_string());
        }
        let id = u16::from_le_bytes([remaining[0], remaining[1]]);
        let length = u16::from_le_bytes([remaining[2], remaining[3]]) as usize;
        if remaining.len() < 4 + length {
            return Err("malformed-archive: invalid extra field length".to_string());
        }
        if !matches!(id, 0x0001 | 0x000a | 0x5455 | 0x7075) {
            return Err("link-entry: unsupported entry metadata".to_string());
        }
        remaining = &remaining[4 + length..];
    }
    Ok(())
}

fn read_external_attributes(path: &Path, central_header_start: u64) -> Result<u32, String> {
    let mut file = File::open(path).map_err(|error| format!("archive-open-failed: {error}"))?;
    file.seek(SeekFrom::Start(central_header_start + 38))
        .map_err(|error| format!("archive-metadata-read-failed: {error}"))?;
    let mut bytes = [0_u8; 4];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("archive-metadata-read-failed: {error}"))?;
    Ok(u32::from_le_bytes(bytes))
}

fn posix_to_path(name: &str) -> PathBuf {
    name.split('/').collect()
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        Err("operation-cancelled".to_string())
    } else {
        Ok(())
    }
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("temporary-cleanup-failed: {error}")),
    }
}

fn sha256_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use serde_json::{json, Value};

    use super::{
        sha256_bytes, validate_archive, validate_archive_name, validate_record_graph, Manifest,
    };

    #[test]
    fn rejects_unsafe_archive_names() {
        for name in [
            b"../escape.json".as_slice(),
            b"/absolute.json",
            b"C:/drive.json",
            b"records\\page.json",
            b"records//page.json",
            b"records/./page.json",
            b"records/page.json:stream",
            b"records/page\0.json",
        ] {
            assert!(validate_archive_name(name).is_err(), "accepted {name:?}");
        }
        assert_eq!(
            validate_archive_name(b"records/pages/page-alpha.json").unwrap(),
            "records/pages/page-alpha.json"
        );
    }

    #[test]
    fn hashes_exact_bytes() {
        assert_eq!(
            sha256_bytes(b"Gamebook"),
            "5294dd3fa6bf640085265fb65047942ef50b76985cc90bc9554077921317519c"
        );
    }

    #[test]
    fn rejects_committed_malformed_archive_fixtures_without_mutation() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/test/fixtures/archives");
        for name in [
            "absolute-path-entry.zip.fixture",
            "case-duplicate-entries.zip.fixture",
            "declared-oversize-json.zip.fixture",
            "nul-name-entry.zip.fixture",
            "parent-traversal-entry.zip.fixture",
        ] {
            let path = root.join(name);
            let before = fs::read(&path).unwrap();
            assert!(validate_archive(&path).is_err(), "accepted {name}");
            assert_eq!(fs::read(&path).unwrap(), before, "mutated {name}");
        }
    }

    #[test]
    fn rejects_invalid_annotation_order_and_non_video_clip_sources() {
        let digest = "a".repeat(64);
        let manifest: Manifest = serde_json::from_value(json!({
            "formatVersion": 2,
            "minimumReaderVersion": 2,
            "projectId": "project-graph-test",
            "title": "Graph test",
            "createdAt": "2026-08-03T00:00:00.000Z",
            "updatedAt": "2026-08-03T00:00:00.000Z",
            "activePageId": "page-graph-test",
            "recordOrder": {
                "pages": ["page-graph-test"],
                "evidence": ["evidence-image"],
                "timelines": [],
                "findings": [],
                "tags": [],
                "collections": [],
                "relationships": [],
                "sessions": [],
                "trash": []
            },
            "assets": [{
                "digest": digest,
                "byteLength": 1,
                "mediaClass": "image",
                "mimeType": "image/png",
                "extension": "png",
                "storageMethod": "stored"
            }]
        }))
        .unwrap();
        let evidence = json!({
            "recordType": "evidence",
            "id": "evidence-image",
            "kind": "screenshot",
            "tagIds": [],
            "assetDigest": digest
        });
        let page = json!({
            "recordType": "page",
            "id": "page-graph-test",
            "primaryEvidenceId": "evidence-image",
            "placements": [],
            "annotations": [{
                "id": "annotation-alpha",
                "scope": { "kind": "page" }
            }],
            "annotationOrder": ["annotation-alpha"],
            "connectors": []
        });
        let valid = [evidence.clone(), page.clone()];
        validate_record_graph(&manifest, valid.iter()).unwrap();

        let mut bad_order = page.clone();
        bad_order["annotationOrder"] = Value::Array(Vec::new());
        assert_eq!(
            validate_record_graph(&manifest, [evidence.clone(), bad_order].iter()).unwrap_err(),
            "annotation-order-invalid"
        );

        let mut clip_manifest = manifest.clone();
        clip_manifest
            .record_order
            .evidence
            .push("evidence-clip".to_string());
        let clip = json!({
            "recordType": "evidence",
            "id": "evidence-clip",
            "kind": "clip",
            "tagIds": [],
            "sourceVideoId": "evidence-image",
            "sourceStartUs": 0,
            "sourceEndUs": 1
        });
        assert_eq!(
            validate_record_graph(&clip_manifest, [evidence, page, clip].iter()).unwrap_err(),
            "source-video-reference-invalid"
        );
    }
}
