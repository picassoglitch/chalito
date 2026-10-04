# Chalito infra: dev

Terraform for **Chalito-only resources inside Chalyb's GCP project** (ADR 0016). Chalyb's own Terraform owns the engine entry: the `api` service account, its secrets, the Cloud Run `api` service and the domain mapping.

M1 contents: API enablement (never disabled on destroy), per-service service accounts, the Artifact Registry repo, and a budget on `app=chalito` resources.

## Bootstrap (owner, once)
1. Create a GCS bucket for Chalito's state in Chalyb's project, with versioning on and public access prevention enforced.
2. `cp backend.hcl.example backend.hcl` and `cp terraform.tfvars.example terraform.tfvars`, then fill both in.
3. `terraform init -backend-config=backend.hcl`, then `terraform plan`.

**`terraform apply` only with the owner's go.** It creates billable resources in a shared project.

CI runs `fmt -check`, `init -backend=false`, `validate`, `tflint` and `checkov` without credentials.
