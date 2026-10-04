# Secret containers, each with a placeholder version: values are added out of band as a new version
# (brief §9, GO_LIVE 3.5). Cloud Run refuses a revision whose secret has no version, so without the
# placeholder the first apply couldn't create the services. Access is granted per secret.
variable "project_id" {
  type = string
}

variable "secrets" {
  description = "secret id => list of service account emails allowed to read it"
  type        = map(list(string))
}

variable "labels" {
  type    = map(string)
  default = {}
}

resource "google_secret_manager_secret" "this" {
  for_each = var.secrets

  project   = var.project_id
  secret_id = each.key
  labels    = var.labels

  replication {
    auto {}
  }
}

# Version 1 only: the real value is added with `gcloud secrets versions add`, "latest" moves on, and
# the next deploy picks it up. Terraform never sees or overwrites the real value.
resource "google_secret_manager_secret_version" "placeholder" {
  for_each = google_secret_manager_secret.this

  secret      = each.value.id
  secret_data = "REPLACE_ME"
}

locals {
  bindings = merge([
    for id, members in var.secrets : { for m in members : "${id}/${m}" => { id = id, member = m } }
  ]...)
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each = local.bindings

  project   = var.project_id
  secret_id = google_secret_manager_secret.this[each.value.id].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.member}"
}

output "secret_ids" {
  value = keys(var.secrets)
}
