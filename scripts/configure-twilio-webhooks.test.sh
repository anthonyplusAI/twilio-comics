#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/twilio-comics-webhooks-test.XXXXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/bin"
TWILIO_ACCOUNT_SID="AC$(printf '%032d' 1)"
export TWILIO_ACCOUNT_SID
different_account_sid="AC$(printf '%032d' 2)"

cat > "$test_root/bin/twilio" <<'TWILIO_MOCK'
#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-}"
shift || true
printf '%s\n' "$command_name $*" >> "$TWILIO_MOCK_LOG"

value_after() {
  local wanted="$1" previous='' item
  shift
  for item in "$@"; do
    if [[ "$previous" == "$wanted" ]]; then printf '%s\n' "$item"; return 0; fi
    previous="$item"
  done
  return 1
}

emit_fetch_response() {
  case "$1" in
    array) jq --slurp '.' "$TWILIO_MOCK_STATE" ;;
    object) cat "$TWILIO_MOCK_STATE" ;;
    empty-array) printf '[]\n' ;;
    ambiguous-array) jq --slurp '.[0] as $number | [$number, $number]' "$TWILIO_MOCK_STATE" ;;
    non-object-array) printf '[null]\n' ;;
    multiple-json-objects) cat "$TWILIO_MOCK_STATE" "$TWILIO_MOCK_STATE" ;;
    malformed-json) printf 'invalid-json https://private.example/path?token=do-not-leak\n' ;;
    *) printf 'Unexpected mock fetch shape: %s\n' "$1" >&2; exit 99 ;;
  esac
}

[[ "$(value_after --sid "$@")" == 'PN340b863b2059d85daeb2c3f81a5064c1' ]] || exit 90
[[ "$(value_after --account-sid "$@")" == "$TWILIO_ACCOUNT_SID" ]] || exit 91
[[ "$(value_after -p "$@")" == Demo ]] || exit 92
[[ "$(value_after -o "$@")" == json ]] || exit 93

case "$command_name" in
  api:core:incoming-phone-numbers:fetch)
    [[ "${TWILIO_MOCK_FETCH_FAIL:-}" != 1 ]] || exit 94
    fetch_shape="${TWILIO_MOCK_FETCH_SHAPE:-array}"
    if [[ -e "$TWILIO_MOCK_UPDATED_MARKER" ]]; then
      fetch_shape="${TWILIO_MOCK_VERIFY_SHAPE:-$fetch_shape}"
    fi
    emit_fetch_response "$fetch_shape"
    ;;
  api:core:incoming-phone-numbers:update)
    [[ "${TWILIO_MOCK_UPDATE_FAIL:-}" != 1 ]] || exit 95
    sms_url="$(value_after --sms-url "$@")"
    voice_url="$(value_after --voice-url "$@")"
    [[ "$(value_after --sms-method "$@")" == post ]] || exit 96
    [[ "$(value_after --voice-method "$@")" == post ]] || exit 97
    jq --arg sms "$sms_url" --arg voice "$voice_url" '
      .smsUrl = $sms | .voiceUrl = $voice | .smsMethod = "POST" | .voiceMethod = "POST"
    ' "$TWILIO_MOCK_STATE" > "$TWILIO_MOCK_STATE.next"
    mv "$TWILIO_MOCK_STATE.next" "$TWILIO_MOCK_STATE"
    if [[ "${TWILIO_MOCK_TAMPER_VERIFY:-}" == 1 ]]; then
      jq '.voiceMethod = "GET"' "$TWILIO_MOCK_STATE" > "$TWILIO_MOCK_STATE.next"
      mv "$TWILIO_MOCK_STATE.next" "$TWILIO_MOCK_STATE"
    fi
    : > "$TWILIO_MOCK_UPDATED_MARKER"
    cat "$TWILIO_MOCK_STATE"
    ;;
  *) printf 'Unexpected Twilio CLI call: %s\n' "$command_name" >&2; exit 98 ;;
esac
TWILIO_MOCK
chmod 700 "$test_root/bin/twilio"

cat > "$test_root/blank.json" <<JSON
{
  "accountSid": "$TWILIO_ACCOUNT_SID",
  "sid": "PN340b863b2059d85daeb2c3f81a5064c1",
  "phoneNumber": "+18669012028",
  "capabilities": { "voice": true, "sms": true, "mms": true },
  "smsUrl": "",
  "smsMethod": "POST",
  "voiceUrl": "",
  "voiceMethod": "POST",
  "smsApplicationSid": null,
  "voiceApplicationSid": null,
  "trunkSid": null,
  "smsFallbackUrl": "",
  "voiceFallbackUrl": "",
  "statusCallback": "",
  "voiceReceiveMode": "voice"
}
JSON

