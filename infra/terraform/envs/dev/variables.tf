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
