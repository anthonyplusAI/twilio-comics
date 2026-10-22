# Azure cost estimate

The running SMS and Voice V2 pilot should cost roughly **$40–$86 per 30-day month in Azure** at low usage. The always-on database accounts for about $18 even with no users. This is a planning estimate, not a spending limit or a quote for this subscription. Twilio and OpenAI usage are billed separately. The current public release is `e2bafc6` at [the V2 origin](https://twilio-comics-v2.kindriver-a0456aa8.eastus2.azurecontainerapps.io), with `TWILIO_ENABLED_CHANNELS=sms,voice`; WhatsApp is disabled. Real handset generation/delivery and admin sign-in remain unverified.

The numbers below use **East US 2 for Container Apps, Storage, and ACR; Central US for PostgreSQL**, USD pay-as-you-go retail prices checked October 21, 2026, a 30-day month (720 hours), and the sizes in [`infra/private-platform.bicep`](../infra/private-platform.bicep), [`scripts/provision-azure.sh`](../scripts/provision-azure.sh), and [the release workflow](../.github/workflows/deploy.yml). Actual invoices can differ because of contract pricing, credits, taxes, subscription-wide free allowances, job duration, and traffic. Unit rates came from Microsoft's [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) at `https://prices.azure.com/api/retail/prices`, filtered for `armRegionName eq 'centralus'` for database meters and `armRegionName eq 'eastus2'` for the app meters. Recheck the meters before changing capacity.

## Low-traffic assumptions and monthly bill

| Resource and assumption | Retail-rate calculation | Estimated month |
| --- | ---: | ---: |
| [PostgreSQL Flexible Server](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/) `Standard_B1ms` in Central US, always on | $0.01921/hour × 720 hours | $13.83 |
| PostgreSQL provisioned storage in Central US, 32 GB | $0.13/GB-month × 32 GB | $4.16 |
| PostgreSQL 14-day locally redundant backup | Included up to the provisioned 32 GB of backup storage; excess is billed separately | $0 at low write volume |
| [Container Apps](https://azure.microsoft.com/en-us/pricing/details/container-apps/) public app, one 0.5-vCPU/1-GiB replica running all month | $0.000003/vCPU-second while idle or $0.000024 active, plus $0.000003/GiB-second | $11.66 idle to $38.88 fully active |
| Recovery Job, 1 vCPU/2 GiB every five minutes | 8,640 runs × 10–30 seconds × $0.000030/second | $2.59–$7.78 |
| Generation Job, 1 vCPU/2 GiB, 100 comics taking two minutes each | 100 × 120 seconds × $0.000030/second | $0.36 |
| [Container Registry](https://azure.microsoft.com/en-us/pricing/details/container-registry/) Basic | $0.1666/day × 30 days; first 10 GB of image storage included | $5.00 |
| [Blob and Queue Storage](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/) Standard LRS, 5 GB of Hot blobs and light [queue traffic](https://azure.microsoft.com/en-us/pricing/details/storage/queues/) | Hot blobs $0.0184/GB-month; operations add cents | Under $1 |
| [Log Analytics](https://azure.microsoft.com/en-us/pricing/details/monitor/), 0–5 **billable** GB of Analytics Logs | $2.76/GB ingested; longer retention can add charges | $0–$13.80 |
| [Private DNS zone](https://azure.microsoft.com/en-us/pricing/details/dns/) and [Key Vault](https://azure.microsoft.com/en-us/pricing/details/key-vault/) | About $0.50/zone-month and $0.03/10,000 standard secret operations | Around $1 |
| [Global VNet peering](https://azure.microsoft.com/en-us/pricing/details/virtual-network/) between the East US 2 app and Central US database VNets | About $0.035/GB at the sending VNet plus $0.035/GB at the receiving VNet | Under $0.07 for under 1 GB one-way |

**Total: about $40–$86/month.** The web estimate spans a continuously idle replica through one continuously active replica; a low-traffic app should be nearer the idle side. It assumes each empty recovery sweep finishes in 10–30 seconds, and no second web replica stays up for long. An additional always-active web replica for a full month would add about $39. Azure charges Container Apps Jobs only while executions run. The first 180,000 vCPU-seconds, 360,000 GiB-seconds, and 2 million requests per month are free **per subscription**; the estimate does not rely on that shared allowance. [Container Apps billing](https://learn.microsoft.com/en-us/azure/container-apps/billing) explains idle rates, Jobs, free grants, and when a management fee applies.

The V2 environment uses the Consumption workload profile, with no Dedicated profile or Container Apps private endpoint, so it has no $0.10/hour Dedicated management charge. The [VNets themselves are free](https://azure.microsoft.com/en-us/pricing/details/virtual-network/); cross-region peering charges for traffic in both directions. At the estimated Zone 1 global-peering rate, 10 GB transferred in one direction adds about $0.70; traffic returning in the other direction is metered too. The PostgreSQL private DNS zone has the small charge above. The older placeholder public app has been set to **minimum zero replicas**. It adds no idle replica compute while asleep, although requests that wake it are billable. Keep it at zero and retire it after the V2 handset and admin checks pass.

The database retains app and admin history across image deployments. Its 14-day backup setting is for point-in-time recovery, not the history retention policy. Azure includes backup storage up to the provisioned database size; frequent writes can push backups above that allowance. [PostgreSQL backup billing](https://learn.microsoft.com/en-gb/azure/postgresql/backup-restore/concepts-backup-restore) explains the allowance and write-ahead-log effect. Storage autogrow is enabled; a larger provisioned size raises the monthly storage charge and [cannot be reduced in place](https://learn.microsoft.com/en-us/azure/postgresql/scale/concepts-scaling-resources). Microsoft currently gives pay-as-you-go Analytics Logs a [5-GB monthly free allowance per billing account](https://learn.microsoft.com/en-us/azure/azure-monitor/app/application-insights-faq), which may already be used by other apps.

Internet egress from North America currently has the [first 100 GB/month free](https://azure.microsoft.com/en-us/pricing/details/bandwidth/) and is about $0.087/GB for the next 10 TB on the Microsoft network. This allowance can be shared with other Azure traffic. A busy comic download or MMS media endpoint can eventually make egress visible on the bill.

## How Azure cost changes with usage

These are independent examples using the same retail meters; they are **not** a forecast of user demand. The code default `DAILY_GENERATION_JOB_LIMIT=25` admits at most 25 app-funded comic requests per UTC day. The configured pilot setting of `5` admits at most 150 in a 30-day month, so the 1,000- and 10,000-job examples require a deliberately higher limit:

| Change | Approximate Azure effect |
| --- | ---: |
| 1,000 comics/month, each generation Job running two minutes | $3.60/month for that Job |
| 10,000 comics/month with the same two-minute Job duration | $36/month for that Job |
| Second 0.5-vCPU/1-GiB web replica active all month | Add $38.88/month |
| Pilot 5 admitted requests/day, if all are channel Jobs running two minutes | Up to $0.54/month for 150 Job executions in a 30-day month |
| Move PostgreSQL to a larger Burstable or General Purpose SKU | Reprice Central US compute; the database may become the largest Azure line item |
| Store 100 GB of Hot LRS comic images | About $1.84/month for blob capacity, plus transactions and egress |
| Ingest 20 **billable** GB of Analytics Logs | About $55.20/month, plus retention beyond the included period |

The current deployment caps the public app at two replicas and the generation Job at one concurrent execution. At higher demand, price a larger database, more Blob and log storage, and actual cross-region traffic before raising those limits. `Standard_B1ms` has one vCore and 2 GiB of memory; Microsoft's [compute guidance](https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-compute) describes Burstable capacity as a fit for intermittent, low-concurrency loads and warns that sustained CPU use can exhaust credits. Monitor credits, connections, and query latency. [PostgreSQL compute changes briefly restart the server](https://learn.microsoft.com/en-us/azure/postgresql/scale/concepts-scaling-resources).

## Twilio and OpenAI are separate bills

The Azure total above does not include the channel or AI usage. At Twilio's published US list rates, [toll-free SMS](https://www.twilio.com/en-us/sms/pricing/us) is $0.0083 per inbound or outbound segment, outbound MMS is $0.022, and inbound MMS is $0.020, before applicable carrier fees. A US toll-free inbound [Voice](https://www.twilio.com/en-us/voice/pricing/us) call is $0.022/minute, and [Conversation Relay](https://www.twilio.com/en-us/products/conversational-ai/pricing) adds $0.070/minute. A five-minute call is therefore about **$0.46 for Voice plus Relay**, before verification, SMS comic delivery, AI, and any contract-specific adjustments. The toll-free number also has a monthly number charge. [Verify](https://www.twilio.com/en-us/verify/pricing) adds its fee for a successful caller verification plus SMS delivery charges; failed or expired attempts can still incur delivery charges.

The app defaults to OpenAI `gpt-image-2` for comic images and a text model for dialogue and titles. [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) depends on model, image size and quality, prompt/reference inputs, output tokens, and generated page count. Use the [image generation cost guide](https://developers.openai.com/api/docs/guides/image-generation) and actual API usage before setting a per-comic price or cap. At scale, Twilio and OpenAI charges can exceed Azure hosting.

`DAILY_GENERATION_JOB_LIMIT` counts **new app-funded comic requests admitted each UTC day**, across all users and SMS, WhatsApp, Voice, and browser studio tests using the app's OpenAI key. Its code default is 25; the current pilot value is 5, and `0` pauses app-funded generation. Duplicate queue delivery and a retry of the same channel job consume one slot, while a failed job still occupies its original day's slot. A job can make up to three image-generation attempts before terminal failure. Studio requests made with a caller-owned API key do not use app-funded capacity.

| Pilot control | Code default | Launch value | Runtime placement | What it limits |
| --- | ---: | ---: | --- | --- |
| `DAILY_GENERATION_JOB_LIMIT` | 25 | 5 | V2 web app, generation Job, recovery Job | New app-funded comic admissions per UTC day |
| `MESSAGE_AGENT_GLOBAL_DAILY_LIMIT` | 200 | 50 | V2 generation Job | SMS and WhatsApp agent turns across all phones per rolling 24 hours |
| `VOICE_VERIFY_NUMBER_DAILY_LIMIT` | 40 | 4 | V2 web app | Verify SMS starts across the Twilio number per rolling 24 hours |

The runtime setup script initially requires and sets `DAILY_GENERATION_JOB_LIMIT=25`; the deployed pilot values were applied **after** it finished. The other two settings are runtime overrides. These controls reduce exposure to model and Verify usage, but they are **not provider spending ceilings**: inbound messages, voice minutes, Relay speech, delivery texts, model retries, and other calls can still incur charges. See [runtime placement and verification](INFRA_SETUP.md#configure-v2-runtime-before-the-first-release). Set provider-side budget alerts as well.

## Cost controls for launch

1. The **`twilio-comics-launch` $150 monthly Azure budget** is created at the `rg-twilio-comics` resource-group scope. It sends actual-cost alerts at 50%, 80%, and 100%, plus a forecast alert at 100%, to `adellavecchia@twilio.com`. It includes legacy placeholder resources in that group. [Budgets notify but never stop consumption](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets); cost data usually arrives 8–24 hours later and budgets are evaluated daily. The budget excludes Twilio and OpenAI charges, which need their own alerts or limits.
2. Measure B1ms CPU credits, memory, connections, and query latency after the first live traffic. Increase compute before sustained load exhausts burst credits; keep the V2 web replica warm for Twilio webhooks and ConversationRelay. Changing compute may briefly interrupt database connections.
3. Watch recovery Job execution time and failures. If every five-minute run lasted the configured 900-second timeout, its execution bill could approach **$233/month**. Investigate slow sweeps or repeated failures immediately; shorten the timeout only after measuring normal and backlog runs.
4. Watch Log Analytics ingestion, PostgreSQL **Backup Storage Used**, database storage autogrow, ACR image storage above its included 10 GB, and Blob usage. Keep operational logs useful and bounded. Retain user history and finished comics under the app's deletion policy; remove only abandoned temporary uploads and old unreferenced container images after the rollback window.
5. Review actual cost by resource group and service after the first full week and month, then adjust the estimate. Keep the database and its backups running while live admin history must remain available.
