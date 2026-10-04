# Analytics: usage_events (token KPI, comms-overhead ratio) and audit_log, fed by
# Pub/Sub → BigQuery subscriptions. Billing truth is the Chalyb hub (ADR 0016).
variable "project_id" {
  type = string
}

variable "project_number" {
  type = string
}

variable "location" {
  type = string
}

variable "usage_topic_id" {
  type = string
}

variable "audit_topic_id" {
  type = string
}

variable "usage_dlq_id" {
  type = string
}

variable "audit_dlq_id" {
  type = string
}

variable "labels" {
  type    = map(string)
  default = {}
}

resource "google_bigquery_dataset" "this" {
  #checkov:skip=CKV_GCP_81:No content is stored (counts, costs, actions); Google-managed encryption for beta.
  project                    = var.project_id
  dataset_id                 = "chalito"
  location                   = var.location
  labels                     = var.labels
  delete_contents_on_destroy = false
}

locals {
  tables = {
    usage_events = [
      { name = "uid", type = "STRING", mode = "REQUIRED" },
      { name = "tenantId", type = "STRING", mode = "NULLABLE" },
      { name = "t", type = "TIMESTAMP", mode = "REQUIRED" },
      { name = "kind", type = "STRING", mode = "REQUIRED" },
      { name = "provider", type = "STRING", mode = "NULLABLE" },
      { name = "model", type = "STRING", mode = "NULLABLE" },
      { name = "tok_in", type = "INT64", mode = "NULLABLE" },
      { name = "tok_out", type = "INT64", mode = "NULLABLE" },
      { name = "tok_cached", type = "INT64", mode = "NULLABLE" },
      { name = "minutes", type = "FLOAT64", mode = "NULLABLE" },
      { name = "units", type = "INT64", mode = "NULLABLE" },
      { name = "cost_usd_est", type = "FLOAT64", mode = "NULLABLE" },
      { name = "purpose", type = "STRING", mode = "NULLABLE" },
      { name = "billingMode", type = "STRING", mode = "NULLABLE" },
      { name = "tierId", type = "STRING", mode = "NULLABLE" },
      { name = "efficiency", type = "STRING", mode = "NULLABLE" },
    ]
    audit_log = [
      { name = "t", type = "TIMESTAMP", mode = "REQUIRED" },
      { name = "owner", type = "STRING", mode = "NULLABLE" },
      { name = "actor", type = "STRING", mode = "REQUIRED" },
      { name = "action", type = "STRING", mode = "REQUIRED" },
      { name = "target", type = "STRING", mode = "NULLABLE" },
      { name = "meta", type = "JSON", mode = "NULLABLE" },
    ]
  }
}

resource "google_bigquery_table" "this" {
  for_each = local.tables

  #checkov:skip=CKV_GCP_80:No content is stored; Google-managed encryption for beta.
  project             = var.project_id
  dataset_id          = google_bigquery_dataset.this.dataset_id
  table_id            = each.key
  labels              = var.labels
  deletion_protection = true
  schema              = jsonencode(each.value)

  time_partitioning {
    type  = "DAY"
    field = "t"
  }
}

# The Pub/Sub service agent writes into the dataset.
resource "google_bigquery_dataset_iam_member" "pubsub_writer" {
  project    = var.project_id
  dataset_id = google_bigquery_dataset.this.dataset_id
  role       = "roles/bigquery.dataEditor"
  member     = "serviceAccount:service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription" "to_bigquery" {
  for_each = {
    usage_events = { topic = var.usage_topic_id, dlq = var.usage_dlq_id }
    audit_log    = { topic = var.audit_topic_id, dlq = var.audit_dlq_id }
  }

  project = var.project_id
  name    = "${each.key}-to-bigquery"
  topic   = each.value.topic
  labels  = var.labels

  bigquery_config {
    table               = "${var.project_id}.${google_bigquery_dataset.this.dataset_id}.${google_bigquery_table.this[each.key].table_id}"
    use_table_schema    = true
    drop_unknown_fields = true
  }

  dead_letter_policy {
    dead_letter_topic     = each.value.dlq
    max_delivery_attempts = 10
  }

  depends_on = [google_bigquery_dataset_iam_member.pubsub_writer]
}
