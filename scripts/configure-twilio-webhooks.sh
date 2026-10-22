#!/usr/bin/env bash
set -euo pipefail
set +x # Twilio may return webhook URLs with private query values.

# Cut over only the approved SMS and Voice number. This script never changes
# channel availability in the app or reads the Twilio Auth Token.
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in twilio jq python3; do
  command -v "$command" >/dev/null 2>&1 || die "Install '$command' before configuring webhooks."
done

ACCOUNT_SID="${TWILIO_ACCOUNT_SID:-}"
NUMBER_SID='PN340b863b2059d85daeb2c3f81a5064c1'
PHONE_NUMBER='+18669012028'
PROFILE="${TWILIO_PROFILE:-Demo}"

[[ "${CONFIGURE_TWILIO_WEBHOOKS_CONFIRM:-}" == yes ]] \
  || die 'Set CONFIGURE_TWILIO_WEBHOOKS_CONFIRM=yes after reviewing the cutover.'
[[ "$ACCOUNT_SID" =~ ^AC[[:xdigit:]]{32}$ ]] \
  || die 'Set TWILIO_ACCOUNT_SID to the approved account SID (AC followed by 32 hexadecimal characters).'
[[ "$PROFILE" =~ ^[A-Za-z0-9_-]{1,64}$ ]] \
  || die 'TWILIO_PROFILE must be a simple CLI profile name.'
: "${PUBLIC_BASE_URL:?Set PUBLIC_BASE_URL to the final public HTTPS origin}"

# A webhook URL is signed as received. Require one unambiguous public origin,
# matching the app's PUBLIC_BASE_URL, before adding any path or retry fragment.
origin="$(python3 - "$PUBLIC_BASE_URL" <<'PY'
import ipaddress
import re
import sys
from urllib.parse import urlsplit

value = sys.argv[1]
try:
    url = urlsplit(value)
    host = url.hostname
    if not value.startswith("https://") or url.scheme != "https" or not host:
        raise ValueError("use an HTTPS origin")
    if url.username or url.password or url.path or url.query or url.fragment:
        raise ValueError("omit credentials, path, query, and fragment")
    if url.port not in (None, 443) or url.netloc != host + (":443" if url.port else ""):
        raise ValueError("use a lowercase DNS name on HTTPS port 443")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError("use a public DNS name, not an IP address")
    labels = host.split(".")
    if len(labels) < 2 or any(
        not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
        for label in labels
    ):
        raise ValueError("use a valid public DNS name")
    if host in {"example.com", "example.net", "example.org"} or labels[-1] in {
        "localhost", "local", "internal", "invalid", "test", "example", "onion", "lan"
    }:
        raise ValueError("use the deployed domain, not a placeholder or private domain")
except (ValueError, UnicodeError) as error:
    print(f"ERROR: Invalid PUBLIC_BASE_URL: {error}", file=sys.stderr)
    sys.exit(1)
print(value)
PY
)" || die 'Correct PUBLIC_BASE_URL before configuring webhooks.'

sms_url="${origin}/api/twilio/sms#rc=3&rp=5xx,ct,rt"
voice_url="${origin}/api/twilio/voice#rc=3&rp=5xx,ct,rt"

umask 077
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-webhooks.XXXXXXXX")"
trap 'rm -rf -- "$temp_dir"' EXIT

fetch_number() {
  local raw="$temp_dir/fetch-raw.json"
  twilio api:core:incoming-phone-numbers:fetch \
    --sid "$NUMBER_SID" --account-sid "$ACCOUNT_SID" \
    -p "$PROFILE" -o json -l error > "$raw" \
    || die 'Twilio CLI could not inspect the approved number. Check the selected profile.'
  # The CLI can return either one object or a one-element array. Slurp first
  # so multiple JSON documents are rejected as well as ambiguous arrays.
  jq --exit-status --slurp '
    if length != 1 then empty
    elif (.[0] | type) == "object" then .[0]
    elif (.[0] | type) == "array"
      and (.[0] | length) == 1
      and (.[0][0] | type) == "object" then .[0][0]
    else empty
    end
  ' "$raw" > "$1" 2>/dev/null \
    || die 'Twilio CLI returned a number response that is not exactly one object; inspect the number before proceeding.'
}

