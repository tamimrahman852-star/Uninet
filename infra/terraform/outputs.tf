output "alb_dns_name" {
  description = "Public DNS name of the load balancer (point api.<domain> at it)"
  value       = aws_lb.public.dns_name
}

output "ecr_repository_urls" {
  description = "ECR repository URL per service"
  value       = { for k, v in aws_ecr_repository.svc : k => v.repository_url }
}

output "ecs_cluster_name" {
  description = "ECS cluster name used by the deploy workflow"
  value       = aws_ecs_cluster.main.name
}

output "media_bucket" {
  description = "S3 bucket that stores HLS renditions"
  value       = aws_s3_bucket.media.bucket
}

output "redis_endpoint" {
  description = "Primary Redis endpoint"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "vpc_id" {
  value = module.vpc.vpc_id
}
