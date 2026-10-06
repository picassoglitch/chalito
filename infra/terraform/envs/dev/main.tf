locals {
  labels = { app = "chalito" }

  services = [
    "pubsub.googleapis.com",
    "cloudtasks.googleapis.com",
    "cloudkms.googleapis.com",
    "bigquery.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com",
    "billingbudgets.googleapis.com",
    "monitoring.googleapis.com",
    "iamcredentials.googleapis.com",
    "eventarc.googleapis.com",
    "workflows.googleapis.com",
    "cloudscheduler.googleapis.com",
  ]

  service_accounts = {
    "chalito-orchestrator" = "Chalito orchestrator: router, Mesa moderator, usage metering"
    "chalito-notifier"     = "Chalito notifier: escalation, push, WhatsApp, Twilio"
    "chalito-mcp-gateway"  = "Chalito MCP gateway: reduced scopes, read-only data, no signing keys"
    "chalito-avatar-jobs"  = "Chalito avatar jobs: upload validation, conversion and custom companions (Gemini key, database)"
    "chalito-pubsub-push"  = "Identity Pub/Sub uses to push to Chalito services"
    "chalito-avatar-trig"  = "Chalito avatar trigger: Eventarc + the Workflow that starts avatar-jobs"
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
  # The PWA uploads custom-companion photos straight to the bucket (signed PUT).
  # Photo uploads (PUT) and custom-card textures (GET, CORS mode in three.js): the web app runs inside the
  # Chalyb hub (www.chalyb.com/app/chalito); the desktop webview loads from the Tauri origins.
  upload_cors_origins = ["https://${var.domain}", "https://www.chalyb.com", "tauri://localhost", "http://tauri.localhost"]
}

# The api signs upload and download URLs for custom companions (GcsAvatarFiles) as itself, through
# IAM signBlob: it needs Token Creator on its own account (no key file anywhere).
resource "google_service_account_iam_member" "api_self_sign" {
  for_each = toset(local.api_list)

  service_account_id = "projects/${var.project_id}/serviceAccounts/${each.value}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${each.value}"
}

# The api (Chalyb's engine module) writes account exports and records to the records bucket and
# avatars to the assets bucket, and deletes an owner's prefixes on account deletion (RUNBOOK).
resource "google_storage_bucket_iam_member" "api_objects" {
  for_each = toset(var.api_service_account == "" ? [] : ["assets", "records"])

  bucket = module.storage.bucket_names[each.key]
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${var.api_service_account}"
}

# Secret containers (values out of band). The SSO secret, admin token and database URL belong to
# Chalyb's engine module; the services that read them get access in hub_secret_read below.
module "secrets" {
  source     = "../../modules/secrets"
  project_id = var.project_id
  labels     = local.labels
  secrets = {
    "chalito-anthropic-api-key"     = concat([local.orchestrator], local.api_list)
    "chalito-openai-api-key"        = concat([local.orchestrator, local.notifier], local.api_list)
    "chalito-xai-api-key"           = [local.orchestrator]
    "chalito-twilio-account-sid"    = concat([local.notifier], local.api_list)
    "chalito-twilio-auth-token"     = concat([local.notifier], local.api_list)
    "chalito-twilio-from-number"    = [local.notifier]
    "chalito-twilio-verify-service" = concat([local.notifier], local.api_list)
    "chalito-meta-wa-phone-id"      = [local.notifier]
    "chalito-meta-wa-access-token"  = [local.notifier]
    "chalito-meta-wa-app-secret"    = concat([local.notifier], local.api_list)
    "chalito-meta-wa-verify-token"  = concat([local.notifier], local.api_list)
    "chalito-owner-uids"            = concat([local.orchestrator, local.notifier], local.api_list)
    "chalito-owner-default-phone"   = local.api_list
    # R-L12: everything the services require, by the names the code reads (see secret_env below).
    # chalito-database-url is not here: Chalyb's engine module creates it (hub_secret_read below).
    "chalito-gateway-database-url" = [local.mcp]
    "chalito-gateway-token"        = concat([local.mcp], local.api_list)
    "chalito-supabase-secret-key"  = [local.orchestrator]
    # The api's desktop-voice token key (VOICE_TOKEN_SECRET); 32 random bytes.
    "chalito-voice-token-secret"    = local.api_list
    "chalito-vapid-private-key"     = [local.notifier]
    "chalito-openai-webhook-secret" = [local.notifier]
    "chalito-voice-ref-secret"      = [local.notifier]
    # Same value as the Vault secret chalito_notify_poke_secret in nexo-ai (migration 003050).
    "chalito-notify-poke-secret" = [local.notifier]
    # Google AI Studio key for custom companions (apps/avatar-jobs src/creation.ts): the job only.
    "chalito-gemini-api-key" = [local.avatar_sa]
  }

  depends_on = [module.service_accounts]
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
  env = merge({
    VERTEX_LOCATION       = "global"
    GOOGLE_CLOUD_PROJECT  = var.project_id
    CHALYB_BASE_URL       = "https://www.chalyb.com"
    CHALITO_WEB_ORIGIN    = local.web_origin
    BRAIN_KEYS_KMS_KEY    = module.kms.byo_key_id
    SCHEDULER_SA_EMAIL    = local.push
    SUPABASE_URL          = var.supabase_url
    ORCHESTRATOR_BASE_URL = var.orchestrator_public_url
  })
  secret_env = merge({
    ANTHROPIC_API_KEY   = "chalito-anthropic-api-key"
    OPENAI_API_KEY      = "chalito-openai-api-key"
    XAI_API_KEY         = "chalito-xai-api-key"
    DATABASE_URL        = "chalito-database-url"
    SUPABASE_SECRET_KEY = "chalito-supabase-secret-key"
    OWNER_UIDS          = "chalito-owner-uids"
  }, local.hub_bearer)

  depends_on = [module.secrets, module.service_accounts, google_secret_manager_secret_iam_member.hub_secret_read]
}

# BYO brain keys are envelope-encrypted with the byo key (BRAIN_KEYS_KMS_KEY): the orchestrator
# may use it, nothing else.
resource "google_kms_crypto_key_iam_member" "orchestrator_byo" {
  crypto_key_id = module.kms.byo_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${local.orchestrator}"

  depends_on = [module.service_accounts]
}

locals {
  # CHALITO_ADMIN_TOKEN is Chalyb's secret (engine module); hub_secret_read grants these services access.
  hub_bearer = var.hub_admin_token_secret == "" ? {} : { CHALITO_ADMIN_TOKEN = var.hub_admin_token_secret }

  # Secrets Chalyb's engine module creates in this project (<slug>-admin-token, -sso-secret,
  # -database-url) and grants only to the api. The notifier and orchestrator read two of them, so
  # access is granted here; creating them here too would collide with the hub's apply. They exist
  # once Chalyb's apply has run with the chalito entry (GO_LIVE 1.10), which api_service_account marks.
  hub_secret_readers = var.api_service_account == "" ? {} : merge(
    # The avatar job records creations and their usage events (apps/avatar-jobs src/creations.ts).
    { "chalito-database-url" = [local.orchestrator, local.notifier, local.avatar_sa] },
    var.hub_admin_token_secret == "" ? {} : { (var.hub_admin_token_secret) = [local.orchestrator, local.notifier] },
  )
  hub_secret_bindings = merge([
    for id, members in local.hub_secret_readers : { for m in members : "${id}/${m}" => { id = id, member = m } }
  ]...)
}

resource "google_secret_manager_secret_iam_member" "hub_secret_read" {
  for_each = local.hub_secret_bindings

  project   = var.project_id
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.member}"

  depends_on = [module.service_accounts]
}

