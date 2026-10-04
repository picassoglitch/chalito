# Timers: escalation ladder steps, snoozes, reminders, approval-expiry notices.
variable "project_id" {
  type = string
}

variable "location" {
  type = string
}

variable "queues" {
  type = list(string)
}

resource "google_cloud_tasks_queue" "this" {
  for_each = toset(var.queues)

  project  = var.project_id
  location = var.location
  name     = each.value

  rate_limits {
    max_dispatches_per_second = 50
    max_concurrent_dispatches = 50
  }

  retry_config {
    max_attempts  = 5
    min_backoff   = "2s"
    max_backoff   = "120s"
    max_doublings = 4
  }
}
