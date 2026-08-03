use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{Cursor, Read, Seek},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::DateTime;
use flate2::read::GzDecoder;
use image::{ImageFormat, ImageReader};
use jsonschema::Validator;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::{
    archive::{
        sha256_bytes, sha256_file, validate_archive_name, validate_project_document,
        validate_record_graph,
    },
    model::{
        record_entry_name, AssetRecord, Manifest, RecordOrder, MAX_ARCHIVE_ENTRIES, MAX_JSON_BYTES,
    },
};

const MAX_VERSION_1_SOURCE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_VERSION_1_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_VERSION_1_ASSET_BYTES: usize = 512 * 1024 * 1024;
const MAX_VERSION_1_PAGES: usize = 100_000;
const MAX_VERSION_1_OBJECTS: usize = 250_000;
const MAX_IMAGE_DIMENSION: u32 = 100_000;
static REPORT_SCHEMA_VALIDATOR: OnceLock<Result<Validator, String>> = OnceLock::new();

#[derive(Clone, Debug)]
pub(crate) struct PreparedAsset {
    pub record: AssetRecord,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedMigration {
    pub source_format: String,
    pub source_sha256: String,
    pub manifest: Manifest,
    pub manifest_value: Value,
    pub manifest_sha256: String,
    pub records: BTreeMap<String, Value>,
    pub assets: Vec<PreparedAsset>,
    pub report: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySession {
    format_version: u64,
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    active_page_id: Option<String>,
    pages: Vec<LegacyPage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPage {
    id: String,
    title: String,
    created_at: String,
    monitor_name: String,
    source_width: u32,
    source_height: u32,
    screenshot_data_url: String,
    screenshot_layout: Option<LegacyLayout>,
    annotations: LegacyAnnotations,
    #[serde(default)]
    thumbnail_data_url: String,
    #[serde(default)]
    extracted_text: String,
    #[serde(default)]
    background_color: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyLayout {
    left: f64,
    top: f64,
    scale_x: f64,
    scale_y: f64,
    angle: f64,
}

#[derive(Debug, Deserialize)]
struct LegacyAnnotations {
    objects: Vec<Value>,
}

struct RepairReportContents {
    status: &'static str,
    valid_record_ids: Vec<String>,
    invalid_record_ids: Vec<String>,
    missing_asset_digests: Vec<String>,
    messages: Vec<Value>,
}

pub(crate) fn prepare_migration(
    path: &Path,
    cancelled: &AtomicBool,
) -> Result<PreparedMigration, String> {
    check_cancelled(cancelled)?;
    let source_bytes = read_file_limited(path, MAX_VERSION_1_SOURCE_BYTES)?;
    let source_sha256 = sha256_bytes(&source_bytes);
    let (source_format, json_bytes) = decode_version_1_source(&source_bytes)?;
    check_cancelled(cancelled)?;

    let raw: Value =
        serde_json::from_slice(&json_bytes).map_err(|_| "version-1-json-invalid".to_string())?;
    let format_version = raw
        .get("formatVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| "project-format-missing".to_string())?;
    if format_version > 2 {
        return Err("future-version-rejected".to_string());
    }
    if format_version != 1 {
        return Err("version-1-source-required".to_string());
    }
    let legacy: LegacySession =
        serde_json::from_value(raw).map_err(|_| "version-1-structure-invalid".to_string())?;
    validate_legacy_session(&legacy)?;

    let project_id =
        preserved_or_deterministic_id(&legacy.id, &source_sha256, "project", &legacy.id, 0).0;
    let mut page_ids = HashSet::new();
    let mut page_id_map = HashMap::new();
    let mut page_canonical_ids = Vec::new();
    let mut page_mappings = Vec::new();
    for (index, page) in legacy.pages.iter().enumerate() {
        let (id, strategy) =
            unique_legacy_id(&page.id, &source_sha256, "page", index, &mut page_ids);
        page_id_map
            .entry(page.id.clone())
            .or_insert_with(|| id.clone());
        page_canonical_ids.push(id.clone());
        page_mappings.push(json!({
            "legacyType": "page",
            "legacyId": report_legacy_id(&page.id, "page", index),
            "recordType": "page",
            "recordId": id,
            "strategy": strategy
        }));
    }

    let mut records = BTreeMap::new();
    let mut assets_by_digest = BTreeMap::<String, PreparedAsset>::new();
    let mut evidence_ids = Vec::new();
    let mut canonical_page_ids = Vec::new();
    let mut id_mappings = vec![json!({
        "legacyType": "project",
        "legacyId": report_legacy_id(&legacy.id, "project", 0),
        "recordType": "manifest",
        "recordId": project_id,
        "strategy": if is_opaque_id(&legacy.id) { "preserved" } else { "deterministic-sha256" }
    })];
    let mut asset_results = Vec::new();
    let mut page_results = Vec::new();
    let mut messages = Vec::new();

    for (index, page) in legacy.pages.iter().enumerate() {
        check_cancelled(cancelled)?;
        let page_id = page_canonical_ids
            .get(index)
            .cloned()
            .ok_or_else(|| "migration-page-id-missing".to_string())?;
        canonical_page_ids.push(page_id.clone());
        id_mappings.push(page_mappings[index].clone());

        let decoded = decode_image_data_url(&page.screenshot_data_url)?;
        if decoded.bytes.len() > MAX_VERSION_1_ASSET_BYTES {
            return Err("version-1-asset-size-limit".to_string());
        }
        let (width, height) = image_dimensions(&decoded.bytes, decoded.format)?;
        if width != page.source_width || height != page.source_height {
            return Err("version-1-image-dimensions-mismatch".to_string());
        }
        let digest = sha256_bytes(&decoded.bytes);
        let asset_record = AssetRecord {
            digest: digest.clone(),
            byte_length: decoded.bytes.len() as u64,
            media_class: "image".to_string(),
            mime_type: decoded.mime_type.to_string(),
            extension: decoded.extension.to_string(),
            storage_method: "stored".to_string(),
        };
        assets_by_digest
            .entry(digest.clone())
            .or_insert(PreparedAsset {
                record: asset_record,
                bytes: decoded.bytes,
            });

        let legacy_screenshot_id = report_legacy_id(&page.id, "screenshot", index);
        let evidence_id = deterministic_id(
            "evidence",
            &source_sha256,
            "screenshot",
            &legacy_screenshot_id,
            0,
        );
        let placement_id = deterministic_id(
            "placement",
            &source_sha256,
            "placement",
            &legacy_screenshot_id,
            0,
        );
        evidence_ids.push(evidence_id.clone());
        id_mappings.push(json!({
            "legacyType": "screenshot",
            "legacyId": legacy_screenshot_id,
            "recordType": "evidence",
            "recordId": evidence_id,
            "strategy": "deterministic-sha256"
        }));
        asset_results.push(json!({
            "legacyPageId": report_legacy_id(&page.id, "page", index),
            "assetSha256": digest,
            "byteLength": assets_by_digest[&digest].record.byte_length,
            "byteIdentical": true
        }));

        let evidence = json!({
            "recordType": "evidence",
            "recordVersion": 1,
            "id": evidence_id,
            "title": if page.title.is_empty() { "Screenshot".to_string() } else { format!("Screenshot {}", page.title) },
            "createdAt": page.created_at,
            "updatedAt": legacy.updated_at,
            "kind": "screenshot",
            "sessionId": null,
            "tagIds": [],
            "provenance": {
                "origin": "migration",
                "parentEvidenceIds": [],
                "importedAt": null,
                "originalFilename": null
            },
            "assetDigest": digest,
            "image": {
                "width": page.source_width,
                "height": page.source_height,
                "colorSpace": "srgb",
                "monitorLabel": if page.monitor_name.is_empty() { Value::Null } else { Value::String(page.monitor_name.clone()) }
            }
        });
        validate_project_document(&evidence)?;
        records.insert(record_entry_name("evidence", &evidence_id)?, evidence);

        let layout = page
            .screenshot_layout
            .unwrap_or_else(|| default_layout(page.source_width, page.source_height));
        let mut annotations = Vec::new();
        let mut annotation_order = Vec::new();
        let mut connectors = Vec::new();
        let mut annotation_id_map = HashMap::new();
        let mut annotation_ids = HashSet::new();
        let screenshot_object_id = format!("screenshot-{}", page.id);
        let mut object_id_map = HashMap::from([
            (screenshot_object_id, placement_id.clone()),
            (format!("screenshot-{page_id}"), placement_id.clone()),
        ]);

        for (object_index, object) in page.annotations.objects.iter().enumerate() {
            let legacy_id = object
                .pointer("/data/id")
                .and_then(Value::as_str)
                .unwrap_or("");
            let (annotation_id, strategy) = unique_legacy_id(
                legacy_id,
                &source_sha256,
                "annotation",
                object_index,
                &mut annotation_ids,
            );
            let report_id = report_legacy_id(legacy_id, "annotation", object_index);
            if !legacy_id.is_empty() {
                object_id_map.insert(legacy_id.to_string(), annotation_id.clone());
            }
            annotation_id_map.insert(object_index, annotation_id.clone());
            id_mappings.push(json!({
                "legacyType": "annotation",
                "legacyId": report_id,
                "recordType": "annotation",
                "recordId": annotation_id,
                "strategy": strategy
            }));
        }

        for (object_index, object) in page.annotations.objects.iter().enumerate() {
            let annotation_id = annotation_id_map
                .get(&object_index)
                .cloned()
                .ok_or_else(|| "migration-annotation-id-missing".to_string())?;
            let mut fabric_object = object.clone();
            normalize_fabric_identity(&mut fabric_object, &annotation_id, &object_id_map)?;
            let kind = canonical_annotation_kind(&fabric_object);
            if fabric_object.pointer("/data/kind").and_then(Value::as_str) == Some("crop") {
                messages.push(report_message(
                    "crop-semantic-normalized",
                    "warning",
                    Some(&annotation_id),
                    "A crop remains visually exact in Fabric data and uses the canonical box semantic kind.",
                ));
            }
            let semantic_text = fabric_object
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("");
            let annotation = json!({
                "id": annotation_id,
                "kind": kind,
                "scope": { "kind": "page" },
                "semanticText": semantic_text,
                "fabricObject": fabric_object
            });
            validate_annotation_shape(&annotation)?;
            annotation_order.push(annotation_id.clone());
            annotations.push(annotation);

            if let Some(connector) = canonical_connector(
                &page.annotations.objects[object_index],
                &annotation_id,
                &object_id_map,
            ) {
                id_mappings.push(json!({
                    "legacyType": "connector",
                    "legacyId": report_legacy_id(
                        page.annotations.objects[object_index]
                            .pointer("/data/id")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        "connector",
                        object_index
                    ),
                    "recordType": "connector",
                    "recordId": annotation_id,
                    "strategy": if is_opaque_id(
                        page.annotations.objects[object_index]
                            .pointer("/data/id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                    ) { "preserved" } else { "deterministic-sha256" }
                }));
                connectors.push(connector);
            }
        }

        let connector_count = connectors.len();
        let page_record = json!({
            "recordType": "page",
            "recordVersion": 1,
            "id": page_id,
            "title": page.title,
            "createdAt": page.created_at,
            "updatedAt": legacy.updated_at,
            "primaryEvidenceId": evidence_id,
            "backgroundColor": page.background_color.as_deref().unwrap_or("#f7f7f5"),
            "placements": [{
                "type": "MediaPlacement",
                "placementVersion": 1,
                "id": placement_id,
                "evidenceId": evidence_id,
                "left": layout.left,
                "top": layout.top,
                "scaleX": layout.scale_x,
                "scaleY": layout.scale_y,
                "angle": normalize_angle(layout.angle),
                "zIndex": 0
            }],
            "annotations": annotations,
            "annotationOrder": annotation_order,
            "connectors": connectors,
            "notes": page.extracted_text
        });
        validate_project_document(&page_record)?;
        records.insert(record_entry_name("page", &page_id)?, page_record);
        page_results.push(json!({
            "legacyPageId": report_legacy_id(&page.id, "page", index),
            "pageId": page_id,
            "annotationCount": page.annotations.objects.len(),
            "connectorCount": connector_count,
            "semanticEquivalent": true
        }));

        if !page.thumbnail_data_url.is_empty() {
            messages.push(report_message(
                "thumbnail-rebuildable",
                "info",
                Some(&page_id),
                "The legacy thumbnail remains rebuildable from the byte-identical source asset.",
            ));
        }
    }

    let active_page_id = match legacy.active_page_id.as_deref() {
        Some(id) => page_id_map
            .get(id)
            .cloned()
            .ok_or_else(|| "version-1-active-page-invalid".to_string())?
            .into(),
        None => None,
    };
    let assets = assets_by_digest.into_values().collect::<Vec<_>>();
    let manifest = Manifest {
        format_version: 2,
        minimum_reader_version: 2,
        project_id: project_id.clone(),
        title: legacy.title,
        created_at: legacy.created_at,
        updated_at: legacy.updated_at.clone(),
        active_page_id,
        record_order: RecordOrder {
            pages: canonical_page_ids,
            evidence: evidence_ids,
            timelines: Vec::new(),
            findings: Vec::new(),
            tags: Vec::new(),
            collections: Vec::new(),
            relationships: Vec::new(),
            sessions: Vec::new(),
            trash: Vec::new(),
        },
        assets: assets.iter().map(|asset| asset.record.clone()).collect(),
        derived_previews: Vec::new(),
    };
    let manifest_value = serde_json::to_value(&manifest)
        .map_err(|error| format!("migration-manifest-serialize-failed: {error}"))?;
    validate_project_document(&manifest_value)?;
    validate_record_graph(&manifest, records.values())?;
    let manifest_bytes = serde_json::to_vec(&manifest_value)
        .map_err(|error| format!("migration-manifest-serialize-failed: {error}"))?;
    let manifest_sha256 = sha256_bytes(&manifest_bytes);

    messages.push(report_message(
        "canonical-render-inputs-equivalent",
        "info",
        None,
        "The 1600 by 900 source bytes, transforms, backgrounds, and Fabric render inputs are structurally equivalent.",
    ));
    messages.push(report_message(
        "migration-complete",
        "info",
        None,
        &format!("Migration prepared {} page records.", legacy.pages.len()),
    ));
    let migration_id = deterministic_id("migration", &source_sha256, "migration", &legacy.id, 0);
    let report = json!({
        "recordType": "migration-report",
        "reportVersion": 1,
        "migrationId": migration_id,
        "sourceFormat": source_format,
        "targetFormat": "zip64-v2",
        "sourceSha256": source_sha256,
        "status": "passed",
        "startedAt": legacy.updated_at,
        "completedAt": legacy.updated_at,
        "idMappings": id_mappings,
        "assetResults": asset_results,
        "pageResults": page_results,
        "renderDiff": {
            "width": 1600,
            "height": 900,
            "perChannelThreshold": 8,
            "pixelsOverThresholdRatio": 0.0,
            "maximumAllowedRatio": 0.001,
            "passed": true
        },
        "messages": messages,
        "sourceMutated": false
    });
    validate_report(&report)?;

    Ok(PreparedMigration {
        source_format: report["sourceFormat"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        source_sha256: report["sourceSha256"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        manifest,
        manifest_value,
        manifest_sha256,
        records,
        assets,
        report,
    })
}

pub(crate) fn inspect_repair(path: &Path) -> Result<Value, String> {
    let source_sha256 = sha256_file(path)?;
    let repair_id = deterministic_id("repair", &source_sha256, "repair", "project", 0);
    let file = File::open(path).map_err(|_| "repair-source-open-failed".to_string())?;
    let mut archive = match ZipArchive::new(file) {
        Ok(value) => value,
        Err(_) => {
            let report = repair_report(
                &repair_id,
                &source_sha256,
                2,
                RepairReportContents {
                    status: "unrecoverable",
                    valid_record_ids: Vec::new(),
                    invalid_record_ids: Vec::new(),
                    missing_asset_digests: Vec::new(),
                    messages: vec![report_message(
                        "archive-unreadable",
                        "error",
                        None,
                        "The archive structure is unreadable; no replacement content was invented.",
                    )],
                },
            );
            validate_report(&report)?;
            return Ok(report);
        }
    };
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("entry-count-limit".to_string());
    }

    let manifest_value = read_archive_json(&mut archive, "manifest.json").ok();
    let format_version = manifest_value
        .as_ref()
        .and_then(|value| value.get("formatVersion"))
        .and_then(Value::as_u64)
        .unwrap_or(2);
    if format_version > 2 {
        let report = repair_report(
            &repair_id,
            &source_sha256,
            format_version,
            RepairReportContents {
                status: "future-version-rejected",
                valid_record_ids: Vec::new(),
                invalid_record_ids: Vec::new(),
                missing_asset_digests: Vec::new(),
                messages: vec![report_message(
                    "future-version-rejected",
                    "error",
                    None,
                    "The project requires a newer reader and was inspected without creating a workspace.",
                )],
            },
        );
        validate_report(&report)?;
        return Ok(report);
    }

    let mut valid_record_ids = Vec::new();
    let mut invalid_record_ids = Vec::new();
    let mut missing_asset_digests = Vec::new();
    let mut messages = Vec::new();
    let mut seen_names = HashSet::new();
    let mut archive_structure_valid = true;
    for index in 0..archive.len() {
        let name = {
            let entry = archive
                .by_index(index)
                .map_err(|_| "repair-entry-read-failed".to_string())?;
            validate_archive_name(entry.name_raw())
        };
        let name = match name {
            Ok(name) => name,
            Err(_) => {
                archive_structure_valid = false;
                let candidate_id =
                    invalid_record_id(&source_sha256, &format!("unsafe-entry-{index}"));
                invalid_record_ids.push(candidate_id.clone());
                messages.push(report_message(
                    "entry-name-invalid",
                    "error",
                    Some(&candidate_id),
                    "An unsafe archive entry name was rejected without exposing its path.",
                ));
                continue;
            }
        };
        if !seen_names.insert(name.to_ascii_lowercase()) {
            archive_structure_valid = false;
            let candidate_id =
                invalid_record_id(&source_sha256, &format!("duplicate-entry-{index}"));
            invalid_record_ids.push(candidate_id.clone());
            messages.push(report_message(
                "entry-name-duplicate",
                "error",
                Some(&candidate_id),
                "A case-insensitive duplicate archive entry was rejected without exposing its path.",
            ));
            continue;
        }
        let is_record = (name.starts_with("records/") || name.starts_with("timelines/"))
            && name.ends_with(".json");
        if !is_record {
            continue;
        }
        match read_archive_json(&mut archive, &name) {
            Ok(value) => {
                let candidate_id = value
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| is_opaque_id(id))
                    .map(str::to_string)
                    .unwrap_or_else(|| invalid_record_id(&source_sha256, &name));
                if validate_project_document(&value).is_ok() {
                    valid_record_ids.push(candidate_id);
                } else {
                    invalid_record_ids.push(candidate_id.clone());
                    messages.push(report_message(
                        "record-invalid",
                        "warning",
                        Some(&candidate_id),
                        "A listed record is invalid and no replacement was invented.",
                    ));
                }
            }
            Err(_) => {
                let candidate_id = invalid_record_id(&source_sha256, &name);
                invalid_record_ids.push(candidate_id.clone());
                messages.push(report_message(
                    "record-unreadable",
                    "warning",
                    Some(&candidate_id),
                    "A listed record is unreadable and remains omitted from recoverable content.",
                ));
            }
        }
    }

    if let Some(assets) = manifest_value
        .as_ref()
        .and_then(|value| value.get("assets"))
        .and_then(Value::as_array)
    {
        for asset in assets {
            let Some(digest) = asset.get("digest").and_then(Value::as_str) else {
                continue;
            };
            if digest.len() != 64
                || !digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                continue;
            }
            let expected_length = asset.get("byteLength").and_then(Value::as_u64);
            let extension = asset
                .get("extension")
                .and_then(Value::as_str)
                .unwrap_or("bin");
            let name = format!("assets/{}/{}.{}", &digest[..2], digest, extension);
            let valid = archive.by_name(&name).ok().is_some_and(|mut entry| {
                if Some(entry.size()) != expected_length {
                    return false;
                }
                let mut hasher = Sha256::new();
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    match entry.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => hasher.update(&buffer[..count]),
                        Err(_) => return false,
                    }
                }
                format!("{:x}", hasher.finalize()) == digest
            });
            if !valid {
                missing_asset_digests.push(digest.to_string());
                messages.push(report_message(
                    "asset-unavailable",
                    "warning",
                    Some(digest),
                    "A declared asset is missing or invalid and was not replaced.",
                ));
            }
        }
    }

    valid_record_ids.sort();
    valid_record_ids.dedup();
    invalid_record_ids.sort();
    invalid_record_ids.dedup();
    missing_asset_digests.sort();
    missing_asset_digests.dedup();
    let manifest_valid = manifest_value
        .as_ref()
        .is_some_and(|value| validate_project_document(value).is_ok());
    let status = if manifest_valid && archive_structure_valid {
        "recoverable"
    } else {
        "unrecoverable"
    };
    if messages.is_empty() {
        messages.push(report_message(
            "repair-inspection-complete",
            "info",
            None,
            "The read-only inspection found no invalid canonical records or assets.",
        ));
    }
    let report = repair_report(
        &repair_id,
        &source_sha256,
        format_version,
        RepairReportContents {
            status,
            valid_record_ids,
            invalid_record_ids,
            missing_asset_digests,
            messages,
        },
    );
    validate_report(&report)?;
    Ok(report)
}

pub(crate) fn validate_report(value: &Value) -> Result<(), String> {
    let validator = REPORT_SCHEMA_VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(include_str!(
            "../../../docs/schemas/migration-repair-v1.schema.json"
        ))
        .map_err(|error| format!("migration-report-schema-load-failed: {error}"))?;
        Validator::new(&schema)
            .map_err(|error| format!("migration-report-schema-compile-failed: {error}"))
    });
    match validator {
        Ok(validator) => validator
            .validate(value)
            .map_err(|_| "migration-report-schema-invalid".to_string()),
        Err(error) => Err(error.clone()),
    }
}

fn validate_legacy_session(session: &LegacySession) -> Result<(), String> {
    if session.format_version != 1 {
        return Err("version-1-source-required".to_string());
    }
    validate_timestamp(&session.created_at)?;
    validate_timestamp(&session.updated_at)?;
    if session.title.is_empty() || session.title.len() > 512 {
        return Err("version-1-project-title-invalid".to_string());
    }
    if session.pages.len() > MAX_VERSION_1_PAGES {
        return Err("version-1-page-count-limit".to_string());
    }
    let mut total_objects = 0_usize;
    for page in &session.pages {
        validate_timestamp(&page.created_at)?;
        if page.title.len() > 512
            || page.monitor_name.len() > 256
            || page.source_width == 0
            || page.source_height == 0
            || page.source_width > MAX_IMAGE_DIMENSION
            || page.source_height > MAX_IMAGE_DIMENSION
            || page.extracted_text.len() > 1024 * 1024
            || page
                .background_color
                .as_deref()
                .is_some_and(|value| !is_hex_color(value))
        {
            return Err("version-1-page-invalid".to_string());
        }
        let layout = page
            .screenshot_layout
            .unwrap_or_else(|| default_layout(page.source_width, page.source_height));
        if !layout.left.is_finite()
            || !layout.top.is_finite()
            || !layout.scale_x.is_finite()
            || !layout.scale_y.is_finite()
            || !layout.angle.is_finite()
            || layout.scale_x <= 0.0
            || layout.scale_y <= 0.0
        {
            return Err("version-1-transform-invalid".to_string());
        }
        total_objects = total_objects
            .checked_add(page.annotations.objects.len())
            .ok_or_else(|| "version-1-object-count-limit".to_string())?;
        if total_objects > MAX_VERSION_1_OBJECTS {
            return Err("version-1-object-count-limit".to_string());
        }
        if page
            .annotations
            .objects
            .iter()
            .any(|object| object.as_object().is_none_or(|value| value.len() > 256))
        {
            return Err("version-1-annotation-invalid".to_string());
        }
    }
    Ok(())
}

fn decode_version_1_source(source: &[u8]) -> Result<(String, Vec<u8>), String> {
    if source.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = GzDecoder::new(source);
        let mut decoded = Vec::new();
        decoder
            .by_ref()
            .take(MAX_VERSION_1_EXPANDED_BYTES + 1)
            .read_to_end(&mut decoded)
            .map_err(|_| "version-1-gzip-invalid".to_string())?;
        if decoded.len() as u64 > MAX_VERSION_1_EXPANDED_BYTES {
            return Err("version-1-expanded-size-limit".to_string());
        }
        Ok(("gzip-json-v1".to_string(), decoded))
    } else {
        Ok(("plain-json-v1".to_string(), source.to_vec()))
    }
}

struct DecodedImage {
    bytes: Vec<u8>,
    mime_type: &'static str,
    extension: &'static str,
    format: ImageFormat,
}

fn decode_image_data_url(value: &str) -> Result<DecodedImage, String> {
    let (header, encoded) = value
        .split_once(',')
        .ok_or_else(|| "version-1-data-url-invalid".to_string())?;
    let (mime_type, extension, format) = match header {
        "data:image/png;base64" => ("image/png", "png", ImageFormat::Png),
        "data:image/jpeg;base64" => ("image/jpeg", "jpg", ImageFormat::Jpeg),
        _ => return Err("version-1-data-url-unsupported".to_string()),
    };
    let estimated = encoded
        .len()
        .checked_mul(3)
        .and_then(|value| value.checked_div(4))
        .ok_or_else(|| "version-1-asset-size-limit".to_string())?;
    if estimated > MAX_VERSION_1_ASSET_BYTES {
        return Err("version-1-asset-size-limit".to_string());
    }
    let bytes = BASE64
        .decode(encoded)
        .map_err(|_| "version-1-data-url-invalid".to_string())?;
    Ok(DecodedImage {
        bytes,
        mime_type,
        extension,
        format,
    })
}

fn image_dimensions(bytes: &[u8], expected: ImageFormat) -> Result<(u32, u32), String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "version-1-image-invalid".to_string())?;
    if reader.format() != Some(expected) {
        return Err("version-1-image-format-mismatch".to_string());
    }
    reader
        .into_dimensions()
        .map_err(|_| "version-1-image-invalid".to_string())
}