validate_number() {
  jq --exit-status \
    --arg account "$ACCOUNT_SID" --arg sid "$NUMBER_SID" --arg phone "$PHONE_NUMBER" '
    type == "object"
    and .accountSid == $account
    and .sid == $sid
    and .phoneNumber == $phone
    and (.capabilities | type == "object")
    and ((.capabilities.sms // .capabilities.SMS) == true)
    and ((.capabilities.voice // .capabilities.Voice) == true)
  ' "$1" >/dev/null \
    || die 'Twilio returned a different account, number, or SMS/Voice capability; no webhook was changed.'
}

validate_existing_hooks() {
  local unexpected
  jq --exit-status '
    . as $number
    | all([
        "smsUrl", "voiceUrl", "smsMethod", "voiceMethod",
        "smsApplicationSid", "voiceApplicationSid", "trunkSid",
        "smsFallbackUrl", "voiceFallbackUrl", "statusCallback", "voiceReceiveMode"
      ][]; . as $field | $number | has($field))
  ' "$1" >/dev/null \
    || die 'Twilio returned incomplete number settings; no webhook was changed.'
  unexpected="$(jq -r --arg sms "$sms_url" --arg voice "$voice_url" '
    [
      (if (.smsUrl // "") != "" and .smsUrl != $sms then "SMS URL" else empty end),
      (if (.voiceUrl // "") != "" and .voiceUrl != $voice then "Voice URL" else empty end),
      (if (.smsApplicationSid // "") != "" then "SMS TwiML app" else empty end),
      (if (.voiceApplicationSid // "") != "" then "Voice TwiML app" else empty end),
      (if (.trunkSid // "") != "" then "SIP trunk" else empty end),
      (if (.smsFallbackUrl // "") != "" then "SMS fallback URL" else empty end),
      (if (.voiceFallbackUrl // "") != "" then "Voice fallback URL" else empty end),
      (if (.statusCallback // "") != "" then "number status callback" else empty end),
      (if (.voiceReceiveMode // "voice") != "voice" then "Voice receive mode" else empty end),
      (if (.smsMethod // "POST" | ascii_downcase | IN("get", "post") | not) then "SMS method" else empty end),
      (if (.voiceMethod // "POST" | ascii_downcase | IN("get", "post") | not) then "Voice method" else empty end)
    ] | join(", ")
  ' "$1")" || die 'Twilio returned malformed webhook settings; no webhook was changed.'
  [[ -z "$unexpected" ]] \
    || die "Existing number configuration needs review ($unexpected); no webhook was changed."
}

configured() {
  jq --exit-status --arg sms "$sms_url" --arg voice "$voice_url" '
    .smsUrl == $sms and .voiceUrl == $voice
    and (.smsMethod | ascii_downcase) == "post"
    and (.voiceMethod | ascii_downcase) == "post"
  ' "$1" >/dev/null
}

fetch_number "$temp_dir/before.json"
validate_number "$temp_dir/before.json"
validate_existing_hooks "$temp_dir/before.json"

if configured "$temp_dir/before.json"; then
  printf 'Twilio SMS and Voice webhooks are already configured for %s.\n' "$PHONE_NUMBER"
  exit 0
fi

printf 'Configuring SMS and Voice POST webhooks for %s through Twilio profile %s.\n' \
  "$PHONE_NUMBER" "$PROFILE"
twilio api:core:incoming-phone-numbers:update \
  --sid "$NUMBER_SID" --account-sid "$ACCOUNT_SID" \
  -p "$PROFILE" -o json -l error \
  --sms-url "$sms_url" --sms-method POST \
  --voice-url "$voice_url" --voice-method POST \
  > "$temp_dir/update.json" \
  || die 'Twilio rejected the webhook update. Review the number without retrying blindly.'

fetch_number "$temp_dir/after.json"
validate_number "$temp_dir/after.json"
validate_existing_hooks "$temp_dir/after.json"
configured "$temp_dir/after.json" \
  || die 'Twilio post-update verification did not return the exact SMS and Voice POST URLs.'

printf 'Verified SMS and Voice POST webhooks on %s. App channel availability was not changed.\n' \
  "$PHONE_NUMBER"
