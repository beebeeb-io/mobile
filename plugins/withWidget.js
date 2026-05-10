const { withXcodeProject, withEntitlementsPlist } = require('@expo/config-plugins')
const path = require('path')
const fs = require('fs')

const withWidget = (config) => {
  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.security.application-groups'] = [
      ...(cfg.modResults['com.apple.security.application-groups'] || []),
      'group.io.beebeeb.shared',
    ].filter((v, i, a) => a.indexOf(v) === i)
    return cfg
  })
  config = withXcodeProject(config, async (cfg) => {
    const xcodeProject = cfg.modResults
    const widgetDir = path.join(cfg.modRequest.projectRoot, 'ios', 'BeebeebWidget')
    if (!xcodeProject.pbxGroupByName('BeebeebWidget')) {
      xcodeProject.addTarget('BeebeebWidget', 'app_extension', 'BeebeebWidget', 'io.beebeeb.app.widget')
      const group = xcodeProject.addPbxGroup(
        ['BeebeebWidget.swift'],
        'BeebeebWidget',
        'BeebeebWidget'
      )
      xcodeProject.addBuildPhase(['BeebeebWidget.swift'], 'PBXSourcesBuildPhase', 'Sources', xcodeProject.getTarget('BeebeebWidget').uuid)
    }
    return cfg
  })
  return config
}

module.exports = withWidget
