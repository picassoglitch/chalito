variable "project_id" {
  description = "Chalyb's GCP project (Chalito is a Chalyb engine, ADR 0016)."
  type        = string
}

variable "project_number" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "billing_account" {
  type = string
}

variable "alert_email" {
  type = string
}

variable "monthly_budget_usd" {
  description = "Owner-set monthly budget for app=chalito resources."
  type        = number
}

variable "domain" {
  description = "Base host for Chalito (ADR 0015)."
  type        = string
  default     = "chalito.chalyb.com"
}

variable "api_service_account" {
  description = "Email of the `api` service account created by Chalyb's engine module. Empty until the engine entry exists."
  type        = string
  default     = ""
}

variable "hub_admin_token_secret" {
  description = "Secret id (this project) of CHALITO_ADMIN_TOKEN, created and access-granted by Chalyb's engine module (ADR 0016). Empty: the notifier and orchestrator get no hub bearer."
  type        = string
  default     = ""
}

variable "api_url" {
  description = "The api's public URL (Chalyb's engine module), e.g. https://api.chalito.chalyb.com."
  type        = string
  default     = "https://api.chalito.chalyb.com"
}

variable "notifier_public_url" {
  description = "The notifier's public URL (Twilio signatures and OIDC audiences are built from it). Set after the first deploy, or to a mapped domain."
  type        = string
  default     = ""
}

variable "orchestrator_public_url" {
  description = "The orchestrator's public URL (Cloud Scheduler OIDC audience)."
  type        = string
  default     = ""
}

variable "supabase_url" {
  description = "The hub's Supabase project URL (ADR 0017)."
  type        = string
  default     = ""
}

variable "vapid_public_key" {
  description = "Web Push VAPID public key (not secret; the private key is a secret)."
  type        = string
  default     = ""
}

variable "realtime_sip_uri" {
  description = "Optional: OpenAI Realtime SIP URI for calls (sip:<proj>@sip.api.openai.com;transport=tls;secure=true)."
  type        = string
  default     = ""
}