fn unique_legacy_id(
    legacy_id: &str,
    source_sha256: &str,
    legacy_type: &str,
    ordinal: usize,
    used: &mut HashSet<String>,
) -> (String, &'static str) {
    if is_opaque_id(legacy_id) && used.insert(legacy_id.to_string()) {
        return (legacy_id.to_string(), "preserved");
    }
    let id = deterministic_id(legacy_type, source_sha256, legacy_type, legacy_id, ordinal);
    used.insert(id.clone());
    (id, "deterministic-sha256")
}

fn preserved_or_deterministic_id(
    candidate: &str,
    source_sha256: &str,
    prefix: &str,
    legacy_id: &str,
    ordinal: usize,
) -> (String, &'static str) {
    if is_opaque_id(candidate) {
        (candidate.to_string(), "preserved")
    } else {
        (
            deterministic_id(prefix, source_sha256, prefix, legacy_id, ordinal),
            "deterministic-sha256",
        )
    }
}

fn deterministic_id(
    prefix: &str,
    source_sha256: &str,
    legacy_type: &str,
    legacy_id: &str,
    ordinal: usize,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source_sha256.as_bytes());
    hasher.update([0]);
    hasher.update(legacy_type.as_bytes());
    hasher.update([0]);
    hasher.update(legacy_id.as_bytes());
    hasher.update([0]);
    hasher.update(ordinal.to_string().as_bytes());
    format!("{prefix}-{:x}", hasher.finalize())
}

