output "service_accounts" {
  value = module.service_accounts.emails
}

output "artifact_registry" {
  value = module.artifact_registry.repository
}

output "topics" {
  value = module.pubsub.topic_ids
}

output "buckets" {
  value = module.storage.bucket_names
}

output "service_urls" {
  value = {
    orchestrator = module.orchestrator.uri
    notifier     = module.notifier.uri
    mcp_gateway  = module.mcp_gateway.uri
  }
}

output "secrets_needing_values" {
  value = module.secrets.secret_ids
}

output "hosts" {
  description = "Public hosts (ADR 0015). DNS for these is managed on the Chalyb side."
  value = {
    web = var.domain
    api = "api.${var.domain}"
    mcp = "mcp.${var.domain}"
  }
}
