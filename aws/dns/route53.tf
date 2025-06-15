terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.100.0"
    }
  }

  backend "s3" {
    bucket         = "ithaka-apps-tfstate-test"
    key            = "jaip-backend/route53/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "test-tfstate-lock"
  }
}

# TEMPORARY ADMIN SITE
resource "aws_route53_zone" "temporary_admin_zone" {
  name = local.temporary_admin_domain

  tags = {
    "ithaka/environment" = "prod"
    "ithaka/owner"       = "jaip"
    "ithaka/business.unit" = "labs"
    "ithaka/app" = local.app_name
    app = local.app_name
  }

  lifecycle {
    prevent_destroy = true
  }
}

# This is the main record for the old admin subdomain. This should be
# set to redirect to the new admin subdomain.
resource "aws_route53_record" "temporary_admin_record" {
  zone_id = aws_route53_zone.temporary_admin_zone.zone_id
  name    = "${local.temporary_admin_domain}"
  type    = "A"
  alias {
    name                   = local.cloudfront_redirect
    zone_id                = local.cloudfront_zone_id 
    evaluate_target_health = false
  }
  lifecycle {
    # prevent_destroy = true
  }
}

resource "aws_route53_record" "temporary_admin_record_validation" {
  zone_id = aws_route53_zone.temporary_admin_zone.zone_id
  name    = "${local.temporary_admin_domain_validation}"
  type    = "CNAME"
  ttl   = 60
  records = [
    local.temporary_admin_domain_validation_target
  ]
  lifecycle {
    # prevent_destroy = true
  }
}


# PRODUCTION
resource "aws_route53_zone" "zone" {
  name = local.domain

  tags = {
    "ithaka/environment" = "prod"
    "ithaka/owner"       = "jaip"
    "ithaka/business.unit" = "labs"
    "ithaka/app" = local.app_name
    app = local.app_name
  }

  lifecycle {
    prevent_destroy = true
  }
}

# This is the main record for the domain.
resource "aws_route53_record" "record" {
  zone_id = aws_route53_zone.zone.zone_id
  name    = "${local.domain}"
  type    = "A"
  ttl   = 60
  records = local.fastly_ips
  lifecycle {
    prevent_destroy = true
  }
}


# These are the production subdomains. They include the provider subdomain
# prefixed to the production subdomain, e.g., prod-subdomain-example.pep.jstor.org.
# The also include the admin subdomain.
resource "aws_route53_record" "prod_subdomains" {
  for_each = toset(local.prod_subdomains)
  zone_id = aws_route53_zone.zone.zone_id
  name    = each.key
  type    = "CNAME"
  ttl   = 60
  records = [
    local.fastly
  ]
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_record" "admin_record_validation" {
  zone_id = aws_route53_zone.zone.zone_id
  name    = "${local.admin_validation}"
  type    = "CNAME"
  ttl   = 60
  records = [
    local.admin_validation_target
  ]
  lifecycle {
    # prevent_destroy = true
  }
}
# TEST
resource "aws_route53_zone" "test_zone" {
  name = local.test_domain

  tags = {
    "ithaka/environment" = "test"
    "ithaka/owner"       = "jaip"
    "ithaka/business.unit" = "labs"
    "ithaka/app" = local.app_name
    app = local.app_name
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_route53_record" "test_record" {
  zone_id = aws_route53_zone.test_zone.zone_id
  name    = local.test_domain
  type    = "A"
  ttl   = 60
  records = local.fastly_ips
  # In general, we don't need to worry about destroying this record, but to 
  # keep things consistent with prod and to avoid accidents, we'll prevent
  # destroying it.
  # lifecycle {
  #   prevent_destroy = true
  # }
}

# These are the test provider subdomains. They include the provider subdomain 
# prefixed to the test subdomain, e.g., subdomain-example.test-pep.jstor.org.
resource "aws_route53_record" "test_subdomains" {
  for_each = toset(local.test_subdomains)
  zone_id = aws_route53_zone.test_zone.zone_id
  name    = each.key
  type    = "CNAME"
  ttl   = 60
  records = [
    local.fastly
  ]
  # lifecycle {
  #   prevent_destroy = true
  # }
}