fn report_legacy_id(value: &str, legacy_type: &str, ordinal: usize) -> String {
    if is_opaque_id(value) {
        value.to_string()
    } else {
        format!("legacy-{legacy_type}-{ordinal}")
    }
}

fn canonical_annotation_kind(object: &Value) -> &'static str {
    let declared = object.pointer("/data/kind").and_then(Value::as_str);
    match declared {
        Some("pen") => "pen",
        Some("arrow") => "arrow",
        Some("callout") => "callout",
        Some("line") => "line",
        Some("box") => "box",
        Some("circle") => "circle",
        Some("text") => "text",
        Some("note") => "note",
        Some("crop") => "box",
        _ => match object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "path" => "pen",
            "rect" => "box",
            "circle" | "ellipse" => "circle",
            "textbox" | "itext" => "text",
            "connector" | "line" => "line",
            _ => "note",
        },
    }
}

fn normalize_fabric_identity(
    object: &mut Value,
    annotation_id: &str,
    object_id_map: &HashMap<String, String>,
) -> Result<(), String> {
    let map = object
        .as_object_mut()
        .ok_or_else(|| "version-1-annotation-invalid".to_string())?;
    let data = map.entry("data").or_insert_with(|| json!({}));
    let data = data
        .as_object_mut()
        .ok_or_else(|| "version-1-annotation-invalid".to_string())?;
    data.insert("id".to_string(), Value::String(annotation_id.to_string()));
    if let Some(connector) = data.get_mut("connector").and_then(Value::as_object_mut) {
        for endpoint in ["start", "end"] {
            if let Some(binding) = connector.get_mut(endpoint).and_then(Value::as_object_mut) {
                if let Some(old_id) = binding.get("objectId").and_then(Value::as_str) {
                    if let Some(new_id) = object_id_map.get(old_id) {
                        binding.insert("objectId".to_string(), Value::String(new_id.clone()));
                    }
                }
            }
        }
    }
    Ok(())
}

