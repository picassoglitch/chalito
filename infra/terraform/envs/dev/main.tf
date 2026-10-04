locals {
  labels = { app = "chalito" }

  services = [
    "firestore.googleapis.com",
    "pubsub.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudkms.googleapis.com",
    "bigquery.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com",
    "fcm.googleapis.com",
    "identitytoolkit.googleapis.com",
    "billingbudgets.googleapis.com",
    "monitoring.googleapis.com",
    "iamcredentials.googleapis.com",
  ]

  service_accounts = {
    "chalito-orchestrator" = "Chalito orchestrator: router, Mesa moderator, usage metering"
    "chalito-notifier"     = "Chalito notifier: escalation, push, WhatsApp, Twilio"
    "chalito-mcp-gateway"  = "Chalito MCP gateway: reduced scopes, read-only Firestore, no signing keys"
    "chalito-avatar-jobs"  = "Chalito avatar jobs: upload validation and conversion, no secrets"
    "chalito-pubsub-push"  = "Identity Pub/Sub uses to push to Chalito services"
  }

  topics = ["agent-events", "notifications", "room-events", "billing-events", "usage", "audit"]
}

module "project_services" {
  source     = "../../modules/project_services"
  project_id = var.project_id
  services   = local.services
}

module "service_accounts" {
  source     = "../../modules/service_accounts"
  project_id = var.project_id
  accounts   = local.service_accounts

  depends_on = [module.project_services]
}

locals {
  # Deterministic emails keep for_each keys known at plan time; resources that use them
  # depend on module.service_accounts for ordering.
  sa           = { for id, _ in local.service_accounts : id => "${id}@${var.project_id}.iam.gserviceaccount.com" }
  orchestrator = local.sa["chalito-orchestrator"]
  notifier     = local.sa["chalito-notifier"]
  mcp          = local.sa["chalito-mcp-gateway"]
  push         = local.sa["chalito-pubsub-push"]
  # The `api` service account comes from Chalyb's engine module (ADR 0016); empty until it exists.
  api_list  = var.api_service_account == "" ? [] : [var.api_service_account]
  pubsub_sa = "service-${var.project_number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

module "artifact_registry" {
  source        = "../../modules/artifact_registry"
  project_id    = var.project_id
  region        = var.region
  repository_id = "chalito"

  depends_on = [module.project_services]
}

module "firestore" {
  source     = "../../modules/firestore"
  project_id = var.project_id
  location   = var.region

  depends_on = [module.project_services]
}

module "pubsub" {
  source     = "../../modules/pubsub"
  project_id = var.project_id
  topics     = local.topics
  labels     = local.labels

  depends_on = [module.project_services]
}

module "bigquery" {
  source         = "../../modules/bigquery"
  project_id     = var.project_id
  project_number = var.project_number
  location       = var.region
  usage_topic_id = module.pubsub.topic_ids["usage"]
  audit_topic_id = module.pubsub.topic_ids["audit"]
  usage_dlq_id   = module.pubsub.dlq_ids["usage"]
  audit_dlq_id   = module.pubsub.dlq_ids["audit"]
  labels         = local.labels
}

module "cloud_tasks" {
  source     = "../../modules/cloud_tasks"
  project_id = var.project_id
  location   = var.region
  queues     = ["chalito-escalation", "chalito-reminders"]

  depends_on = [module.project_services]
}

module "kms" {
  source     = "../../modules/kms"
  project_id = var.project_id
  location   = var.region

  depends_on = [module.project_services]
}

module "storage" {
  source             = "../../modules/storage"
  project_id         = var.project_id
  project_number     = var.project_number
  location           = var.region
  records_kms_key_id = module.kms.records_key_id
  labels             = local.labels
}

# Secret containers (values out of band). The SSO secret and admin token belong to
# Chalyb's engine module; Chalito services that call the hub get read access to them there.
module "secrets" {
  source     = "../../modules/secrets"
  project_id = var.project_id
  labels     = local.labels
  secrets = {
    "chalito-anthropic-api-key"     = concat([local.orchestrator], local.api_list)
    "chalito-openai-api-key"        = concat([local.orchestrator, local.notifier], local.api_list)
    "chalito-xai-api-key"           = [local.orchestrator]
    "chalito-twilio-account-sid"    = [local.notifier]
    "chalito-twilio-auth-token"     = [local.notifier]
    "chalito-twilio-from-number"    = [local.notifier]
    "chalito-twilio-verify-service" = concat([local.notifier], local.api_list)
    "chalito-meta-wa-phone-id"      = [local.notifier]
    "chalito-meta-wa-access-token"  = [local.notifier]
    "chalito-meta-wa-app-secret"    = concat([local.notifier], local.api_list)
    "chalito-meta-wa-verify-token"  = local.api_list
    "chalito-owner-uids"            = concat([local.orchestrator, local.notifier], local.api_list)
    "chalito-owner-default-phone"   = local.api_list
  }

  depends_on = [module.service_accounts]
}

# ---- Firestore access, scoped to the `chalito` database only -------------------
# Service accounts bypass security rules, so least privilege is enforced here: the MCP
# gateway gets read-only access (its writes go through `api`), others read/write.
locals {
  db_condition = "resource.name == \"projects/${var.project_id}/databases/${module.firestore.database_id}\""
  firestore_rw = concat([local.orchestrator, local.notifier], local.api_list)
}

resource "google_project_iam_member" "firestore_rw" {
  for_each = toset(local.firestore_rw)

  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${each.value}"

  condition {
    title      = "chalito-db-only"
    expression = local.db_condition
  }

  depends_on = [module.service_accounts]
}

resource "google_project_iam_member" "firestore_mcp_read" {
  project = var.project_id
  role    = "roles/datastore.viewer"
  member  = "serviceAccount:${local.mcp}"

  condition {
    title      = "chalito-db-only"
    expression = local.db_condition
  }

  depends_on = [module.service_accounts]
}

# Only `api` mints Firebase custom tokens (signBlob on its own SA).
resource "google_service_account_iam_member" "api_sign_blob" {
  count = var.api_service_account == "" ? 0 : 1

  service_account_id = "projects/${var.project_id}/serviceAccounts/${var.api_service_account}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.api_service_account}"
}

resource "google_project_iam_member" "notifier_tasks" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${local.notifier}"

  depends_on = [module.service_accounts]
}

