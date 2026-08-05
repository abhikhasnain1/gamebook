use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{
    archive::validate_record_graph,
    model::{record_entry_name, Manifest, OpenProjectResult},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrashTarget {
    pub record_type: String,
    pub record_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashImpactItem {
    pub kind: String,
    pub record_type: String,
    pub record_id: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashImpact {
    pub targets: Vec<TrashTarget>,
    pub affected: Vec<TrashImpactItem>,
    pub blockers: Vec<TrashImpactItem>,
    pub blocked: bool,
    pub retained_asset_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashRecordSummary {
    pub trash_id: String,
    pub original_record_type: String,
    pub original_record_id: String,
    pub title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashTransactionSummary {
    pub transaction_id: String,
    pub deleted_at: String,
    pub eligible_after: String,
    pub eligible: bool,
    pub records: Vec<TrashRecordSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashState {
    pub transactions: Vec<TrashTransactionSummary>,
    pub total_records: usize,
    pub eligible_transactions: usize,
    pub retained_asset_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashMutationResult {
    pub transaction_id: Option<String>,
    pub state: TrashState,
    pub project: OpenProjectResult,
}

#[derive(Debug)]
pub struct CanonicalProject {
    pub manifest: Manifest,
    pub records: BTreeMap<String, Value>,
}

#[derive(Debug)]
pub struct TrashMutation {
    pub transaction_id: Option<String>,
    pub changed_documents: Vec<Value>,
    pub project: CanonicalProject,
}

impl CanonicalProject {
    pub fn validate(&self) -> Result<(), String> {
        validate_record_graph(&self.manifest, self.records.values())
    }
}

pub fn review(
    project: &CanonicalProject,
    requested: &[TrashTarget],
) -> Result<TrashImpact, String> {
    if requested.is_empty() {
        return Err("trash-targets-empty".to_string());
    }
    let by_key = records_by_key(&project.records)?;
    let mut targets = BTreeSet::new();
    for target in requested {
        validate_target(target)?;
        let key = (target.record_type.clone(), target.record_id.clone());
        if !by_key.contains_key(&key) {
            return Err("trash-target-not-found".to_string());
        }
        targets.insert(key);
    }

    loop {
        let mut added = false;
        for ((record_type, record_id), record) in &by_key {
            if record_type == "relationship"
                && !targets.contains(&(record_type.clone(), record_id.clone()))
            {
                let touches_target = ["source", "target"].iter().any(|field| {
                    record.get(*field).is_some_and(|reference| {
                        let key = (
                            reference
                                .get("recordType")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            reference
                                .get("recordId")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        );
                        targets.contains(&key)
                    })
                });
                if touches_target {
                    targets.insert((record_type.clone(), record_id.clone()));
                    added = true;
                }
            }
            if record_type == "timeline"
                && !targets.contains(&(record_type.clone(), record_id.clone()))
            {
                let video_id = record
                    .get("evidenceId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if targets.contains(&("evidence".to_string(), video_id.to_string())) {
                    targets.insert((record_type.clone(), record_id.clone()));
                    added = true;
                }
            }
        }
        if !added {
            break;
        }
    }

    let mut blockers = Vec::new();
    for (record_type, record_id) in &targets {
        blockers.extend(inbound_dependencies(
            &by_key,
            &targets,
            record_type,
            record_id,
        ));
    }
    blockers.sort_by(|left, right| {
        (&left.kind, &left.record_type, &left.record_id).cmp(&(
            &right.kind,
            &right.record_type,
            &right.record_id,
        ))
    });
    blockers.dedup_by(|left, right| {
        left.kind == right.kind
            && left.record_type == right.record_type
            && left.record_id == right.record_id
    });

    let mut affected = targets
        .iter()
        .map(|(record_type, record_id)| {
            let record = by_key[&(record_type.clone(), record_id.clone())];
            TrashImpactItem {
                kind: if requested.iter().any(|target| {
                    &target.record_type == record_type && &target.record_id == record_id
                }) {
                    "target".to_string()
                } else {
                    "dependent-record".to_string()
                },
                record_type: record_type.clone(),
                record_id: record_id.clone(),
                label: record_label(record),
            }
        })
        .collect::<Vec<_>>();
    affected.sort_by(|left, right| {
        (&left.record_type, &left.record_id).cmp(&(&right.record_type, &right.record_id))
    });

    let retained_asset_bytes = targets
        .iter()
        .filter_map(|key| by_key[key].get("assetDigest").and_then(Value::as_str))
        .collect::<HashSet<_>>()
        .into_iter()
        .filter_map(|digest| {
            project
                .manifest
                .assets
                .iter()
                .find(|asset| asset.digest == digest)
                .map(|asset| asset.byte_length)
        })
        .sum();

    Ok(TrashImpact {
        targets: targets
            .into_iter()
            .map(|(record_type, record_id)| TrashTarget {
                record_type,
                record_id,
            })
            .collect(),
        affected,
        blocked: !blockers.is_empty(),
        blockers,
        retained_asset_bytes,
    })
}

pub fn delete(
    mut project: CanonicalProject,
    requested: &[TrashTarget],
    retention_days: u64,
    now: DateTime<Utc>,
) -> Result<TrashMutation, String> {
    if !(1..=3650).contains(&retention_days) {
        return Err("trash-retention-invalid".to_string());
    }
    let impact = review(&project, requested)?;
    if impact.blocked {
        return Err("trash-dependencies-blocked".to_string());
    }
    let transaction_id = random_opaque("trash-transaction")?;
    let deleted_at = now.to_rfc3339();
    let eligible_after = (now + Duration::days(retention_days as i64)).to_rfc3339();
    let mut changed_documents = Vec::new();
    let original_metadata = impact
        .targets
        .iter()
        .map(|target| {
            let entry = record_entry_name(&target.record_type, &target.record_id)?;
            let original = project
                .records
                .get(&entry)
                .ok_or_else(|| "trash-target-not-found".to_string())?;
            let (list, index) =
                order_position(&project.manifest, &target.record_type, &target.record_id)?;
            Ok((
                (target.record_type.clone(), target.record_id.clone()),
                (list, index, dependency_snapshot(&project, original)?),
            ))
        })
        .collect::<Result<HashMap<_, _>, String>>()?;
    let deleted_active_index = project.manifest.active_page_id.as_ref().and_then(|active| {
        impact
            .targets
            .iter()
            .any(|target| target.record_type == "page" && target.record_id == *active)
            .then(|| {
                project
                    .manifest
                    .record_order
                    .pages
                    .iter()
                    .position(|id| id == active)
            })
            .flatten()
    });

    for target in &impact.targets {
        let entry = record_entry_name(&target.record_type, &target.record_id)?;
        let original = project
            .records
            .remove(&entry)
            .ok_or_else(|| "trash-target-not-found".to_string())?;
        remove_from_order(
            &mut project.manifest,
            &target.record_type,
            &target.record_id,
        )?;
        let (list, index, dependency_snapshot) = original_metadata
            .get(&(target.record_type.clone(), target.record_id.clone()))
            .cloned()
            .ok_or_else(|| "trash-record-order-missing".to_string())?;
        let trash_id = random_opaque("trash-record")?;
        let wrapper = json!({
            "recordType": "trash",
            "recordVersion": 1,
            "id": trash_id,
            "transactionId": transaction_id,
            "deletedAt": deleted_at,
            "eligibleAfter": eligible_after,
            "originalRecordType": target.record_type,
            "originalRecordId": target.record_id,
            "originalOrder": { "list": list, "index": index },
            "dependencySnapshot": dependency_snapshot,
            "originalRecord": original
        });
        let wrapper_id = wrapper["id"].as_str().expect("trash id").to_string();
        project.manifest.record_order.trash.push(wrapper_id.clone());
        project
            .records
            .insert(record_entry_name("trash", &wrapper_id)?, wrapper.clone());
        changed_documents.push(wrapper);
    }
    if let Some(index) = deleted_active_index {
        project.manifest.active_page_id = project
            .manifest
            .record_order
            .pages
            .get(index.min(project.manifest.record_order.pages.len().saturating_sub(1)))
            .cloned();
    }
    project.manifest.updated_at = now.to_rfc3339();
    let manifest_value = serde_json::to_value(&project.manifest)
        .map_err(|error| format!("manifest-invalid: {error}"))?;
    changed_documents.push(manifest_value);
    project.validate()?;
    Ok(TrashMutation {
        transaction_id: Some(transaction_id),
        changed_documents,
        project,
    })
}

pub fn restore(
    mut project: CanonicalProject,
    transaction_id: &str,
    now: DateTime<Utc>,
) -> Result<TrashMutation, String> {
    let wrappers = transaction_wrappers(&project, transaction_id)?;
    if wrappers.is_empty() {
        return Err("trash-transaction-not-found".to_string());
    }
    let mut changed_documents = Vec::new();
    let mut restore_values = Vec::new();
    for wrapper in &wrappers {
        let original_type = required_string(wrapper, "originalRecordType")?;
        let original_id = required_string(wrapper, "originalRecordId")?;
        let entry = record_entry_name(original_type, original_id)?;
        if project.records.contains_key(&entry) {
            return Err("trash-restore-collision".to_string());
        }
        restore_values.push((
            required_string(wrapper, "id")?.to_string(),
            original_type.to_string(),
            original_id.to_string(),
            wrapper
                .pointer("/originalOrder/list")
                .and_then(Value::as_str)
                .ok_or_else(|| "trash-record-invalid".to_string())?
                .to_string(),
            wrapper
                .pointer("/originalOrder/index")
                .and_then(Value::as_u64)
                .ok_or_else(|| "trash-record-invalid".to_string())? as usize,
            wrapper
                .get("originalRecord")
                .cloned()
                .ok_or_else(|| "trash-record-invalid".to_string())?,
        ));
    }
    restore_values
        .sort_by(|left, right| (&left.3, left.4, &left.2).cmp(&(&right.3, right.4, &right.2)));
    for (trash_id, original_type, original_id, list, index, original) in restore_values {
        project
            .manifest
            .record_order
            .trash
            .retain(|id| id != &trash_id);
        project
            .records
            .remove(&record_entry_name("trash", &trash_id)?);
        insert_into_order(&mut project.manifest, &list, &original_id, index)?;
        project.records.insert(
            record_entry_name(&original_type, &original_id)?,
            original.clone(),
        );
        changed_documents.push(original);
    }
    project.manifest.updated_at = now.to_rfc3339();
    let manifest_value = serde_json::to_value(&project.manifest)
        .map_err(|error| format!("manifest-invalid: {error}"))?;
    changed_documents.push(manifest_value);
    project.validate()?;
    Ok(TrashMutation {
        transaction_id: Some(transaction_id.to_string()),
        changed_documents,
        project,
    })
}

pub fn empty(
    mut project: CanonicalProject,
    transaction_ids: Option<&[String]>,
    eligible_only: bool,
    now: DateTime<Utc>,
) -> Result<TrashMutation, String> {
    let requested = transaction_ids.map(|ids| ids.iter().cloned().collect::<HashSet<_>>());
    let mut removed = Vec::new();
    for trash_id in project.manifest.record_order.trash.clone() {
        let entry = record_entry_name("trash", &trash_id)?;
        let Some(wrapper) = project.records.get(&entry) else {
            return Err("trash-record-missing".to_string());
        };
        let transaction_id = required_string(wrapper, "transactionId")?;
        if requested
            .as_ref()
            .is_some_and(|ids| !ids.contains(transaction_id))
        {
            continue;
        }
        let eligible_after = parse_timestamp(required_string(wrapper, "eligibleAfter")?)?;
        if eligible_only && eligible_after > now {
            continue;
        }
        removed.push(trash_id);
    }
    if removed.is_empty() {
        return Err("trash-cleanup-empty".to_string());
    }
    let removed_set = removed.iter().collect::<HashSet<_>>();
    project
        .manifest
        .record_order
        .trash
        .retain(|id| !removed_set.contains(id));
    for id in removed {
        project.records.remove(&record_entry_name("trash", &id)?);
    }

    let retained_digests = referenced_asset_digests(&project.records);
    project
        .manifest
        .assets
        .retain(|asset| retained_digests.contains(asset.digest.as_str()));
    project.manifest.derived_previews.retain(|preview| {
        retained_digests.contains(preview.source_digest.as_str())
            && retained_digests.contains(preview.preview_digest.as_str())
    });
    project.manifest.updated_at = now.to_rfc3339();
    let manifest_value = serde_json::to_value(&project.manifest)
        .map_err(|error| format!("manifest-invalid: {error}"))?;
    project.validate()?;
    Ok(TrashMutation {
        transaction_id: None,
        changed_documents: vec![manifest_value],
        project,
    })
}

pub fn state(project: &CanonicalProject, now: DateTime<Utc>) -> Result<TrashState, String> {
    let mut grouped: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
    for id in &project.manifest.record_order.trash {
        let wrapper = project
            .records
            .get(&record_entry_name("trash", id)?)
            .ok_or_else(|| "trash-record-missing".to_string())?;
        grouped
            .entry(required_string(wrapper, "transactionId")?.to_string())
            .or_default()
            .push(wrapper);
    }
    let mut transactions = Vec::new();
    let mut retained_digests = HashSet::new();
    for (transaction_id, wrappers) in grouped {
        let deleted_at = required_string(wrappers[0], "deletedAt")?.to_string();
        let eligible_after = required_string(wrappers[0], "eligibleAfter")?.to_string();
        let eligible = parse_timestamp(&eligible_after)? <= now;
        let mut records = Vec::new();
        for wrapper in wrappers {
            let original = wrapper
                .get("originalRecord")
                .ok_or_else(|| "trash-record-invalid".to_string())?;
            if let Some(digest) = original.get("assetDigest").and_then(Value::as_str) {
                retained_digests.insert(digest.to_string());
            }
            records.push(TrashRecordSummary {
                trash_id: required_string(wrapper, "id")?.to_string(),
                original_record_type: required_string(wrapper, "originalRecordType")?.to_string(),
                original_record_id: required_string(wrapper, "originalRecordId")?.to_string(),
                title: record_label(original),
            });
        }
        records.sort_by(|left, right| {
            (&left.original_record_type, &left.original_record_id)
                .cmp(&(&right.original_record_type, &right.original_record_id))
        });
        transactions.push(TrashTransactionSummary {
            transaction_id,
            deleted_at,
            eligible_after,
            eligible,
            records,
        });
    }
    transactions.sort_by(|left, right| right.deleted_at.cmp(&left.deleted_at));
    Ok(TrashState {
        total_records: transactions
            .iter()
            .map(|transaction| transaction.records.len())
            .sum(),
        eligible_transactions: transactions
            .iter()
            .filter(|transaction| transaction.eligible)
            .count(),
        retained_asset_bytes: project
            .manifest
            .assets
            .iter()
            .filter(|asset| retained_digests.contains(&asset.digest))
            .map(|asset| asset.byte_length)
            .sum(),
        transactions,
    })
}

fn records_by_key(
    records: &BTreeMap<String, Value>,
) -> Result<HashMap<(String, String), &Value>, String> {
    records
        .values()
        .filter(|record| record.get("recordType").and_then(Value::as_str) != Some("trash"))
        .map(|record| {
            Ok((
                (
                    required_string(record, "recordType")?.to_string(),
                    required_string(record, "id")?.to_string(),
                ),
                record,
            ))
        })
        .collect()
}

fn inbound_dependencies(
    records: &HashMap<(String, String), &Value>,
    targets: &BTreeSet<(String, String)>,
    target_type: &str,
    target_id: &str,
) -> Vec<TrashImpactItem> {
    let mut result = Vec::new();
    for ((owner_type, owner_id), record) in records {
        if targets.contains(&(owner_type.clone(), owner_id.clone())) {
            continue;
        }
        let kind = match target_type {
            "evidence" if owner_type == "page" => {
                let placement = record
                    .get("placements")
                    .and_then(Value::as_array)
                    .is_some_and(|values| {
                        values.iter().any(|value| {
                            value.get("evidenceId").and_then(Value::as_str) == Some(target_id)
                        })
                    });
                let timed = record
                    .get("annotations")
                    .and_then(Value::as_array)
                    .is_some_and(|values| {
                        values.iter().any(|value| {
                            value.pointer("/scope/evidenceId").and_then(Value::as_str)
                                == Some(target_id)
                        })
                    });
                if timed {
                    Some("timed-annotation")
                } else if placement
                    || record.get("primaryEvidenceId").and_then(Value::as_str) == Some(target_id)
                {
                    Some("placement")
                } else {
                    None
                }
            }
            "evidence"
                if owner_type == "evidence"
                    && record.get("sourceVideoId").and_then(Value::as_str) == Some(target_id) =>
            {
                Some("source-dependent")
            }
            "evidence"
                if owner_type == "finding"
                    && record
                        .get("evidenceReferences")
                        .and_then(Value::as_array)
                        .is_some_and(|values| {
                            values.iter().any(|value| {
                                value.get("evidenceId").and_then(Value::as_str) == Some(target_id)
                            })
                        }) =>
            {
                Some("finding-reference")
            }
            "evidence"
                if owner_type == "collection" && contains_id(record, "evidenceIds", target_id) =>
            {
                Some("collection-reference")
            }
            "evidence"
                if owner_type == "session" && contains_id(record, "evidenceIds", target_id) =>
            {
                Some("session-reference")
            }
            "page"
                if owner_type == "finding"
                    && record
                        .get("evidenceReferences")
                        .and_then(Value::as_array)
                        .is_some_and(|values| {
                            values.iter().any(|value| {
                                value.get("pageId").and_then(Value::as_str) == Some(target_id)
                            })
                        }) =>
            {
                Some("finding-reference")
            }
            "tag" if owner_type == "evidence" && contains_id(record, "tagIds", target_id) => {
                Some("evidence-tag")
            }
            "tag" if owner_type == "finding" && contains_id(record, "tagIds", target_id) => {
                Some("finding-tag")
            }
            "session"
                if owner_type == "evidence"
                    && record.get("sessionId").and_then(Value::as_str) == Some(target_id) =>
            {
                Some("session-evidence")
            }
            "timeline"
                if owner_type == "evidence"
                    && record.pointer("/video/timelineId").and_then(Value::as_str)
                        == Some(target_id) =>
            {
                Some("video-timeline")
            }
            _ => None,
        };
        if let Some(kind) = kind {
            result.push(TrashImpactItem {
                kind: kind.to_string(),
                record_type: owner_type.clone(),
                record_id: owner_id.clone(),
                label: record_label(record),
            });
        }
    }
    result
}

fn dependency_snapshot(project: &CanonicalProject, record: &Value) -> Result<Value, String> {
    let target_type = required_string(record, "recordType")?;
    let target_id = required_string(record, "id")?;
    let by_key = records_by_key(&project.records)?;
    let target_set = BTreeSet::new();
    let inbound = inbound_dependencies(&by_key, &target_set, target_type, target_id)
        .into_iter()
        .filter_map(|item| record_reference(&item.record_type, &item.record_id))
        .collect::<Vec<_>>();
    let outbound = outbound_references(record);
    let asset_digests = record
        .get("assetDigest")
        .and_then(Value::as_str)
        .map(|digest| vec![digest.to_string()])
        .unwrap_or_default();
    Ok(json!({
        "inbound": deduplicate_references(inbound),
        "outbound": deduplicate_references(outbound),
        "assetDigests": asset_digests
    }))
}

fn outbound_references(record: &Value) -> Vec<Value> {
    let mut references = Vec::new();
    let record_type = record
        .get("recordType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if record_type == "evidence" {
        if let Some(id) = record.get("sessionId").and_then(Value::as_str) {
            references.push(json!({ "recordType": "session", "recordId": id }));
        }
        for id in ids(record, "tagIds") {
            references.push(json!({ "recordType": "tag", "recordId": id }));
        }
        if let Some(id) = record.get("sourceVideoId").and_then(Value::as_str) {
            references.push(json!({ "recordType": "evidence", "recordId": id }));
        }
    } else if record_type == "page" {
        if let Some(id) = record.get("primaryEvidenceId").and_then(Value::as_str) {
            references.push(json!({ "recordType": "evidence", "recordId": id }));
        }
        for placement in record
            .get("placements")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = placement.get("evidenceId").and_then(Value::as_str) {
                references.push(json!({ "recordType": "evidence", "recordId": id }));
            }
        }
    } else if record_type == "finding" {
        for reference in record
            .get("evidenceReferences")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(id) = reference.get("evidenceId").and_then(Value::as_str) {
                references.push(json!({ "recordType": "evidence", "recordId": id }));
            }
            if let Some(id) = reference.get("pageId").and_then(Value::as_str) {
                references.push(json!({ "recordType": "page", "recordId": id }));
            }
        }
        for id in ids(record, "tagIds") {
            references.push(json!({ "recordType": "tag", "recordId": id }));
        }
    } else if record_type == "collection" || record_type == "session" {
        for id in ids(record, "evidenceIds") {
            references.push(json!({ "recordType": "evidence", "recordId": id }));
        }
    } else if record_type == "relationship" {
        for field in ["source", "target"] {
            if let Some(reference) = record.get(field) {
                references.push(reference.clone());
            }
        }
    } else if record_type == "timeline" {
        if let Some(id) = record.get("evidenceId").and_then(Value::as_str) {
            references.push(json!({ "recordType": "evidence", "recordId": id }));
        }
    }
    references
}

fn record_reference(record_type: &str, record_id: &str) -> Option<Value> {
    matches!(
        record_type,
        "evidence" | "page" | "finding" | "tag" | "collection" | "session"
    )
    .then(|| json!({ "recordType": record_type, "recordId": record_id }))
}

fn deduplicate_references(values: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| {
            let key = (
                value
                    .get("recordType")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                value
                    .get("recordId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            seen.insert(key)
        })
        .collect()
}

fn transaction_wrappers<'a>(
    project: &'a CanonicalProject,
    transaction_id: &str,
) -> Result<Vec<&'a Value>, String> {
    project
        .manifest
        .record_order
        .trash
        .iter()
        .filter_map(|id| project.records.get(&record_entry_name("trash", id).ok()?))
        .filter(|wrapper| {
            wrapper.get("transactionId").and_then(Value::as_str) == Some(transaction_id)
        })
        .map(Ok)
        .collect()
}

fn remove_from_order(
    manifest: &mut Manifest,
    record_type: &str,
    id: &str,
) -> Result<(String, usize), String> {
    let list = list_mut_for_type(manifest, record_type)?;
    let index = list
        .iter()
        .position(|candidate| candidate == id)
        .ok_or_else(|| "trash-record-order-missing".to_string())?;
    list.remove(index);
    Ok((list_name(record_type)?.to_string(), index))
}

fn order_position(
    manifest: &Manifest,
    record_type: &str,
    id: &str,
) -> Result<(String, usize), String> {
    let (list_name, list) = manifest
        .record_order
        .lists()
        .into_iter()
        .find(|(_, candidate_type, _)| *candidate_type == record_type)
        .map(|(name, _, ids)| (name, ids))
        .ok_or_else(|| "trash-record-type-invalid".to_string())?;
    let index = list
        .iter()
        .position(|candidate| candidate == id)
        .ok_or_else(|| "trash-record-order-missing".to_string())?;
    Ok((list_name.to_string(), index))
}

fn insert_into_order(
    manifest: &mut Manifest,
    list: &str,
    id: &str,
    index: usize,
) -> Result<(), String> {
    let values = list_mut(manifest, list)?;
    values.insert(index.min(values.len()), id.to_string());
    Ok(())
}

fn list_mut_for_type<'a>(
    manifest: &'a mut Manifest,
    record_type: &str,
) -> Result<&'a mut Vec<String>, String> {
    list_mut(manifest, list_name(record_type)?)
}

fn list_name(record_type: &str) -> Result<&'static str, String> {
    match record_type {
        "page" => Ok("pages"),
        "evidence" => Ok("evidence"),
        "timeline" => Ok("timelines"),
        "finding" => Ok("findings"),
        "tag" => Ok("tags"),
        "collection" => Ok("collections"),
        "relationship" => Ok("relationships"),
        "session" => Ok("sessions"),
        _ => Err("trash-record-type-invalid".to_string()),
    }
}

fn list_mut<'a>(manifest: &'a mut Manifest, list: &str) -> Result<&'a mut Vec<String>, String> {
    match list {
        "pages" => Ok(&mut manifest.record_order.pages),
        "evidence" => Ok(&mut manifest.record_order.evidence),
        "timelines" => Ok(&mut manifest.record_order.timelines),
        "findings" => Ok(&mut manifest.record_order.findings),
        "tags" => Ok(&mut manifest.record_order.tags),
        "collections" => Ok(&mut manifest.record_order.collections),
        "relationships" => Ok(&mut manifest.record_order.relationships),
        "sessions" => Ok(&mut manifest.record_order.sessions),
        _ => Err("trash-record-order-invalid".to_string()),
    }
}

