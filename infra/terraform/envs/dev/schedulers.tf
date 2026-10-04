# Cloud Scheduler jobs for the notifier's tasks (code only; `terraform apply` with the owner's go).
# Each signs a Google OIDC token as the push service account, which the notifier checks
# (SCHEDULER_SA_EMAIL) against the endpoint's audience. They need the notifier's public URL, so
# they're created once `notifier_public_url` is set (docs/GO_LIVE.md 4.6).

locals {
  notifier_jobs = var.notifier_public_url == "" ? {} : {
    # The notify outbox's fallback (migration 20261004003050): whatever a pg_net poke missed.
    "chalito-drain-notify" = { path = "/tasks/drain-notify", schedule = "* * * * *" }
    # The usage outbox to the Chalyb hub (packages/billing), plus stale voice sessions.
    "chalito-drain-usage" = { path = "/tasks/drain-usage", schedule = "* * * * *" }
  }
}

resource "google_cloud_scheduler_job" "notifier" {
  for_each = local.notifier_jobs

  project          = var.project_id
  region           = var.region
  name             = each.key
  schedule         = each.value.schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "60s"

  retry_config {
    retry_count = 0 # the next minute's run is the retry
  }

  http_target {
    http_method = "POST"
    uri         = "${trimsuffix(var.notifier_public_url, "/")}${each.value.path}"

    oidc_token {
      service_account_email = local.push
      audience              = "${trimsuffix(var.notifier_public_url, "/")}${each.value.path}"
    }
  }

  depends_on = [module.project_services, module.notifier]
}
