const { withAppDelegate } = require('@expo/config-plugins');

module.exports = function withShortcutBridge(config) {
  return withAppDelegate(config, (config) => {
    const src = config.modResults.contents;
    if (src.includes('performActionFor')) return config;

    const method = `
- (void)application:(UIApplication *)application performActionForShortcutItem:(UIApplicationShortcutItem *)shortcutItem completionHandler:(void (^)(BOOL))completionHandler {
  NSDictionary *userInfo = shortcutItem.userInfo;
  NSString *url = userInfo[@"url"];
  if (url) {
    [RCTLinkingManager application:application openURL:[NSURL URLWithString:url] options:@{}];
  }
  completionHandler(YES);
}`;

    config.modResults.contents = src.replace(/@end\s*$/, `${method}\n@end`);
    return config;
  });
};
