# Buckets (brief §8): assets, records (CMEK), releases (private; signed URLs only), showcase.
# No public buckets anywhere.
variable "project_id" {
  type = string
}

variable "location" {
  type = string
}

variable "records_kms_key_id" {
  type = string
}

variable "project_number" {
  type = string
}

variable "labels" {
  type    = map(string)
  default = {}
}

locals {
  buckets = {
    assets   = { versioning = false, cmek = false }
    records  = { versioning = true, cmek = true }
    releases = { versioning = true, cmek = false }
    showcase = { versioning = false, cmek = false }
  }
}

# The Cloud Storage service agent must be able to use the CMEK key.
resource "google_kms_crypto_key_iam_member" "gcs_records" {
  crypto_key_id = var.records_kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${var.project_number}@gs-project-accounts.iam.gserviceaccount.com"
}

resource "google_storage_bucket" "this" {
  for_each = local.buckets

  #checkov:skip=CKV_GCP_62:Access logging goes to Cloud Audit Logs (Data Access) rather than a log bucket.
  project                     = var.project_id
  name                        = "${var.project_id}-chalito-${each.key}"
  location                    = var.location
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = var.labels

  versioning {
    enabled = each.value.versioning
  }

  dynamic "encryption" {
    for_each = each.value.cmek ? [1] : []
    content {
      default_kms_key_name = var.records_kms_key_id
    }
  }

  depends_on = [google_kms_crypto_key_iam_member.gcs_records]
}

output "bucket_names" {
  value = { for k, b in google_storage_bucket.this : k => b.name }
}