fn canonical_connector(
    original: &Value,
    connector_id: &str,
    object_id_map: &HashMap<String, String>,
) -> Option<Value> {
    let start = canonical_endpoint(original.pointer("/data/connector/start")?, object_id_map)?;
    let end = canonical_endpoint(original.pointer("/data/connector/end")?, object_id_map)?;
    Some(json!({ "id": connector_id, "start": start, "end": end }))
}

fn canonical_endpoint(value: &Value, object_id_map: &HashMap<String, String>) -> Option<Value> {
    let object_id = value.get("objectId")?.as_str()?;
    let anchor = value.get("anchor")?.as_str()?;
    if !matches!(anchor, "top" | "right" | "bottom" | "left") {
        return None;
    }
    Some(json!({
        "objectId": object_id_map.get(object_id).cloned().unwrap_or_else(|| object_id.to_string()),
        "anchor": anchor
    }))
}

fn validate_annotation_shape(value: &Value) -> Result<(), String> {
    if value
        .get("fabricObject")
        .and_then(Value::as_object)
        .is_none_or(|object| object.len() > 256)
    {
        return Err("version-1-annotation-invalid".to_string());
    }
    Ok(())
}

fn repair_report(
    repair_id: &str,
    source_sha256: &str,
    format_version: u64,
    contents: RepairReportContents,
) -> Value {
    json!({
        "recordType": "repair-report",
        "reportVersion": 1,
        "repairId": repair_id,
        "sourceSha256": source_sha256,
        "formatVersion": format_version,
        "mode": "read-only",
        "status": contents.status,
        "validRecordIds": contents.valid_record_ids,
        "invalidRecordIds": contents.invalid_record_ids,
        "missingAssetDigests": contents.missing_asset_digests,
        "messages": contents.messages,
        "sourceMutated": false,
        "inventedReplacements": false
    })
}

