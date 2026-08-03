use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FORMAT_VERSION: u8 = 2;
pub const MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_ARCHIVE_ENTRIES: usize = 250_000;
pub const TOKEN_TTL_SECONDS: u64 = 10 * 60;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetRecord {
    pub digest: String,
    pub byte_length: u64,
    pub media_class: String,
    pub mime_type: String,
    pub extension: String,
    pub storage_method: String,
}

impl AssetRecord {
    pub fn entry_name(&self) -> String {
        format!(
            "assets/{}/{}.{}",
            &self.digest[..2],
            self.digest,
            self.extension
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DerivedPreview {
    pub evidence_id: String,
    pub kind: String,
    pub source_digest: String,
    pub preview_digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordOrder {
    pub pages: Vec<String>,
    pub evidence: Vec<String>,
    pub timelines: Vec<String>,
    pub findings: Vec<String>,
    pub tags: Vec<String>,
    pub collections: Vec<String>,
    pub relationships: Vec<String>,
    pub sessions: Vec<String>,
    pub trash: Vec<String>,
}

impl RecordOrder {
    pub fn lists(&self) -> [(&'static str, &'static str, &Vec<String>); 9] {
        [
            ("pages", "page", &self.pages),
            ("evidence", "evidence", &self.evidence),
            ("timelines", "timeline", &self.timelines),
            ("findings", "finding", &self.findings),
            ("tags", "tag", &self.tags),
            ("collections", "collection", &self.collections),
            ("relationships", "relationship", &self.relationships),
            ("sessions", "session", &self.sessions),
            ("trash", "trash", &self.trash),
        ]
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format_version: u8,
    pub minimum_reader_version: u8,
    pub project_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub active_page_id: Option<String>,
    pub record_order: RecordOrder,
    pub assets: Vec<AssetRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derived_previews: Vec<DerivedPreview>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceSignature {
    pub byte_length: u64,
    pub modified_100ns: u64,
    pub manifest_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStateDocument {
    pub record_type: String,
    pub workspace_version: u8,
    pub workspace_id: String,
    pub project_id: String,
    pub source_fingerprint: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
    pub dirty_record_ids: Vec<String>,
    pub new_asset_digests: Vec<String>,
    pub protected_classes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceLockDocument {
    pub record_type: String,
    pub lock_version: u8,
    pub workspace_id: String,
    pub process_id: u32,
    pub application_instance_id: String,
    pub source_fingerprint: String,
    pub heartbeat_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryJournalDocument {
    pub record_type: String,
    pub journal_version: u8,
    pub workspace_id: String,
    pub sequence: u64,
    pub written_at: String,
    pub operation: String,
    pub record_ids: Vec<String>,
    pub asset_digests: Vec<String>,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveJournalDocument {
    pub record_type: String,
    pub journal_version: u8,
    pub workspace_id: String,
    pub save_id: String,
    pub phase: String,
    pub started_at: String,
    pub source_fingerprint: String,
    pub replacement_validated: bool,
    pub visible_archive_reopened: bool,
    pub directory_flush_supported: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRegistryDocument {
    pub registry_version: u8,
    pub workspaces: Vec<WorkspaceRegistryEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRegistryEntry {
    pub workspace_id: String,
    pub project_id: String,
    pub source_fingerprint: String,
    pub manifest_sha256: String,
}

#[derive(Clone, Debug)]
pub struct ValidatedArchive {
    pub manifest: Manifest,
    pub manifest_value: Value,
    pub manifest_sha256: String,
    pub records: BTreeMap<String, Value>,
    pub source_signature: SourceSignature,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectResult {
    pub workspace_id: String,
    pub project_id: String,
    pub manifest: Value,
    pub records: Vec<Value>,
    pub reused_workspace: bool,
    pub copy_detected: bool,
    pub recovery_required: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalChangeChoice {
    Cancel,
    SaveAs,
    Replace,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectResult {
    pub operation_id: String,
    pub save_id: String,
    pub replaced_existing: bool,
    pub directory_flush_supported: bool,
    pub visible_archive_reopened: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedAssetResult {
    pub token: String,
    pub digest: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub expires_after_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEvictionResult {
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub evicted_entries: usize,
    pub cancelled: bool,
}

pub fn record_entry_name(record_type: &str, id: &str) -> Result<String, String> {
    let folder = match record_type {
        "page" => "pages",
        "evidence" => "evidence",
        "timeline" => return Ok(format!("timelines/{id}.json")),
        "finding" => "findings",
        "tag" => "tags",
        "collection" => "collections",
        "relationship" => "relationships",
        "session" => "sessions",
        "trash" => "trash",
        _ => return Err("record-type-unsupported".to_string()),
    };
    Ok(format!("records/{folder}/{id}.json"))
}
