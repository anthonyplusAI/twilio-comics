# Azure cost estimate

An early SMS and Voice launch on the planned V2 architecture should cost roughly **$75–$120 per 30-day month in Azure** at low usage. The database accounts for about $53 of that even with no users. This is a planning estimate, not a spending limit or a quote for this subscription. Twilio and OpenAI usage are billed separately.

The numbers below use **East US 2, USD pay-as-you-go retail prices checked October 21, 2026**, a 30-day month (720 hours), and the sizes in [`infra/private-platform.bicep`](../infra/private-platform.bicep), [`scripts/provision-azure.sh`](../scripts/provision-azure.sh), and [the release workflow](../.github/workflows/deploy.yml). Actual invoices can differ because of contract pricing, credits, taxes, subscription-wide free allowances, job duration, and traffic. Unit rates came from Microsoft's [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) at `https://prices.azure.com/api/retail/prices`, filtered for `armRegionName eq 'eastus2'` and the product or meter named in each row. Recheck those meters before changing capacity.

## Low-traffic assumptions and monthly bill

| Resource and assumption | Retail-rate calculation | Estimated month |
| --- | ---: | ---: |
| [PostgreSQL Flexible Server](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/) `Standard_B2s`, always on | $0.068/hour × 720 hours | $48.96 |
| PostgreSQL provisioned storage, 32 GB | $0.115/GB-month × 32 GB | $3.68 |
| PostgreSQL 14-day locally redundant backup | Included up to the provisioned 32 GB of backup storage; excess is $0.095/GB-month | $0 at low write volume |
| [Container Apps](https://azure.microsoft.com/en-us/pricing/details/container-apps/) public app, one 0.5-vCPU/1-GiB replica running all month | $0.000003/vCPU-second while idle or $0.000024 active, plus $0.000003/GiB-second | $11.66 idle to $38.88 fully active |
| Recovery Job, 1 vCPU/2 GiB every five minutes | 8,640 runs × 10–30 seconds × $0.000030/second | $2.59–$7.78 |
| Generation Job, 1 vCPU/2 GiB, 100 comics taking two minutes each | 100 × 120 seconds × $0.000030/second | $0.36 |
| [Container Registry](https://azure.microsoft.com/en-us/pricing/details/container-registry/) Basic | $0.1666/day × 30 days; first 10 GB of image storage included | $5.00 |
| [Blob and Queue Storage](https://azure.microsoft.com/en-us/pricing/details/storage/blobs/) Standard LRS, 5 GB of Hot blobs and light [queue traffic](https://azure.microsoft.com/en-us/pricing/details/storage/queues/) | Hot blobs $0.0184/GB-month; operations add cents | Under $1 |
| [Log Analytics](https://azure.microsoft.com/en-us/pricing/details/monitor/), 0–5 **billable** GB of Analytics Logs | $2.76/GB ingested; longer retention can add charges | $0–$13.80 |
| [Private DNS zone](https://azure.microsoft.com/en-us/pricing/details/dns/) and [Key Vault](https://azure.microsoft.com/en-us/pricing/details/key-vault/) | About $0.50/zone-month and $0.03/10,000 standard secret operations | Around $1 |

**Total: about $75–$120/month.** The web estimate spans a continuously idle replica through one continuously active replica; a low-traffic app should be nearer the idle side. It assumes each empty recovery sweep finishes in 10–30 seconds, and no second web replica stays up for long. An additional always-active web replica for a full month would add about $39. Azure charges Container Apps Jobs only while executions run. The first 180,000 vCPU-seconds, 360,000 GiB-seconds, and 2 million requests per month are free **per subscription**; the estimate does not rely on that shared allowance. [Container Apps billing](https://learn.microsoft.com/en-us/azure/container-apps/billing) explains idle rates, Jobs, free grants, and when a management fee applies.

The V2 environment uses the Consumption workload profile, with no Dedicated profile or Container Apps private endpoint, so it has no $0.10/hour Dedicated management charge. The [VNet itself is free](https://azure.microsoft.com/en-us/pricing/details/virtual-network/); its PostgreSQL private DNS zone has the small charge above. The older placeholder public app has been set to **minimum zero replicas**. It adds no idle replica compute while asleep, although requests that wake it are billable. Keep it at zero and retire it after a verified V2 cutover.

The database retains app and admin history across image deployments. Its 14-day backup setting is for point-in-time recovery, not the history retention policy. Azure includes backup storage up to the provisioned database size; frequent writes can push backups above that allowance. [PostgreSQL backup billing](https://learn.microsoft.com/en-gb/azure/postgresql/backup-restore/concepts-backup-restore) explains the allowance and write-ahead-log effect. Storage autogrow is enabled; a larger provisioned size raises the monthly storage charge and [cannot be reduced in place](https://learn.microsoft.com/en-us/azure/postgresql/scale/concepts-scaling-resources). Microsoft currently gives pay-as-you-go Analytics Logs a [5-GB monthly free allowance per billing account](https://learn.microsoft.com/en-us/azure/azure-monitor/app/application-insights-faq), which may already be used by other apps.

Internet egress from North America currently has the [first 100 GB/month free](https://azure.microsoft.com/en-us/pricing/details/bandwidth/) and is about $0.087/GB for the next 10 TB on the Microsoft network. This allowance can be shared with other Azure traffic. A busy comic download or MMS media endpoint can eventually make egress visible on the bill.

## How Azure cost changes with usage

These are independent examples using the same retail meters; they are **not** a forecast of user demand:

| Change | Approximate Azure effect |
| --- | ---: |
| 1,000 comics/month, each generation Job running two minutes | $3.60/month for that Job |
| 10,000 comics/month with the same two-minute Job duration | $36/month for that Job |
| Second 0.5-vCPU/1-GiB web replica active all month | Add $38.88/month |
| Move PostgreSQL compute to General Purpose D2s v5 (2 vCores), keeping 32 GB storage | About $131.84/month for database compute plus storage, versus $52.64 on B2s |
| Store 100 GB of Hot LRS comic images | About $1.84/month for blob capacity, plus transactions and egress |
| Ingest 20 **billable** GB of Analytics Logs | About $55.20/month, plus retention beyond the included period |

For example, 10,000 two-minute generation runs, two web replicas active throughout the month, D2s v5 PostgreSQL, 100 GB of blobs, and 20 billable GB of logs would be roughly **$315–$330/month in Azure**, before Twilio and OpenAI. That example also assumes recovery sweeps remain short, no standby database, and no large backup or egress overage. The current deployment caps the public app at two replicas and the generation Job at one concurrent execution; raise those limits only after observing queue wait time, database connections, and throughput. Compute sizing can change later, but [PostgreSQL compute changes briefly restart the server](https://learn.microsoft.com/en-us/azure/postgresql/scale/concepts-scaling-resources).

## Twilio and OpenAI are separate bills

The Azure total above does not include the channel or AI usage. At Twilio's published US list rates, [toll-free SMS](https://www.twilio.com/en-us/sms/pricing/us) is $0.0083 per inbound or outbound segment, outbound MMS is $0.022, and inbound MMS is $0.020, before applicable carrier fees. A US toll-free inbound [Voice](https://www.twilio.com/en-us/voice/pricing/us) call is $0.022/minute, and [Conversation Relay](https://www.twilio.com/en-us/products/conversational-ai/pricing) adds $0.070/minute. A five-minute call is therefore about **$0.46 for Voice plus Relay**, before verification, SMS comic delivery, AI, and any contract-specific adjustments. The toll-free number also has a monthly number charge. [Verify](https://www.twilio.com/en-us/verify/pricing) adds its fee for a successful caller verification plus SMS delivery charges; failed or expired attempts can still incur delivery charges.

The app defaults to OpenAI `gpt-image-2` for comic images and a text model for dialogue and titles. [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) depends on model, image size and quality, prompt/reference inputs, output tokens, and generated page count. Use the [image generation cost guide](https://developers.openai.com/api/docs/guides/image-generation) and actual API usage before setting a per-comic price or cap. At scale, Twilio and OpenAI charges can exceed Azure hosting.

## Cost controls for launch

1. Create a **$150 monthly Azure budget** scoped to `rg-twilio-comics`, with actual and forecast notifications at 50%, 80%, and 100% to `adellavecchia@twilio.com`. It includes the legacy placeholder resources in the same group. [Budgets notify but never stop consumption](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets); cost data usually arrives 8–24 hours later and budgets are evaluated daily. Set separate provider alerts or limits for Twilio and OpenAI.
2. Measure B2s CPU, memory, connections, and query latency after the first live traffic. If a smaller database passes load and recovery tests, B1ms would be about **$15.92/month** including 32 GB storage ($0.017/hour × 720 hours + $3.68), saving about $37/month. It has one vCore and 2 GiB of memory, so do not resize solely from the estimate. Keep the V2 web replica warm for Twilio webhooks and Conversation Relay.
3. Watch recovery Job execution time and failures. If every five-minute run lasted the configured 900-second timeout, its execution bill could approach **$233/month**. Investigate slow sweeps or repeated failures immediately; shorten the timeout only after measuring normal and backlog runs.
4. Watch Log Analytics ingestion, PostgreSQL **Backup Storage Used**, database storage autogrow, ACR image storage above its included 10 GB, and Blob usage. Keep operational logs useful and bounded. Retain user history and finished comics under the app's deletion policy; remove only abandoned temporary uploads and old unreferenced container images after the rollback window.
5. Review actual cost by resource group and service after the first full week and month, then adjust the estimate. Keep the database and its backups running while live admin history must remain available.
