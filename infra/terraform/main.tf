terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # Configure remote state with: terraform init -backend-config="bucket=..." -backend-config="key=uninet/terraform.tfstate" ...
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "uninet"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

locals {
  name = "uninet-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)

  # Which secrets each service receives (only those present in var.secret_arns are injected).
  service_secret_names = {
    gateway   = ["SUPABASE_JWT_SECRET", "INTERNAL_GATEWAY_SECRET"]
    auth      = ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_SECRET"]
    chat      = ["SUPABASE_JWT_SECRET"]
    ecommerce = ["SUPABASE_JWT_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "INTERNAL_GATEWAY_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "BKASH_APP_KEY", "BKASH_APP_SECRET", "BKASH_USERNAME", "BKASH_PASSWORD", "SSLCOMMERZ_STORE_ID", "SSLCOMMERZ_STORE_PASSWORD"]
    media     = ["SUPABASE_JWT_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "INTERNAL_GATEWAY_SECRET"]
    ai        = ["SUPABASE_JWT_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "LLM_API_KEY", "EMBEDDING_API_KEY"]
  }

  services = {
    gateway   = { port = 8080, cpu = 512, memory = 1024, health = "/healthz", public = true }
    auth      = { port = 4001, cpu = 256, memory = 512, health = "/healthz", public = false }
    chat      = { port = 4002, cpu = 512, memory = 1024, health = "/healthz", public = false }
    ecommerce = { port = 4003, cpu = 512, memory = 1024, health = "/healthz", public = false }
    media     = { port = 4004, cpu = 2048, memory = 8192, health = "/healthz", public = false }
    ai        = { port = 4005, cpu = 512, memory = 1024, health = "/healthz", public = false }
  }

  all_secret_arns = values(var.secret_arns)
}

# ---------------------------------------------------------------- network
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.13"

  name = local.name
  cidr = var.vpc_cidr
  azs  = local.azs

  public_subnets  = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets = [for i, _ in local.azs : cidrsubnet(var.vpc_cidr, 8, i + 10)]

  enable_nat_gateway   = true
  single_nat_gateway   = var.environment != "production"
  enable_dns_hostnames = true
  enable_dns_support   = true
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public load balancer"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "ECS tasks"
  vpc_id      = module.vpc.vpc_id

  ingress {
    description     = "From ALB to the gateway"
    from_port       = local.services.gateway.port
    to_port         = local.services.gateway.port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description = "Service to service"
    from_port   = 4001
    to_port     = 4005
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------------------------------------------------------- registries and logs
resource "aws_ecr_repository" "svc" {
  for_each             = local.services
  name                 = "uninet/${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = var.environment != "production"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "svc" {
  for_each   = aws_ecr_repository.svc
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 30 most recent images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_cloudwatch_log_group" "svc" {
  for_each          = local.services
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = var.environment == "production" ? 90 : 14
}

# ---------------------------------------------------------------- data stores
resource "aws_s3_bucket" "media" {
  bucket        = "${local.name}-media-${data.aws_caller_identity.current.account_id}"
  force_destroy = var.environment != "production"
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = split(",", var.cors_origins)
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${local.name}-redis"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Redis access from ECS tasks"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${local.name}-redis"
  description                = "Uninet Redis (rate limits, chat backplane, stock locks)"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = var.environment == "production" ? 2 : 1
  automatic_failover_enabled = var.environment == "production"
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false # services connect with redis:// ; enable and switch to rediss:// if desired
  port                       = 6379
}

# ---------------------------------------------------------------- load balancer
resource "aws_lb" "public" {
  name               = local.name
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.vpc.public_subnets
  idle_timeout       = 300 # SSE / WebSocket friendly
}

resource "aws_lb_target_group" "gateway" {
  name        = "${local.name}-gw"
  port        = local.services.gateway.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = module.vpc.vpc_id

  deregistration_delay = 30

  health_check {
    path                = local.services.gateway.health
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = var.certificate_arn != "" ? "redirect" : "forward"

    dynamic "redirect" {
      for_each = var.certificate_arn != "" ? [1] : []
      content {
        port        = "443"
        protocol    = "HTTPS"
        status_code = "HTTP_301"
      }
    }

    target_group_arn = var.certificate_arn != "" ? null : aws_lb_target_group.gateway.arn
  }
}

resource "aws_lb_listener" "https" {
  count             = var.certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gateway.arn
  }
}

# ---------------------------------------------------------------- service discovery
resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = "uninet.internal"
  vpc  = module.vpc.vpc_id
}

resource "aws_service_discovery_service" "svc" {
  for_each = { for k, v in local.services : k => v if !v.public }
  name     = each.key

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.internal.id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

# ---------------------------------------------------------------- IAM
data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  count = length(local.all_secret_arns) > 0 ? 1 : 0

  statement {
    actions   = ["secretsmanager:GetSecretValue", "ssm:GetParameters", "kms:Decrypt"]
    resources = local.all_secret_arns
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  count  = length(local.all_secret_arns) > 0 ? 1 : 0
  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets[0].json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "media_bucket" {
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    actions   = ["s3:ListBucket", "s3:ListBucketMultipartUploads"]
    resources = [aws_s3_bucket.media.arn]
  }
}

resource "aws_iam_role_policy" "task_media" {
  name   = "media-bucket"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.media_bucket.json
}

# ---------------------------------------------------------------- ECS
resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  base_env = {
    NODE_ENV  = "production"
    LOG_LEVEL = "info"
  }

  service_env = {
    gateway = {
      PORT                  = "8080"
      REDIS_URL             = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
      CORS_ORIGINS          = var.cors_origins
      AUTH_SERVICE_URL      = "http://auth.uninet.internal:4001"
      CHAT_SERVICE_URL      = "http://chat.uninet.internal:4002"
      ECOMMERCE_SERVICE_URL = "http://ecommerce.uninet.internal:4003"
      MEDIA_SERVICE_URL     = "http://media.uninet.internal:4004"
      AI_SERVICE_URL        = "http://ai.uninet.internal:4005"
      TRUST_PROXY_HOPS      = "1"
    }
    auth = {
      PORT         = "4001"
      SUPABASE_URL = var.supabase_url
      CORS_ORIGINS = var.cors_origins
    }
    chat = {
      PORT               = "4002"
      REDIS_URL          = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
      ALLOWED_ORIGINS    = var.cors_origins
      CASSANDRA_HOSTS    = var.cassandra_hosts
      CASSANDRA_KEYSPACE = var.cassandra_keyspace
    }
    ecommerce = {
      PORT           = "4003"
      SUPABASE_URL   = var.supabase_url
      REDIS_URL      = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
      FRONTEND_URL   = var.frontend_url
      PUBLIC_API_URL = var.public_api_url
    }
    media = {
      PORT                  = "4004"
      SUPABASE_URL          = var.supabase_url
      S3_REGION             = var.aws_region
      S3_BUCKET             = aws_s3_bucket.media.bucket
      MEDIA_PUBLIC_BASE_URL = var.media_public_base_url
    }
    ai = {
      PORT         = "4005"
      SUPABASE_URL = var.supabase_url
      REDIS_URL    = "redis://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
    }
  }
}

resource "aws_ecs_task_definition" "svc" {
  for_each                 = local.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  dynamic "ephemeral_storage" {
    for_each = each.key == "media" ? [1] : []
    content {
      size_in_gib = 100
    }
  }

  container_definitions = jsonencode([{
    name      = each.key
    image     = "${aws_ecr_repository.svc[each.key].repository_url}:${var.image_tag}"
    essential = true

    portMappings = [{ containerPort = each.value.port, protocol = "tcp" }]

    environment = [for k, v in merge(local.base_env, local.service_env[each.key]) : { name = k, value = v }]

    secrets = [
      for name in local.service_secret_names[each.key] : { name = name, valueFrom = var.secret_arns[name] }
      if contains(keys(var.secret_arns), name)
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = each.key
      }
    }

    stopTimeout = 30
  }])
}

resource "aws_ecs_service" "svc" {
  for_each                           = local.services
  name                               = each.key
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.svc[each.key].arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = each.value.public ? 60 : null
  enable_execute_command             = var.environment != "production"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.public ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.gateway.arn
      container_name   = each.key
      container_port   = each.value.port
    }
  }

  dynamic "service_registries" {
    for_each = each.value.public ? [] : [1]
    content {
      registry_arn = aws_service_discovery_service.svc[each.key].arn
    }
  }

  depends_on = [aws_lb_listener.http]

  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "svc" {
  for_each           = local.services
  max_capacity       = var.desired_count * 5
  min_capacity       = var.desired_count
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.svc[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = local.services
  name               = "${local.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.svc[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.svc[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.svc[each.key].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
