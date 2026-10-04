# A Chalito Cloud Run service: scale to zero, request-based billing, binds $PORT.
# The image is deployed by CI/gcloud; Terraform owns the service shape, not the revision.
variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "name" {
  type = string
}

variable "service_account" {
  type = string
}

variable "public" {
  description = "Allow unauthenticated invocations (only mcp-gateway; documented in ADR 0009)."
  type        = bool
  default     = false
}

variable "invokers" {
  description = "Members allowed to invoke a private service (e.g. the Pub/Sub push SA)."
  type        = list(string)
  default     = []
}

variable "env" {
  type    = map(string)
  default = {}
}

variable "secret_env" {
  description = "ENV_NAME => secret id"
  type        = map(string)
  default     = {}
}

variable "labels" {
  type    = map(string)
  default = {}
}

resource "google_cloud_run_v2_service" "this" {
  project             = var.project_id
  name                = var.name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true
  labels              = var.labels

  template {
    service_account = var.service_account

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello"

      resources {
        cpu_idle = true
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  count = var.public ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.this.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service_iam_member" "invokers" {
  for_each = toset(var.invokers)

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.this.name
  role     = "roles/run.invoker"
  member   = each.value
}

output "uri" {
  value = google_cloud_run_v2_service.this.uri
}
