#!/usr/bin/env bash
set -euo pipefail

command -v jq >/dev/null || {
  echo 'jq is required to check the generation Job configuration.' >&2
  exit 1
}

# Read ACA Job metadata from stdin without printing it. In particular, never
# expose an accidentally inline DUB_API_KEY value in a deployment log.
status="$(jq -r '
  def nonblank:
    if type == "string" then (gsub("^\\s+|\\s+$"; "") | length > 0)
    else false end;

  (.properties.template.containers // []) as $containers
  | (.properties.configuration.secrets // []) as $secrets
  | if ($containers | type) != "array" or ($containers | length) != 1
       or ($secrets | type) != "array" then "invalid"
    else
      ($containers[0].env // []) as $env
      | if ($env | type) != "array" then "invalid"
        else
          ([$env[] | select(.name == "DUB_API_KEY")]) as $key
          | ([$env[] | select(.name == "DUB_DOMAIN")]) as $domain
          | ([$env[] | select(.name == "DUB_FOLDER_ID")]) as $folder
          | (($key | length) + ($domain | length) + ($folder | length)) as $count
          | if $count == 0 then "absent"
            elif ($key | length) == 1 and ($domain | length) == 1
                 and ($folder | length) == 1
                 and ($key[0].secretRef | nonblank)
                 and ($key[0].value == null)
                 and ($domain[0].value | nonblank)
                 and ($folder[0].value | nonblank)
                 and ([ $secrets[] | select(.name == $key[0].secretRef) ] | length) == 1
            then "present"
            else "invalid" end
        end
    end
' 2>/dev/null)" || {
  echo 'Could not inspect the generation Job Dub configuration.' >&2
  exit 1
}

case "$status" in
  absent)
    echo 'Dub is not configured on the generation Job; canonical comic links will be used.'
    ;;
  present)
    echo 'Dub generation Job configuration is complete.'
    ;;
  *)
    echo 'Incomplete or unsafe Dub generation Job configuration. Set DUB_API_KEY through an ACA secretRef and set nonempty DUB_DOMAIN and DUB_FOLDER_ID values, or remove all three.' >&2
    exit 1
    ;;
esac