export PATH="$test_root/bin:$PATH"
export TWILIO_MOCK_STATE="$test_root/current.json"
export TWILIO_MOCK_LOG="$test_root/calls.log"
export TWILIO_MOCK_UPDATED_MARKER="$test_root/updated"
export PUBLIC_BASE_URL='https://comics.test-demo.org'
export TWILIO_PROFILE=Demo
export CONFIGURE_TWILIO_WEBHOOKS_CONFIRM=yes
script="$project_root/scripts/configure-twilio-webhooks.sh"

reset_state() {
  cp "$test_root/blank.json" "$TWILIO_MOCK_STATE"
  : > "$TWILIO_MOCK_LOG"
  rm -f "$TWILIO_MOCK_UPDATED_MARKER"
}

expect_rejected_without_update() {
  local label="$1"
  if bash "$script" > "$test_root/out" 2>&1; then
    printf 'Accepted unsafe %s\n' "$label" >&2
    exit 1
  fi
  if grep -Fq 'api:core:incoming-phone-numbers:update' "$TWILIO_MOCK_LOG"; then
    printf 'Updated number despite unsafe %s\n' "$label" >&2
    exit 1
  fi
}

reset_state
unset CONFIGURE_TWILIO_WEBHOOKS_CONFIRM
expect_rejected_without_update 'missing confirmation'
[[ ! -s "$TWILIO_MOCK_LOG" ]]
export CONFIGURE_TWILIO_WEBHOOKS_CONFIRM=yes

reset_state
(unset TWILIO_ACCOUNT_SID; expect_rejected_without_update 'missing account SID')
grep -Fq 'Set TWILIO_ACCOUNT_SID' "$test_root/out"
[[ ! -s "$TWILIO_MOCK_LOG" ]]

reset_state
(export TWILIO_ACCOUNT_SID='AC-invalid'; expect_rejected_without_update 'invalid account SID')
grep -Fq 'Set TWILIO_ACCOUNT_SID' "$test_root/out"
[[ ! -s "$TWILIO_MOCK_LOG" ]]

for invalid_origin in 'http://comics.test-demo.org' 'https://localhost' \
    'https://comics.test-demo.org/path' 'https://comics.test-demo.org#frag' \
    'https://user:pass@comics.test-demo.org' 'https://1.2.3.4'; do
  reset_state
  PUBLIC_BASE_URL="$invalid_origin" expect_rejected_without_update "origin $invalid_origin"
  [[ ! -s "$TWILIO_MOCK_LOG" ]]
done

reset_state
bash "$script" > "$test_root/first.out" 2>&1
grep -Fq 'Verified SMS and Voice POST webhooks' "$test_root/first.out"
jq --exit-status '
  .smsUrl == "https://comics.test-demo.org/api/twilio/sms#rc=3&rp=5xx,ct,rt"
  and .voiceUrl == "https://comics.test-demo.org/api/twilio/voice#rc=3&rp=5xx,ct,rt"
  and .smsMethod == "POST" and .voiceMethod == "POST"
' "$TWILIO_MOCK_STATE" >/dev/null
[[ "$(grep -Fc 'api:core:incoming-phone-numbers:update' "$TWILIO_MOCK_LOG")" == 1 ]]
[[ "$(grep -Fc 'api:core:incoming-phone-numbers:fetch' "$TWILIO_MOCK_LOG")" == 2 ]]

bash "$script" > "$test_root/repeat.out" 2>&1
[[ "$(grep -Fc 'api:core:incoming-phone-numbers:update' "$TWILIO_MOCK_LOG")" == 1 ]]
grep -Fq 'already configured' "$test_root/repeat.out"

reset_state
TWILIO_MOCK_FETCH_SHAPE=object TWILIO_MOCK_VERIFY_SHAPE=array \
  bash "$script" > "$test_root/legacy-object.out" 2>&1
grep -Fq 'Verified SMS and Voice POST webhooks' "$test_root/legacy-object.out"
[[ "$(grep -Fc 'api:core:incoming-phone-numbers:fetch' "$TWILIO_MOCK_LOG")" == 2 ]]

for fetch_shape in empty-array ambiguous-array non-object-array \
    multiple-json-objects malformed-json; do
  reset_state
  TWILIO_MOCK_FETCH_SHAPE="$fetch_shape" \
    expect_rejected_without_update "CLI $fetch_shape"
  grep -Fq 'Twilio CLI returned' "$test_root/out"
  if grep -Fq 'do-not-leak' "$test_root/out"; then
    printf 'Leaked private webhook data from malformed CLI output\n' >&2
    exit 1
  fi