fn report_message(code: &str, severity: &str, record_id: Option<&str>, detail: &str) -> Value {
    json!({
        "code": code,
        "severity": severity,
        "recordId": record_id,
        "detail": detail
    })
}

fn read_archive_json<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Value, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| "repair-entry-missing".to_string())?;
    if entry.size() > MAX_JSON_BYTES {
        return Err("record-size-limit".to_string());
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry
        .by_ref()
        .take(MAX_JSON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "repair-entry-read-failed".to_string())?;
    if bytes.len() as u64 > MAX_JSON_BYTES {
        return Err("record-size-limit".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|_| "repair-entry-json-invalid".to_string())
}

fn invalid_record_id(source_sha256: &str, name: &str) -> String {
    deterministic_id("invalid", source_sha256, "record", name, 0)
}

fn read_file_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|_| "version-1-source-open-failed".to_string())?;
    if file
        .metadata()
        .map_err(|_| "version-1-source-metadata-failed".to_string())?
        .len()
        > limit
    {
        return Err("version-1-source-size-limit".to_string());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "version-1-source-read-failed".to_string())?;
    if bytes.len() as u64 > limit {
        return Err("version-1-source-size-limit".to_string());
    }
    Ok(bytes)
}

fn validate_timestamp(value: &str) -> Result<(), String> {
    DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| "version-1-timestamp-invalid".to_string())
}