module "notifier" {
  source          = "../../modules/cloud_run_service"
  project_id      = var.project_id
  region          = var.region
  name            = "chalito-notifier"
  service_account = local.notifier
  invokers        = ["serviceAccount:${local.push}"]
  labels          = local.labels
  # Call agents outlive the webhook request that starts them (apps/notifier README).
  cpu_always = true
  env = merge({
    GOOGLE_CLOUD_PROJECT = var.project_id
    CHALYB_BASE_URL      = "https://www.chalyb.com"
    APP_URL              = local.app_url
    PUBLIC_BASE_URL      = var.notifier_public_url
    PUBSUB_SA_EMAIL      = local.push
    TASKS_SA_EMAIL       = local.push
    SCHEDULER_SA_EMAIL   = local.push
    TASKS_LOCATION       = var.region
    TASKS_QUEUE          = "chalito-escalation"
    VAPID_SUBJECT        = local.web_origin
    VAPID_PUBLIC_KEY     = var.vapid_public_key
  }, var.realtime_sip_uri == "" ? {} : { REALTIME_SIP_URI = var.realtime_sip_uri })
  # Names as the code reads them (R-L12: TWILIO_FROM, WHATSAPP_*, META_*).
  secret_env = merge({
    DATABASE_URL             = "chalito-database-url"
    TWILIO_ACCOUNT_SID       = "chalito-twilio-account-sid"
    TWILIO_AUTH_TOKEN        = "chalito-twilio-auth-token"
    TWILIO_FROM              = "chalito-twilio-from-number"
    WHATSAPP_PHONE_NUMBER_ID = "chalito-meta-wa-phone-id"
    WHATSAPP_TOKEN           = "chalito-meta-wa-access-token"
    META_APP_SECRET          = "chalito-meta-wa-app-secret"
    META_VERIFY_TOKEN        = "chalito-meta-wa-verify-token"
    OPENAI_API_KEY           = "chalito-openai-api-key"
    OPENAI_WEBHOOK_SECRET    = "chalito-openai-webhook-secret"
    VOICE_REF_SECRET         = "chalito-voice-ref-secret"
    NOTIFY_POKE_SECRET       = "chalito-notify-poke-secret"
    VAPID_PRIVATE_KEY        = "chalito-vapid-private-key"
    OWNER_UIDS               = "chalito-owner-uids"
  }, local.hub_bearer)

  depends_on = [module.secrets, google_secret_manager_secret_iam_member.hub_secret_read]
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
    CHALITO_API_URL      = var.api_url
    CHALITO_API_ISSUER   = var.api_url
    CHALITO_MCP_RESOURCE = local.mcp_resource
  }
  secret_env = {
    DATABASE_URL          = "chalito-gateway-database-url"
    CHALITO_GATEWAY_TOKEN = "chalito-gateway-token"
  }

  depends_on = [module.secrets, module.service_accounts]
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
  amount          = var.monthly_budget
  currency_code   = var.budget_currency
  alert_email     = var.alert_email

  depends_on = [module.project_services]
}

locals {
  # Where Chalito's screens live: its own host by default; inside the hub, the hub's origin and
  # /app/chalito (owner decision 2026-10-05).
  web_origin   = coalesce(var.web_origin, "https://${var.domain}")
  app_url      = coalesce(var.app_url, "https://${var.domain}")
  mcp_resource = coalesce(var.mcp_resource, "https://mcp.${var.domain}/mcp")
}
