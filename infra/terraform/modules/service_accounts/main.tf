# One service account per Chalito service (least privilege, brief §8).
# The `api` service account is created by Chalyb's engine module (ADR 0016), not here.
variable "project_id" {
  type = string
}

variable "accounts" {
  description = "account_id => description"
  type        = map(string)
}

resource "google_service_account" "this" {
  for_each = var.accounts

  project      = var.project_id
  account_id   = each.key
  display_name = each.key
  description  = each.value
}

output "emails" {
  value = { for k, sa in google_service_account.this : k => sa.email }
}
