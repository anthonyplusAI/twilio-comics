@description('Region of the existing Twilio Comics resource group and Log Analytics workspace.')
param location string = 'eastus2'

@description('Region for the dedicated private PostgreSQL server and its VNet.')
@allowed(['centralus'])
param postgresLocation string = 'centralus'

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
var postgresVnetName = 'vnet-twilio-comics-pg-cus'
var acaSubnetName = 'aca-infrastructure'
var postgresSubnetName = 'postgresql'
var postgresPrivateDnsZoneName = 'twilio-comics.postgres.database.azure.com'
var acaDnsLinkName = 'twilio-comics-v2-link'
var postgresDnsLinkName = 'twilio-comics-pg-cus-link'
var acaToPostgresPeeringName = 'aca-to-postgres-centralus'
var postgresToAcaPeeringName = 'postgres-to-aca-eastus2'
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
    privateEndpointVNetPolicies: 'Disabled'
  }
}

// This unused East US 2 subnet already exists. Keep it declared so an
// incremental VNet update cannot remove it while adding global peering.
resource legacyPostgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: postgresSubnetName
  properties: {
    addressPrefix: '10.74.8.0/26'
    privateEndpointNetworkPolicies: 'Disabled'
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

resource acaSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: acaSubnetName
  properties: {
    addressPrefix: '10.74.0.0/23'
    privateEndpointNetworkPolicies: 'Disabled'
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

resource postgresVnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: postgresVnetName
  location: postgresLocation
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.75.0.0/20'
      ]
    }
  }
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: postgresVnet
  name: postgresSubnetName
  properties: {
    addressPrefix: '10.75.0.0/26'
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

resource acaToPostgresPeering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = {
  parent: vnet
  name: acaToPostgresPeeringName
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: {
      id: postgresVnet.id
    }
  }
  dependsOn: [
    acaSubnet
    legacyPostgresSubnet
    postgresSubnet
  ]
}

resource postgresToAcaPeering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2024-05-01' = {
  parent: postgresVnet
  name: postgresToAcaPeeringName
  properties: {
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
    remoteVirtualNetwork: {
      id: vnet.id
    }
  }
  dependsOn: [
    acaToPostgresPeering
  ]
}

resource postgresPrivateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: postgresPrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource postgresDnsVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresPrivateDnsZone
  name: acaDnsLinkName
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource postgresDnsDbVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresPrivateDnsZone
  name: postgresDnsLinkName
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: postgresVnet.id
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
    peerAuthentication: {
      mtls: {
        enabled: false
      }
    }
    peerTrafficConfiguration: {
      encryption: {
        enabled: false
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
  location: postgresLocation
  tags: tags
  sku: {
    name: 'Standard_B1ms'
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
    postgresDnsDbVnetLink
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
output postgresVnetId string = postgresVnet.id
output postgresSubnetId string = postgresSubnet.id
output postgresPrivateDnsZoneId string = postgresPrivateDnsZone.id
output acaToPostgresPeeringId string = acaToPostgresPeering.id
output postgresToAcaPeeringId string = postgresToAcaPeering.id
output postgresDnsAcaLinkId string = postgresDnsVnetLink.id
output postgresDnsDbLinkId string = postgresDnsDbVnetLink.id
output containerAppsEnvironmentName string = containerAppsEnvironment.name
output postgresRegion string = postgresLocation
output postgresServerName string = postgresServer.name
output postgresFqdn string = postgresServer.properties.fullyQualifiedDomainName
output databaseName string = applicationDatabase.name