# ---- Topic-level publish rights -------------------------------------------------
locals {
  publishers = {
    "agent-events"   = local.api_list
    "notifications"  = concat([local.orchestrator], local.api_list)
    "room-events"    = local.api_list
    "billing-events" = local.api_list
    "usage"          = [local.orchestrator, local.notifier]
    "audit"          = concat([local.orchestrator, local.notifier, local.mcp], local.api_list)
  }
  publisher_bindings = merge([
    for topic, members in local.publishers : { for m in members : "${topic}/${m}" => { topic = topic, member = m } }
  ]...)
}

resource "google_pubsub_topic_iam_member" "publish" {
  for_each = local.publisher_bindings

  project = var.project_id
  topic   = module.pubsub.topic_ids[each.value.topic]
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${each.value.member}"

  depends_on = [module.service_accounts]
}

# ---- Cloud Run services (api is Chalyb's engine module) -------------------------
module "orchestrator" {
  source          = "../../modules/cloud_run_service"
  project_id      = var.project_id
  region          = var.region
  name            = "chalito-orchestrator"
  service_account = local.orchestrator
  invokers        = ["serviceAccount:${local.push}"]
  labels          = local.labels
  env = {
    FIRESTORE_DATABASE = module.firestore.database_id
    VERTEX_LOCATION    = "global"
  }
  secret_env = {
    ANTHROPIC_API_KEY = "chalito-anthropic-api-key"
    OPENAI_API_KEY    = "chalito-openai-api-key"
    XAI_API_KEY       = "chalito-xai-api-key"
  }

