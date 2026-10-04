# Enables the APIs Chalito needs in the shared Chalyb project.
# disable_on_destroy = false: Chalyb's own engines depend on several of these, so
# removing Chalito must never switch an API off.
variable "project_id" {
  type = string
}

variable "services" {
  type = list(string)
}

resource "google_project_service" "this" {
  for_each = toset(var.services)

  project                    = var.project_id
  service                    = each.value
  disable_on_destroy         = false
  disable_dependent_services = false
}