done

reset_state
if TWILIO_MOCK_VERIFY_SHAPE=ambiguous-array \
    bash "$script" > "$test_root/ambiguous-verify.out" 2>&1; then
  printf 'Accepted an ambiguous post-update fetch\n' >&2
  exit 1
fi
grep -Fq 'Twilio CLI returned' "$test_root/ambiguous-verify.out"
[[ "$(grep -Fc 'api:core:incoming-phone-numbers:update' "$TWILIO_MOCK_LOG")" == 1 ]]
[[ "$(grep -Fc 'api:core:incoming-phone-numbers:fetch' "$TWILIO_MOCK_LOG")" == 2 ]]

for scenario in wrong-account wrong-number wrong-sid missing-sms missing-voice \
    unexpected-sms unexpected-voice sms-app voice-app trunk \
    sms-fallback voice-fallback status-callback fax-mode \
    missing-sms-url-field invalid-sms-method; do
  reset_state
  case "$scenario" in
    wrong-account) expression=".accountSid = \$different_account" ;;
    wrong-number) expression='.phoneNumber = "+15551234567"' ;;
    wrong-sid) expression='.sid = "PN00000000000000000000000000000000"' ;;
    missing-sms) expression='.capabilities.sms = false' ;;
    missing-voice) expression='.capabilities.voice = false' ;;
    unexpected-sms) expression='.smsUrl = "https://other.invalid/sms"' ;;
    unexpected-voice) expression='.voiceUrl = "https://other.invalid/voice"' ;;
    sms-app) expression='.smsApplicationSid = "AP00000000000000000000000000000000"' ;;
    voice-app) expression='.voiceApplicationSid = "AP00000000000000000000000000000000"' ;;
    trunk) expression='.trunkSid = "TK00000000000000000000000000000000"' ;;
    sms-fallback) expression='.smsFallbackUrl = "https://other.invalid/sms-fallback"' ;;
    voice-fallback) expression='.voiceFallbackUrl = "https://other.invalid/voice-fallback"' ;;
    status-callback) expression='.statusCallback = "https://other.invalid/status"' ;;
    fax-mode) expression='.voiceReceiveMode = "fax"' ;;
    missing-sms-url-field) expression='del(.smsUrl)' ;;
    invalid-sms-method) expression='.smsMethod = "PUT"' ;;
  esac
  jq --arg different_account "$different_account_sid" "$expression" "$TWILIO_MOCK_STATE" > "$test_root/modified.json"
  mv "$test_root/modified.json" "$TWILIO_MOCK_STATE"
  expect_rejected_without_update "$scenario"
done

reset_state
TWILIO_MOCK_FETCH_FAIL=1 expect_rejected_without_update 'failed fetch'

reset_state
if TWILIO_MOCK_UPDATE_FAIL=1 bash "$script" > "$test_root/update-fail.out" 2>&1; then
  printf 'Accepted a failed Twilio update\n' >&2
  exit 1
fi
jq --exit-status '.smsUrl == "" and .voiceUrl == ""' "$TWILIO_MOCK_STATE" >/dev/null

reset_state
if TWILIO_MOCK_TAMPER_VERIFY=1 bash "$script" > "$test_root/tamper.out" 2>&1; then
  printf 'Accepted a failed post-update verification\n' >&2
  exit 1
fi
grep -Fq 'post-update' "$test_root/tamper.out"

reset_state
jq --arg sms 'https://comics.test-demo.org/api/twilio/sms#rc=3&rp=5xx,ct,rt' \
   --arg voice 'https://comics.test-demo.org/api/twilio/voice#rc=3&rp=5xx,ct,rt' \
   '.smsUrl = $sms | .voiceUrl = $voice | .smsMethod = "GET" | .voiceMethod = "GET"' \
   "$TWILIO_MOCK_STATE" > "$test_root/modified.json"
mv "$test_root/modified.json" "$TWILIO_MOCK_STATE"
bash "$script" > "$test_root/methods.out" 2>&1
jq --exit-status '.smsMethod == "POST" and .voiceMethod == "POST"' "$TWILIO_MOCK_STATE" >/dev/null
[[ "$(grep -Fc 'api:core:incoming-phone-numbers:update' "$TWILIO_MOCK_LOG")" == 1 ]]

printf 'Twilio webhook cutover mock tests passed.\n'