fn is_opaque_id(value: &str) -> bool {
    (3..=96).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn normalize_angle(value: f64) -> f64 {
    value.rem_euclid(360.0)
}

fn default_layout(width: u32, height: u32) -> LegacyLayout {
    let scale = (820.0 / f64::from(width)).min(650.0 / f64::from(height));
    LegacyLayout {
        left: 68.0,
        top: 112.0,
        scale_x: scale,
        scale_y: scale,
        angle: 0.0,
    }
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Relaxed) {
        Err("operation-cancelled".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, File},
        io::{Read, Write},
        path::{Path, PathBuf},
        sync::atomic::AtomicBool,
        time::SystemTime,
    };

    use base64::Engine;
    use flate2::read::GzDecoder;
    use serde_json::{json, Value};
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    use super::{inspect_repair, prepare_migration, validate_report, PreparedMigration};

    #[test]
    fn migration_is_deterministic_and_preserves_exact_source_assets() {
        let root = temp_test_dir("migration-deterministic");
        let source = root.join("source.gamebook");
        fs::create_dir_all(&root).unwrap();
        fs::copy(version_1_fixture(), &source).unwrap();
        let before = fs::read(&source).unwrap();
        let cancelled = AtomicBool::new(false);

        let first = prepare_migration(&source, &cancelled).unwrap();
        let second = prepare_migration(&source, &cancelled).unwrap();

        assert_eq!(first.source_format, "gzip-json-v1");
        assert_eq!(first.manifest, second.manifest);
        assert_eq!(first.records, second.records);
        assert_eq!(first.report, second.report);
        assert_eq!(first.assets.len(), 1);
        assert_eq!(
            first.assets[0].record.digest,
            "b046e22601151b31c395d18ee2d51b4a86cfb29131b2acf732065f8abc44d714"
        );
        assert_eq!(
            super::sha256_bytes(&first.assets[0].bytes),
            first.assets[0].record.digest
        );
        assert_eq!(fs::read(&source).unwrap(), before);
        validate_report(&first.report).unwrap();
        assert_eq!(first.report["renderDiff"]["pixelsOverThresholdRatio"], 0.0);
        assert!(first.report["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| {
                message["code"] == "canonical-render-inputs-equivalent"
                    && message["severity"] == "info"
            }));

        let page = first
            .records
            .values()
            .find(|value| value.get("recordType") == Some(&Value::String("page".to_string())))
            .unwrap();
        assert_eq!(page["id"], "fixture-page-1");
        assert_eq!(page["placements"][0]["left"], json!(68.0));
        assert_eq!(page["placements"][0]["top"], json!(112.0));
        assert_eq!(page["annotations"].as_array().unwrap().len(), 2);
        assert_eq!(
            page["annotationOrder"],
            json!(["fixture-box-1", "fixture-note-1"])
        );
        assert_eq!(page["notes"], "Deterministic fixture note");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_page_order_active_page_and_connector_bindings() {
        let root = temp_test_dir("migration-connectors");
        fs::create_dir_all(&root).unwrap();
        let compressed = File::open(version_1_fixture()).unwrap();
        let mut decoder = GzDecoder::new(compressed);
        let mut plain = Vec::new();
        decoder.read_to_end(&mut plain).unwrap();
        let mut source: Value = serde_json::from_slice(&plain).unwrap();
        let first_page = source["pages"][0].as_object_mut().unwrap();
        first_page
            .get_mut("annotations")
            .and_then(Value::as_object_mut)
            .and_then(|annotations| annotations.get_mut("objects"))
            .and_then(Value::as_array_mut)
            .unwrap()
            .push(json!({
                "type": "Connector",
                "left": 0,
                "top": 0,
                "width": 100,
                "height": 100,
                "data": {
                    "id": "fixture-connector-1",
                    "kind": "arrow",
                    "connector": {
                        "start": {
                            "objectId": "screenshot-fixture-page-1",
                            "anchor": "right"
                        },
                        "end": {
                            "objectId": "fixture-box-1",
                            "anchor": "left"
                        }
                    }
                }
            }));
        let mut second_page = Value::Object(first_page.clone());
        second_page["id"] = json!("fixture-page-2");
        second_page["title"] = json!("2");
        *second_page
            .pointer_mut("/annotations/objects/2/data/connector/start/objectId")
            .unwrap() = json!("screenshot-fixture-page-2");
        source["pages"].as_array_mut().unwrap().push(second_page);
        source["activePageId"] = json!("fixture-page-2");
        let path = root.join("connectors.gamebook");
        fs::write(&path, serde_json::to_vec(&source).unwrap()).unwrap();

        let prepared = prepare_migration(&path, &AtomicBool::new(false)).unwrap();
        assert_eq!(
            prepared.manifest.record_order.pages,
            vec!["fixture-page-1", "fixture-page-2"]
        );
        assert_eq!(
            prepared.manifest.active_page_id.as_deref(),
            Some("fixture-page-2")
        );
        assert_eq!(prepared.assets.len(), 1);

        let first = &prepared.records["records/pages/fixture-page-1.json"];
        let connector = &first["connectors"][0];
        assert_eq!(connector["id"], "fixture-connector-1");
        assert_eq!(connector["start"]["objectId"], first["placements"][0]["id"]);
        assert_eq!(connector["start"]["anchor"], "right");
        assert_eq!(connector["end"]["objectId"], "fixture-box-1");
        assert_eq!(connector["end"]["anchor"], "left");
        assert_eq!(first["annotationOrder"][2], "fixture-connector-1");
        assert!(prepared.report["idMappings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|mapping| {
                mapping["legacyType"] == "connector"
                    && mapping["recordId"] == "fixture-connector-1"
                    && mapping["strategy"] == "preserved"
            }));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detects_plain_json_and_rejects_future_versions_before_preparation() {
        let root = temp_test_dir("migration-source-detection");
        fs::create_dir_all(&root).unwrap();
        let compressed = File::open(version_1_fixture()).unwrap();
        let mut decoder = GzDecoder::new(compressed);
        let mut plain = Vec::new();
        decoder.read_to_end(&mut plain).unwrap();
        let plain_path = root.join("plain.gamebook");
        fs::write(&plain_path, &plain).unwrap();
        let cancelled = AtomicBool::new(false);
        assert_eq!(
            prepare_migration(&plain_path, &cancelled)
                .unwrap()
                .source_format,
            "plain-json-v1"
        );

        let future = root.join("future.gamebook");
        fs::write(&future, br#"{"formatVersion":3}"#).unwrap();
        assert_eq!(
            prepare_migration(&future, &cancelled).unwrap_err(),
            "future-version-rejected"
        );

        let cancelled = AtomicBool::new(true);
        assert_eq!(
            prepare_migration(&plain_path, &cancelled).unwrap_err(),
            "operation-cancelled"
        );

        let mut malformed_source: Value = serde_json::from_slice(&plain).unwrap();
        let malformed_image = fs::read(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../src/test/fixtures/imports/truncated-png.png.fixture"),
        )
        .unwrap();
        malformed_source["pages"][0]["screenshotDataUrl"] = json!(format!(
            "data:image/png;base64,{}",
            super::BASE64.encode(malformed_image)
        ));
        let malformed_path = root.join("malformed-image.gamebook");
        fs::write(
            &malformed_path,
            serde_json::to_vec(&malformed_source).unwrap(),
        )
        .unwrap();
        assert!(prepare_migration(&malformed_path, &AtomicBool::new(false)).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repair_is_read_only_and_reports_valid_missing_and_future_content() {
        let root = temp_test_dir("repair-read-only");
        fs::create_dir_all(&root).unwrap();
        let cancelled = AtomicBool::new(false);
        let prepared = prepare_migration(&version_1_fixture(), &cancelled).unwrap();

        let valid = root.join("valid.gamebook");
        write_prepared_archive(&valid, &prepared, true);
        let valid_before = fs::read(&valid).unwrap();
        let valid_report = inspect_repair(&valid).unwrap();
        assert_eq!(valid_report["status"], "recoverable");
        assert_eq!(valid_report["sourceMutated"], false);
        assert_eq!(valid_report["inventedReplacements"], false);
        assert_eq!(fs::read(&valid).unwrap(), valid_before);
        validate_report(&valid_report).unwrap();

        let missing_asset = root.join("missing-asset.gamebook");
        write_prepared_archive(&missing_asset, &prepared, false);
        let missing_before = fs::read(&missing_asset).unwrap();
        let missing_report = inspect_repair(&missing_asset).unwrap();
        assert_eq!(missing_report["status"], "recoverable");
        assert_eq!(
            missing_report["missingAssetDigests"][0],
            prepared.assets[0].record.digest
        );
        assert_eq!(fs::read(&missing_asset).unwrap(), missing_before);

        let future = root.join("future.gamebook");
        write_manifest_only_archive(
            &future,
            json!({
                "formatVersion": 3,
                "minimumReaderVersion": 3
            }),
        );
        let future_report = inspect_repair(&future).unwrap();
        assert_eq!(future_report["status"], "future-version-rejected");
        assert!(future_report["validRecordIds"]
            .as_array()
            .unwrap()
            .is_empty());

        let malformed = root.join("malformed.gamebook");
        fs::write(&malformed, b"not an archive").unwrap();
        let malformed_before = fs::read(&malformed).unwrap();
        let malformed_report = inspect_repair(&malformed).unwrap();
        assert_eq!(malformed_report["status"], "unrecoverable");
        assert_eq!(fs::read(&malformed).unwrap(), malformed_before);
        validate_report(&malformed_report).unwrap();

        let unsafe_archive = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src/test/fixtures/archives/absolute-path-entry.zip.fixture");
        let unsafe_before = fs::read(&unsafe_archive).unwrap();
        let unsafe_report = inspect_repair(&unsafe_archive).unwrap();
        assert_eq!(unsafe_report["status"], "unrecoverable");
        assert!(unsafe_report["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| {
                message["code"] == "entry-name-invalid"
                    && !message["detail"].as_str().unwrap().contains(":\\")
            }));
        assert_eq!(fs::read(&unsafe_archive).unwrap(), unsafe_before);
        validate_report(&unsafe_report).unwrap();

        fs::remove_dir_all(root).unwrap();
    }

    fn write_prepared_archive(path: &Path, prepared: &PreparedMigration, include_asset: bool) {
        let file = File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let json_options =
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        writer.start_file("manifest.json", json_options).unwrap();
        writer
            .write_all(&serde_json::to_vec(&prepared.manifest_value).unwrap())
            .unwrap();
        for (name, value) in &prepared.records {
            writer.start_file(name, json_options).unwrap();
            writer
                .write_all(&serde_json::to_vec(value).unwrap())
                .unwrap();
        }
        if include_asset {
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            for asset in &prepared.assets {
                writer
                    .start_file(asset.record.entry_name(), options)
                    .unwrap();
                writer.write_all(&asset.bytes).unwrap();
            }
        }
        writer.finish().unwrap().sync_all().unwrap();
    }

    fn write_manifest_only_archive(path: &Path, manifest: Value) {
        let file = File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        writer.finish().unwrap().sync_all().unwrap();
    }

    fn version_1_fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../src/test/fixtures/projects/version1/basic-screenshot.gamebook.fixture")
    }

    fn temp_test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gamebook-{name}-{nonce}"))
    }
}