  depends_on = [module.secrets, module.service_accounts]
}

module "notifier" {
  source          = "../../modules/cloud_run_service"
  project_id      = var.project_id
  region          = var.region
  name            = "chalito-notifier"
  service_account = local.notifier
  invokers        = ["serviceAccount:${local.push}"]
  labels          = local.labels
  env = {
    FIRESTORE_DATABASE = module.firestore.database_id
  }
  secret_env = {
    TWILIO_ACCOUNT_SID      = "chalito-twilio-account-sid"
    TWILIO_AUTH_TOKEN       = "chalito-twilio-auth-token"
    TWILIO_FROM_NUMBER      = "chalito-twilio-from-number"
    META_WA_PHONE_NUMBER_ID = "chalito-meta-wa-phone-id"
    META_WA_ACCESS_TOKEN    = "chalito-meta-wa-access-token"
    OPENAI_API_KEY          = "chalito-openai-api-key"
  }

  depends_on = [module.secrets]
}

# Public by design: ChatGPT and Claude connectors call it over the internet. Every tool
# call is OAuth-authenticated with reduced scopes (ADR 0009).
module "mcp_gateway" {
  source          = "../../modules/cloud_run_service"
  project_id      = var.project_id
  region          = var.region
  name            = "chalito-mcp-gateway"
  service_account = local.mcp
  public          = true
  labels          = local.labels
  env = {
    FIRESTORE_DATABASE = module.firestore.database_id
  }

  depends_on = [module.service_accounts]
}

# ---- Push subscriptions ---------------------------------------------------------
resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = "projects/${var.project_id}/serviceAccounts/${local.push}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${local.pubsub_sa}"

  depends_on = [module.service_accounts]
}

locals {
  push_subscriptions = {
    "agent-events-orchestrator" = { topic = "agent-events", endpoint = "${module.orchestrator.uri}/pubsub/agent-events" }
    "notifications-notifier"    = { topic = "notifications", endpoint = "${module.notifier.uri}/pubsub/notifications" }
    "room-events-notifier"      = { topic = "room-events", endpoint = "${module.notifier.uri}/pubsub/room-events" }
  }
}

resource "google_pubsub_subscription" "push" {
  for_each = local.push_subscriptions

  project = var.project_id
  name    = each.key
  topic   = module.pubsub.topic_ids[each.value.topic]
  labels  = local.labels

  ack_deadline_seconds = 30

  push_config {
    push_endpoint = each.value.endpoint
    oidc_token {
      service_account_email = local.push
    }
  }

  dead_letter_policy {
    dead_letter_topic     = module.pubsub.dlq_ids[each.value.topic]
    max_delivery_attempts = 10
  }

  retry_policy {
    minimum_backoff = "5s"
    maximum_backoff = "300s"
  }

  depends_on = [google_service_account_iam_member.pubsub_token_creator]
}

# Dead-lettering needs the Pub/Sub service agent to publish to DLQs and ack the source.
resource "google_pubsub_topic_iam_member" "dlq_publisher" {
  for_each = module.pubsub.dlq_ids

  project = var.project_id
  topic   = each.value
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${local.pubsub_sa}"
}

resource "google_pubsub_subscription_iam_member" "dlq_subscriber" {
  for_each = google_pubsub_subscription.push

  project      = var.project_id
  subscription = each.value.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${local.pubsub_sa}"
}

module "budget" {
  source          = "../../modules/budget"
  billing_account = var.billing_account
  project_number  = var.project_number
  amount_usd      = var.monthly_budget_usd
  alert_email     = var.alert_email

  depends_on = [module.project_services]
}

# Firebase on Chalyb's project: needed for custom-token sign-in (devices, PWA) and for
# deploying Firestore rules. It is a project-wide change, so it's opt-in (decision #33).
resource "google_firebase_project" "this" {
  count    = var.enable_firebase ? 1 : 0
  provider = google-beta
  project  = var.project_id

  depends_on = [module.project_services]
}
