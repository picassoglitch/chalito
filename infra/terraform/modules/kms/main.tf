# Keyring for CMEK on the records bucket and envelope encryption of cloud-side BYO keys.
variable "project_id" {
  type = string
}

variable "location" {
  type = string
}

resource "google_kms_key_ring" "this" {
  project  = var.project_id
  name     = "chalito"
  location = var.location
}

resource "google_kms_crypto_key" "records" {
  name            = "records"
  key_ring        = google_kms_key_ring.this.id
  rotation_period = "7776000s"
  purpose         = "ENCRYPT_DECRYPT"
  labels          = { app = "chalito" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key" "byo" {
  name            = "byo-envelope"
  key_ring        = google_kms_key_ring.this.id
  rotation_period = "7776000s"
  purpose         = "ENCRYPT_DECRYPT"
  labels          = { app = "chalito" }

  lifecycle {
    prevent_destroy = true
  }
}

output "records_key_id" {
  value = google_kms_crypto_key.records.id
}

output "byo_key_id" {
  value = google_kms_crypto_key.byo.id
}
