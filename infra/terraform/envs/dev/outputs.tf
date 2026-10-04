output "service_accounts" {
  value = module.service_accounts.emails
}

output "artifact_registry" {
  value = module.artifact_registry.repository
}

output "secrets_needing_values" {
  description = "Filled in at M2, when secret containers are added."
  value       = []
}

output "hosts" {
  description = "Public hosts (ADR 0015). DNS for these is managed on the Chalyb side."
  value = {
    web = var.domain
    api = "api.${var.domain}"
    mcp = "mcp.${var.domain}"
  }
}
