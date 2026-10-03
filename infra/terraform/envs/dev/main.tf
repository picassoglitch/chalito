locals {
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
  ]

  service_accounts = {
    "chalito-orchestrator" = "Chalito orchestrator: router, Mesa moderator, usage metering"
    "chalito-notifier"     = "Chalito notifier: escalation, push, WhatsApp, Twilio"
    "chalito-mcp-gateway"  = "Chalito MCP gateway: reduced scopes, no signing keys"
    "chalito-avatar-jobs"  = "Chalito avatar jobs: upload validation and conversion, no secrets"
  }
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

module "artifact_registry" {
  source        = "../../modules/artifact_registry"
  project_id    = var.project_id
  region        = var.region
  repository_id = "chalito"

  depends_on = [module.project_services]
}

module "budget" {
  source          = "../../modules/budget"
  billing_account = var.billing_account
  project_number  = var.project_number
  amount_usd      = var.monthly_budget_usd
  alert_email     = var.alert_email

  depends_on = [module.project_services]
}