fn referenced_asset_digests(records: &BTreeMap<String, Value>) -> HashSet<&str> {
    let mut result = HashSet::new();
    for record in records.values() {
        if let Some(digest) = record.get("assetDigest").and_then(Value::as_str) {
            result.insert(digest);
        }
        if let Some(digest) = record
            .pointer("/originalRecord/assetDigest")
            .and_then(Value::as_str)
        {
            result.insert(digest);
        }
        for digest in record
            .pointer("/dependencySnapshot/assetDigests")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            result.insert(digest);
        }
    }
    result
}

fn validate_target(target: &TrashTarget) -> Result<(), String> {
    list_name(&target.record_type)?;
    if target.record_id.len() < 3 || target.record_id.len() > 96 {
        return Err("trash-record-id-invalid".to_string());
    }
    Ok(())
}

fn record_label(record: &Value) -> String {
    record
        .get("title")
        .or_else(|| record.get("label"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let kind = record
                .get("recordType")
                .and_then(Value::as_str)
                .unwrap_or("record");
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("{kind} {id}")
        })
}

fn contains_id(record: &Value, field: &str, target: &str) -> bool {
    ids(record, field).any(|id| id == target)
}

fn ids<'a>(record: &'a Value, field: &str) -> impl Iterator<Item = &'a str> {
    record
        .get(field)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

