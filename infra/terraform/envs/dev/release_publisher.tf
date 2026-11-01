# Optional, keyless GitHub Actions writer for this bucket only. Apply after review.
variable "enable_release_publishing" {
  type        = bool
  default     = false
  description = "Provision GitHub Actions identity and release-bucket publishing permissions"
}

variable "release_github_repository_id" {
  type        = string
  default     = ""
  description = "Numeric GitHub repository ID for picassoglitch/chalito (gh api repos/picassoglitch/chalito --jq .id)"
  validation {
    condition     = !var.enable_release_publishing || can(regex("^[0-9]+$", var.release_github_repository_id))
    error_message = "Enable publishing only with the numeric GitHub repository ID."
  }
}

resource "google_project_service" "release_identity" {
  for_each           = var.enable_release_publishing ? toset(["iam.googleapis.com", "sts.googleapis.com"]) : toset([])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_service_account" "release_publisher" {
  count        = var.enable_release_publishing ? 1 : 0
  project      = var.project_id
  account_id   = "chalito-release-publisher"
  display_name = "Chalito desktop release publisher"
  depends_on   = [google_project_service.release_identity]
}

resource "google_iam_workload_identity_pool" "releases" {
  count                     = var.enable_release_publishing ? 1 : 0
  project                   = var.project_id
  workload_identity_pool_id = "chalito-releases"
  display_name              = "Chalito release tags"
  depends_on                = [google_project_service.release_identity]
}

resource "google_iam_workload_identity_pool_provider" "releases" {
  count                              = var.enable_release_publishing ? 1 : 0
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.releases[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
  }
  # Numeric ID prevents another repository taking over this name. Only this workflow's tag
  # pushes can impersonate the publisher; PRs and manual dry runs have no cloud access.
  attribute_condition = "assertion.repository == 'picassoglitch/chalito' && assertion.repository_id == '${var.release_github_repository_id}' && assertion.event_name == 'push' && assertion.ref.startsWith('refs/tags/v') && assertion.workflow_ref.startsWith('picassoglitch/chalito/.github/workflows/release.yml@refs/tags/v')"
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "release_publisher_identity" {
  count              = var.enable_release_publishing ? 1 : 0
  service_account_id = google_service_account.release_publisher[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.releases[0].name}/attribute.repository_id/${var.release_github_repository_id}"
}

resource "google_storage_bucket_iam_member" "release_publisher_write" {
  count  = var.enable_release_publishing ? 1 : 0
  bucket = module.storage.bucket_names["releases"]
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.release_publisher[0].email}"
}

output "release_workload_identity_provider" {
  description = "Repository variable RELEASE_WORKLOAD_IDENTITY_PROVIDER"
  value       = try(google_iam_workload_identity_pool_provider.releases[0].name, null)
}

output "release_publisher_service_account" {
  description = "Repository variable RELEASE_SERVICE_ACCOUNT"
  value       = try(google_service_account.release_publisher[0].email, null)
}
