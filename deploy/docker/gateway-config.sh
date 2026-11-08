#!/bin/sh
# Prints bifrost.json, the config of the bundled AI gateway (compose.gateway.yml), from the
# settings in an .env file. install.sh runs it on each install:
#
#   sh ./gateway-config.sh .env >bifrost.json
#
# The file holds no secret: every key, password and credential is an env.<NAME> reference that
# Bifrost reads from its own container environment. A provider is listed only when its keys are
# set in .env, so an empty key never reaches Bifrost. Teams, virtual keys and budgets are not
# here: the selfhost server writes them through Bifrost's API from selfhost.toml.
set -eu

env_file=${1:-.env}
[ -f "$env_file" ] || {
  echo "gateway-config.sh: no $env_file" >&2
  exit 1
}
value() { sed -n "s/^$1=//p" "$env_file" | tail -n 1; }
set_in() { [ -n "$(value "$1")" ]; }
# A region goes in the file as it is, so it may hold only these characters.
region() {
  r=$(value "$1")
  case "$r" in
    '' | *[!a-z0-9-]*)
      echo "gateway-config.sh: $1 must be a region like us-east-1, got \"$r\"" >&2
      exit 1
      ;;
  esac
  printf '%s' "$r"
}

providers=""
add() { providers="${providers:+$providers,
}    \"$1\": { \"keys\": [$2] }"; }
key() { printf '{ "name": "%s", "models": ["*"], "weight": 1%s }' "$1" "$2"; }

if set_in ANTHROPIC_API_KEY; then
  add anthropic "$(key anthropic ', "value": "env.ANTHROPIC_API_KEY"')"
fi
if set_in OPENAI_API_KEY; then
  add openai "$(key openai ', "value": "env.OPENAI_API_KEY"')"
fi
if set_in FIREWORKS_API_KEY; then
  add fireworks "$(key fireworks ', "value": "env.FIREWORKS_API_KEY"')"
fi
if set_in AWS_ACCESS_KEY_ID && set_in AWS_SECRET_ACCESS_KEY; then
  aws_region=$(region AWS_REGION)
  add bedrock "$(key bedrock ", \"bedrock_key_config\": { \"access_key\": \"env.AWS_ACCESS_KEY_ID\", \"secret_key\": \"env.AWS_SECRET_ACCESS_KEY\", \"region\": \"$aws_region\" }")"
fi
if set_in AZURE_API_KEY && set_in AZURE_ENDPOINT; then
  add azure "$(key azure ', "value": "env.AZURE_API_KEY", "azure_key_config": { "endpoint": "env.AZURE_ENDPOINT" }')"
fi
if set_in VERTEX_PROJECT_ID && set_in VERTEX_CREDENTIALS; then
  vertex_region=$(region VERTEX_REGION)
  add vertex "$(key vertex ", \"vertex_key_config\": { \"project_id\": \"env.VERTEX_PROJECT_ID\", \"region\": \"$vertex_region\", \"auth_credentials\": \"env.VERTEX_CREDENTIALS\" }")"
fi

store='{
      "host": "postgres",
      "port": "5432",
      "user": "env.BIFROST_DB_USER",
      "password": "env.BIFROST_DB_PASSWORD",
      "db_name": "bifrost",
      "ssl_mode": "disable"
    }'

cat <<JSON
{
  "encryption_key": "env.SELFHOST_GATEWAY_ENCRYPTION_KEY",
  "client": {
    "enforce_auth_on_inference": true,
    "allow_direct_keys": false,
    "enable_logging": true,
    "disable_content_logging": true,
    "log_retention_days": 30,
    "logging_headers": ["user-agent"]
  },
  "governance": {
    "auth_config": {
      "is_enabled": true,
      "admin_username": "selfhost",
      "admin_password": "env.SELFHOST_GATEWAY_ADMIN_KEY"
    }
  },
  "config_store": { "enabled": true, "type": "postgres", "config": $store },
  "logs_store": { "enabled": true, "type": "postgres", "config": $store },
  "providers": {
$providers
  }
}
JSON
