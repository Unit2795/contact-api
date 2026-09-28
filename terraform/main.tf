terraform {
  # Partial config; the rest comes from terraform init -backend-config=state.config.
  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }
  required_version = ">= 1.10"
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = { Project = local.name }
  }
}

data "aws_caller_identity" "current" {}

# forms.json is bundled into the Lambda and read here for sites and sender domains, so both use the same config.
locals {
  # Resource names and the SSM path prefix. The smoke test in action.yml, the deploy role in bootstrap.yml and the docs hard-code this value.
  name         = "contact-api"
  forms_config = jsondecode(file("${path.module}/../forms.json"))
  sites        = toset(local.forms_config.sites)
  sender_domains = toset([
    for form in values(local.forms_config.forms) : split("@", try(form.from, local.forms_config.defaults.from))[1]
  ])
}
