# ---- Desktop releases (ADR 0014, M14) -------------------------------------------
# The private `releases` bucket is module.storage's (uniform access, public access prevention
# enforced, versioned). Downloads and the updater manifest are served only as short-lived V4
# signed URLs (api GET /releases/{channel}/latest.json), signed as this dedicated account
# through IAM Credentials signBlob: no service-account key file exists anywhere.
#
# Code only: applying it is an owner OPS step (docs/OPS.md, "M14: downloadable apps").
resource "google_service_account" "release_signer" {
  project      = var.project_id
  account_id   = "chalito-release-signer"
  display_name = "chalito-release-signer"
  description  = "Signs short-lived download URLs for the private releases bucket (read-only, no keys)"

  depends_on = [module.project_services]
}

# The signer can read release objects; nothing else, nowhere else.
resource "google_storage_bucket_iam_member" "release_signer_read" {
  bucket = module.storage.bucket_names["releases"]
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.release_signer.email}"
}

# The api (Chalyb's engine module account) signs as the signer. It holds no bucket role itself.
resource "google_service_account_iam_member" "api_signs_as_release_signer" {
  for_each = toset(local.api_list)

  service_account_id = google_service_account.release_signer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${each.value}"
}

output "release_signer_email" {
  description = "CHALITO_RELEASES_SIGNER for the api"
  value       = google_service_account.release_signer.email
}

output "releases_bucket" {
  description = "CHALITO_RELEASES_BUCKET for the api"
  value       = module.storage.bucket_names["releases"]
}
