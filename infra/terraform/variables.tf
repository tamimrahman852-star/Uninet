variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "ap-southeast-1"
}

variable "environment" {
  description = "Deployment environment name (staging | production)"
  type        = string
  default     = "staging"
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC"
  type        = string
  default     = "10.20.0.0/16"
}

variable "image_tag" {
  description = "Container image tag deployed for every service (usually the git sha)"
  type        = string
  default     = "latest"
}

variable "desired_count" {
  description = "Default number of tasks per service"
  type        = number
  default     = 2
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the HTTPS listener. Leave empty to serve plain HTTP (not for production)."
  type        = string
  default     = ""
}

variable "cors_origins" {
  description = "Comma separated list of allowed web origins"
  type        = string
  default     = "https://app.example.com"
}

variable "redis_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t4g.small"
}

variable "cassandra_hosts" {
  description = "Comma separated Cassandra contact points (self-hosted cluster or Amazon Keyspaces endpoint)"
  type        = string
  default     = ""
}

variable "cassandra_keyspace" {
  description = "Cassandra keyspace used by the chat service"
  type        = string
  default     = "uninet_chat"
}

variable "supabase_url" {
  description = "Supabase project URL"
  type        = string
}

variable "frontend_url" {
  description = "Public URL of the web frontend"
  type        = string
  default     = "https://app.example.com"
}

variable "public_api_url" {
  description = "Public URL of the API gateway (used for payment callbacks)"
  type        = string
  default     = "https://api.example.com"
}

variable "media_public_base_url" {
  description = "Public CDN/base URL from which HLS media is served"
  type        = string
  default     = ""
}

variable "secret_arns" {
  description = <<-EOT
    Map of ENV_VAR_NAME => AWS Secrets Manager / SSM Parameter ARN injected into containers.
    Expected keys: SUPABASE_JWT_SECRET, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, INTERNAL_GATEWAY_SECRET,
    LLM_API_KEY, EMBEDDING_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, BKASH_APP_KEY, BKASH_APP_SECRET,
    BKASH_USERNAME, BKASH_PASSWORD, SSLCOMMERZ_STORE_ID, SSLCOMMERZ_STORE_PASSWORD
  EOT
  type        = map(string)
  default     = {}
}
