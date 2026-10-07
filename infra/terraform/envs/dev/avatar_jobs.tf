# avatar-jobs (M15): one upload → one Cloud Run job execution (apps/avatar-jobs).
#
#   GCS object finalized in the assets bucket
#     → Eventarc trigger (as chalito-avatar-trig)
#     → Workflow: only uploads/<owner>/<asset>/original passes; it runs the job with UPLOAD_PATH set
#     → Cloud Run job (as chalito-avatar-jobs): validates, re-encodes, writes avatars/<owner>/<asset>/
#
# Custom companions (apps/avatar-jobs src/creation.ts): with GEMINI_API_KEY and DATABASE_URL the job
# claims the creation the api started, draws the five drawings with Gemini, records the outcome and
# the usage event, and deletes the photo (the uploads/ lifecycle rule in modules/storage is the net).
#
# The job's own outputs (avatars/…) also fire the trigger; the Workflow ignores them. Code only:
# `terraform apply` needs the owner's go (docs/OPS.md §3).

locals {
  avatar_job  = "chalito-avatar-jobs"
  avatar_sa   = local.sa["chalito-avatar-jobs"]
  avatar_trig = local.sa["chalito-avatar-trig"]
  gcs_agent   = "service-${var.project_number}@gs-project-accounts.iam.gserviceaccount.com"
}

resource "google_cloud_run_v2_job" "avatar_jobs" {
  project  = var.project_id
  location = var.region
  name     = local.avatar_job
  labels   = local.labels

  template {
    template {
      # Five image calls (each up to 3 attempts) plus the card: minutes, not seconds.
      service_account = local.avatar_sa
      max_retries     = 1
      timeout         = "600s"

      containers {
        # Replaced by the deploy (docker/service.Dockerfile, APP=avatar-jobs ENTRY=src/job.ts).
        image = "us-docker.pkg.dev/cloudrun/container/job"

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }

        env {
          name  = "AVATAR_BUCKET"
          value = module.storage.bucket_names["assets"]
        }

        env {
          name = "GEMINI_API_KEY"
          value_source {
            secret_key_ref {
              secret  = "chalito-gemini-api-key"
              version = "latest"
            }
          }
        }

        # Chalyb's engine module creates this secret once the engine entry exists (api_service_account
        # set); hub_secret_read (main.tf) grants the job access. Without it the job can't take creations.
        dynamic "env" {
          for_each = var.api_service_account == "" ? [] : [1]
          content {
            name = "DATABASE_URL"
            value_source {
              secret_key_ref {
                secret  = "chalito-database-url"
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }

  depends_on = [module.project_services, module.service_accounts, module.secrets, google_secret_manager_secret_iam_member.hub_secret_read]
}

# The job reads (and deletes) uploads and writes cards in the assets bucket, nothing else.
resource "google_storage_bucket_iam_member" "avatar_jobs_assets" {
  bucket = module.storage.bucket_names["assets"]
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${local.avatar_sa}"

  depends_on = [module.service_accounts]
}

resource "google_workflows_workflow" "avatar_upload" {
  project         = var.project_id
  region          = var.region
  name            = "chalito-avatar-upload"
  description     = "Runs chalito-avatar-jobs for uploads/<owner>/<asset>/original"
  service_account = local.avatar_trig
  labels          = local.labels

  source_contents = <<-YAML
    main:
      params: [event]
      steps:
        - init:
            assign:
              - object: $${event.data.name}
        - only_uploads:
            switch:
              - condition: $${text.match_regex(object, "^uploads/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{8,64}/original$")}
                next: run_job
            next: ignore
        - run_job:
            call: googleapis.run.v2.projects.locations.jobs.run
            args:
              name: ${google_cloud_run_v2_job.avatar_jobs.id}
              body:
                overrides:
                  containerOverrides:
                    - env:
                        - name: UPLOAD_PATH
                          value: $${object}
            result: execution
        - started:
            return: $${execution.metadata.name}
        - ignore:
            return: "ignored"
  YAML

  depends_on = [module.project_services]
}

# The Workflow may run this one job, with the UPLOAD_PATH override, and nothing else.
resource "google_cloud_run_v2_job_iam_member" "avatar_trig_runs_job" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.avatar_jobs.name
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = "serviceAccount:${local.avatar_trig}"
}

resource "google_project_iam_member" "avatar_trig" {
  for_each = toset(["roles/workflows.invoker", "roles/eventarc.eventReceiver"])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${local.avatar_trig}"

  depends_on = [module.service_accounts]
}

# Eventarc's Cloud Storage triggers publish through the project's GCS service agent.
resource "google_project_iam_member" "gcs_agent_pubsub" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${local.gcs_agent}"
}

resource "google_eventarc_trigger" "avatar_upload" {
  project         = var.project_id
  location        = var.region
  name            = "chalito-avatar-upload"
  service_account = local.avatar_trig
  labels          = local.labels

  matching_criteria {
    attribute = "type"
    value     = "google.cloud.storage.object.v1.finalized"
  }
  matching_criteria {
    attribute = "bucket"
    value     = module.storage.bucket_names["assets"]
  }

  destination {
    workflow = google_workflows_workflow.avatar_upload.id
  }

  depends_on = [google_project_iam_member.avatar_trig, google_project_iam_member.gcs_agent_pubsub]
}
