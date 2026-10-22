@description('Region of the existing Twilio Comics resource group and Log Analytics workspace.')
param location string = 'eastus2'

@description('The existing Log Analytics workspace shared with the current placeholder environment.')
param logAnalyticsWorkspaceName string = 'law-twilio-comics'

@description('A password held outside source control, supplied as a secure deployment parameter.')
@secure()
@minLength(24)
@maxLength(128)
param postgresAdminPassword string

@description('PostgreSQL server administrator used only to bootstrap separate migration and runtime roles.')
param postgresAdminLogin string = 'comics_bootstrap'

@description('Resource tags required by the Twilio Comics Azure subscription.')
param tags object = {
  created_by: 'github-actions'
  managed_by: 'twilio-comics-ci'
}

var vnetName = 'vnet-twilio-comics-v2'
var acaSubnetName = 'aca-infrastructure'
var postgresSubnetName = 'postgresql'
var postgresPrivateDnsZoneName = 'twilio-comics.postgres.database.azure.com'
var containerAppsEnvironmentName = 'cae-twilio-comics-v2'
var postgresServerName = 'twilio-comics-pg-1a1d98'
var databaseName = 'twilio_comics'

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.74.0.0/20'
      ]
    }
  }
}

resource acaSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: acaSubnetName
  properties: {
    addressPrefix: '10.74.0.0/23'
    delegations: [
      {
        name: 'container-apps-environments'
        properties: {
          serviceName: 'Microsoft.App/environments'
        }
      }
    ]
    serviceEndpoints: [
      {
        service: 'Microsoft.KeyVault'
      }
    ]
  }
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: postgresSubnetName
  properties: {
    addressPrefix: '10.74.8.0/26'
    delegations: [
      {
        name: 'postgresql-flexible-servers'
        properties: {
          serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
        }
      }
    ]
    serviceEndpoints: [
      {
        service: 'Microsoft.Storage'
      }
    ]
  }
}

resource postgresPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: postgresPrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource postgresDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresPrivateDnsZone
  name: 'twilio-comics-v2-link'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppsEnvironmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspace.properties.customerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: acaSubnet.id
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

resource postgresServer 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresServerName
  location: location
  tags: tags
  sku: {
    name: 'Standard_B2s'
    tier: 'Burstable'
  }
  properties: {
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    authConfig: {
      activeDirectoryAuth: 'Disabled'
      passwordAuth: 'Enabled'
    }
    backup: {
      backupRetentionDays: 14
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: postgresPrivateDnsZone.id
      publicNetworkAccess: 'Disabled'
    }
    storage: {
      autoGrow: 'Enabled'
      storageSizeGB: 32
      tier: 'P4'
    }
    version: '16'
  }
  dependsOn: [
    postgresDnsVnetLink
  ]
}

resource applicationDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgresServer
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output vnetId string = vnet.id
output containerAppsSubnetId string = acaSubnet.id
output postgresSubnetId string = postgresSubnet.id
output postgresPrivateDnsZoneId string = postgresPrivateDnsZone.id
output containerAppsEnvironmentName string = containerAppsEnvironment.name
output postgresServerName string = postgresServer.name
output postgresFqdn string = postgresServer.properties.fullyQualifiedDomainName
output databaseName string = applicationDatabase.name
