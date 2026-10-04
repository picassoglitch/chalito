# Topics with dead-letter topics (brief §6). One `room-events` topic with attributes, not one per room.
variable "project_id" {
  type = string
}

variable "topics" {
  type = list(string)
}

variable "labels" {
  type    = map(string)
  default = {}
}

resource "google_pubsub_topic" "this" {
  for_each = toset(var.topics)

  #checkov:skip=CKV_GCP_83:Payloads are metadata or already E2E-sealed; Google-managed encryption for beta.
  project                    = var.project_id
  name                       = each.value
  labels                     = var.labels
  message_retention_duration = "86400s"
}

resource "google_pubsub_topic" "dlq" {
  for_each = toset(var.topics)

  #checkov:skip=CKV_GCP_83:Dead letters carry the same metadata-only payloads.
  project                    = var.project_id
  name                       = "${each.value}-dlq"
  labels                     = var.labels
  message_retention_duration = "604800s"
}

output "topic_ids" {
  value = { for k, t in google_pubsub_topic.this : k => t.id }
}

output "dlq_ids" {
  value = { for k, t in google_pubsub_topic.dlq : k => t.id }
}
