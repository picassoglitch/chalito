# Named Firestore database for Chalito inside Chalyb's project (ADR 0015/0016).
# The location is permanent (decision #30): us-central1.
variable "project_id" {
  type = string
}

variable "location" {
  type = string
}

variable "database_id" {
  type    = string
  default = "chalito"
}

resource "google_firestore_database" "this" {
  project                           = var.project_id
  name                              = var.database_id
  location_id                       = var.location
  type                              = "FIRESTORE_NATIVE"
  concurrency_mode                  = "OPTIMISTIC"
  delete_protection_state           = "DELETE_PROTECTION_ENABLED"
  deletion_policy                   = "ABANDON"
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"
}

# TTL policies (brief §6). Deletion is lazy (typically < 24 h), so clients also filter on the field.
locals {
  ttl = {
    events       = "expireAt"
    callLines    = "expireAt"
    roomEvents   = "expireAt"
    roomInvites  = "expiresAt"
    pairingCodes = "expireAt"
    ssoTokens    = "expireAt"
    deviceNonces = "expireAt"
  }
}

resource "google_firestore_field" "ttl" {
  for_each = local.ttl

  project    = var.project_id
  database   = google_firestore_database.this.name
  collection = each.key
  field      = each.value

  ttl_config {}

  # Keep the default single-field indexes off for TTL timestamps (write hot-spotting).
  index_config {}
}

resource "google_firestore_index" "devices_role_revoked" {
  project    = var.project_id
  database   = google_firestore_database.this.name
  collection = "devices"

  fields {
    field_path = "role"
    order      = "ASCENDING"
  }

  fields {
    field_path = "revoked"
    order      = "ASCENDING"
  }
}

output "database_id" {
  value = google_firestore_database.this.name
}