fn required_string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| "trash-record-invalid".to_string())
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| "trash-timestamp-invalid".to_string())
}

fn random_opaque(prefix: &str) -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("random-id-failed: {error}"))?;
    Ok(format!(
        "{prefix}-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_v2::model::{AssetRecord, RecordOrder};

    #[test]
    fn deletes_and_restores_a_closed_page_evidence_transaction_in_order() {
        let project = fixture_project();
        let impact = review(
            &project,
            &[
                target("page", "page-two"),
                target("evidence", "evidence-two"),
            ],
        )
        .unwrap();
        assert!(!impact.blocked);
        assert_eq!(impact.affected.len(), 2);
        let deleted = delete(project, &impact.targets, 30, fixture_now()).unwrap();
        let transaction = deleted.transaction_id.clone().unwrap();
        assert_eq!(deleted.project.manifest.record_order.pages, ["page-one"]);
        assert_eq!(deleted.project.manifest.record_order.trash.len(), 2);
        assert_eq!(deleted.project.manifest.assets.len(), 2);

        let restored = restore(deleted.project, &transaction, fixture_now()).unwrap();
        assert_eq!(
            restored.project.manifest.record_order.pages,
            ["page-one", "page-two"]
        );
        assert_eq!(
            restored.project.manifest.record_order.evidence,
            ["evidence-one", "evidence-two"]
        );
        assert!(restored.project.manifest.record_order.trash.is_empty());
        restored.project.validate().unwrap();
    }

    #[test]
    fn snapshots_batch_order_before_mutation_and_updates_the_active_page() {
        let mut project = fixture_project();
        project.manifest.active_page_id = Some("page-one".to_string());
        let targets = [
            target("page", "page-one"),
            target("evidence", "evidence-one"),
        ];
        let deleted = delete(project, &targets, 30, fixture_now()).unwrap();
        assert_eq!(
            deleted.project.manifest.active_page_id.as_deref(),
            Some("page-two")
        );

        let project = fixture_project();
        let all_targets = [
            target("page", "page-one"),
            target("evidence", "evidence-one"),
            target("page", "page-two"),
            target("evidence", "evidence-two"),
        ];
        let deleted = delete(project, &all_targets, 30, fixture_now()).unwrap();
        assert_eq!(deleted.project.manifest.active_page_id, None);
        let evidence_wrapper = deleted
            .project
            .records
            .values()
            .find(|record| {
                record.get("originalRecordId").and_then(Value::as_str) == Some("evidence-one")
            })
            .unwrap();
        assert!(evidence_wrapper["dependencySnapshot"]["inbound"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reference| reference["recordId"] == "page-one"));
        let transaction_id = deleted.transaction_id.unwrap();
        let restored_project = restore(deleted.project, &transaction_id, fixture_now())
            .unwrap()
            .project;
        assert_eq!(
            restored_project.manifest.record_order.pages,
            ["page-one", "page-two"]
        );
        assert_eq!(
            restored_project.manifest.record_order.evidence,
            ["evidence-one", "evidence-two"]
        );
    }

    #[test]
    fn blocks_sources_and_research_references_without_partial_mutation() {
        let mut project = fixture_project();
        let finding = json!({
            "recordType": "finding", "recordVersion": 1, "id": "finding-one",
            "createdAt": fixture_now().to_rfc3339(), "updatedAt": fixture_now().to_rfc3339(),
            "observation": "Observed", "interpretation": "", "hypothesis": "", "followUp": "",
            "status": "open", "confidence": null,
            "evidenceReferences": [{ "evidenceId": "evidence-two", "pageId": "page-two", "annotationId": null }],
            "tagIds": [], "revision": 1
        });
        project
            .manifest
            .record_order
            .findings
            .push("finding-one".to_string());
        project.records.insert(
            record_entry_name("finding", "finding-one").unwrap(),
            finding,
        );
        let before = serde_json::to_value(&project.manifest).unwrap();
        let impact = review(&project, &[target("evidence", "evidence-two")]).unwrap();
        assert!(impact.blocked);
        assert!(impact.blockers.iter().any(|item| item.kind == "placement"));
        assert!(impact
            .blockers
            .iter()
            .any(|item| item.kind == "finding-reference"));
        assert_eq!(
            delete(
                project,
                &[target("evidence", "evidence-two")],
                30,
                fixture_now()
            )
            .unwrap_err(),
            "trash-dependencies-blocked"
        );
        assert_eq!(
            before["recordOrder"]["evidence"],
            json!(["evidence-one", "evidence-two"])
        );
    }

    #[test]
    fn retention_only_enables_explicit_cleanup_and_assets_remain_until_empty() {
        let deleted = delete(
            fixture_project(),
            &[
                target("page", "page-two"),
                target("evidence", "evidence-two"),
            ],
            30,
            fixture_now(),
        )
        .unwrap();
        let before = state(&deleted.project, fixture_now() + Duration::days(29)).unwrap();
        assert_eq!(before.eligible_transactions, 0);
        assert_eq!(deleted.project.manifest.assets.len(), 2);
        assert_eq!(
            empty(
                deleted.project,
                None,
                true,
                fixture_now() + Duration::days(29)
            )
            .unwrap_err(),
            "trash-cleanup-empty"
        );

        let deleted = delete(
            fixture_project(),
            &[
                target("page", "page-two"),
                target("evidence", "evidence-two"),
            ],
            30,
            fixture_now(),
        )
        .unwrap();
        let emptied = empty(
            deleted.project,
            None,
            true,
            fixture_now() + Duration::days(31),
        )
        .unwrap();
        assert!(emptied.project.manifest.record_order.trash.is_empty());
        assert_eq!(emptied.project.manifest.assets.len(), 1);
        emptied.project.validate().unwrap();
    }

    fn fixture_project() -> CanonicalProject {
        let now = fixture_now().to_rfc3339();
        let digest_one = "1".repeat(64);
        let digest_two = "2".repeat(64);
        let manifest = Manifest {
            format_version: 2,
            minimum_reader_version: 2,
            project_id: "project-fixture".to_string(),
            title: "Fixture".to_string(),
            created_at: now.clone(),
            updated_at: now.clone(),
            active_page_id: Some("page-one".to_string()),
            record_order: RecordOrder {
                pages: vec!["page-one".to_string(), "page-two".to_string()],
                evidence: vec!["evidence-one".to_string(), "evidence-two".to_string()],
                timelines: vec![],
                findings: vec![],
                tags: vec![],
                collections: vec![],
                relationships: vec![],
                sessions: vec![],
                trash: vec![],
            },
            assets: vec![asset(&digest_one), asset(&digest_two)],
            derived_previews: vec![],
        };
        let mut records = BTreeMap::new();
        for (suffix, digest) in [("one", digest_one), ("two", digest_two)] {
            let evidence_id = format!("evidence-{suffix}");
            let page_id = format!("page-{suffix}");
            records.insert(record_entry_name("evidence", &evidence_id).unwrap(), json!({
                "recordType": "evidence", "recordVersion": 1, "id": evidence_id,
                "title": format!("Screenshot {suffix}"), "createdAt": now, "updatedAt": now,
                "kind": "screenshot", "sessionId": null, "tagIds": [],
                "provenance": { "origin": "capture", "parentEvidenceIds": [], "importedAt": null, "originalFilename": null },
                "assetDigest": digest,
                "image": { "width": 1600, "height": 900, "colorSpace": "srgb", "monitorLabel": null }
            }));
            records.insert(record_entry_name("page", &page_id).unwrap(), json!({
                "recordType": "page", "recordVersion": 1, "id": page_id,
                "title": suffix, "createdAt": now, "updatedAt": now,
                "primaryEvidenceId": evidence_id, "backgroundColor": "#ffffff",
                "placements": [{ "type": "MediaPlacement", "placementVersion": 1, "id": format!("placement-{suffix}"), "evidenceId": evidence_id, "left": 0, "top": 0, "scaleX": 1, "scaleY": 1, "angle": 0, "zIndex": 0 }],
                "annotations": [], "annotationOrder": [], "connectors": [], "notes": ""
            }));
        }
        let project = CanonicalProject { manifest, records };
        project.validate().unwrap();
        project
    }

    fn asset(digest: &str) -> AssetRecord {
        AssetRecord {
            digest: digest.to_string(),
            byte_length: 10,
            media_class: "image".to_string(),
            mime_type: "image/png".to_string(),
            extension: "png".to_string(),
            storage_method: "stored".to_string(),
        }
    }

    fn target(record_type: &str, record_id: &str) -> TrashTarget {
        TrashTarget {
            record_type: record_type.to_string(),
            record_id: record_id.to_string(),
        }
    }

    fn fixture_now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-08-03T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }
}
