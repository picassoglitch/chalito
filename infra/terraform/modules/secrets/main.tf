# Secret containers only: values are added out of band (brief §9). Access is granted per secret.
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
