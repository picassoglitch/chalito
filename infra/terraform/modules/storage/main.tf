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

variable "upload_cors_origins" {
  description = "Browser origins that PUT photos straight to the assets bucket through signed URLs (custom companions)."
  type        = list(string)
  default     = []
}

locals {
  buckets = {
    assets   = { cmek = false }
    records  = { cmek = true }
    releases = { cmek = false }
    showcase = { cmek = false }
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
    enabled = true
  }

  # Keep old versions for 30 days (undo window), then delete them.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }

  # Custom companion photos (uploads/) are only a reference: the avatar job deletes each one in every
  # outcome. Safety net for a crash: anything left under uploads/ goes after a day, old versions too.
  dynamic "lifecycle_rule" {
    for_each = each.key == "assets" ? [1] : []
    content {
      condition {
        age            = 1
        matches_prefix = ["uploads/"]
      }
      action {
        type = "Delete"
      }
    }
  }
  dynamic "lifecycle_rule" {
    for_each = each.key == "assets" ? [1] : []
    content {
      condition {
        days_since_noncurrent_time = 1
        matches_prefix             = ["uploads/"]
      }
      action {
        type = "Delete"
      }
    }
  }

  # The web app PUTs photos to signed URLs (content type and size range are signed headers).
  dynamic "cors" {
    for_each = each.key == "assets" && length(var.upload_cors_origins) > 0 ? [1] : []
    content {
      origin          = var.upload_cors_origins
      method          = ["PUT", "GET"]
      response_header = ["Content-Type", "x-goog-content-length-range"]
      max_age_seconds = 600
    }
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
