# Monthly budget for resources labelled app=chalito, alerting at 50/90/100%.
variable "billing_account" {
  type = string
}

variable "project_number" {
  type = string
}

variable "amount" {
  type = number
}

# Must match the billing account's currency (the API rejects any other).
variable "currency_code" {
  type    = string
  default = "USD"
}

variable "alert_email" {
  type = string
}

resource "google_monitoring_notification_channel" "email" {
  project      = var.project_number
  display_name = "Chalito budget alerts"
  type         = "email"
  labels       = { email_address = var.alert_email }
}

resource "google_billing_budget" "this" {
  billing_account = var.billing_account
  display_name    = "chalito-monthly"

  budget_filter {
    projects = ["projects/${var.project_number}"]
    labels   = { app = "chalito" }
  }

  amount {
    specified_amount {
      currency_code = var.currency_code
      units         = tostring(var.amount)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.5, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }

  all_updates_rule {
    monitoring_notification_channels = [google_monitoring_notification_channel.email.id]
    disable_default_iam_recipients   = false
  }
}
