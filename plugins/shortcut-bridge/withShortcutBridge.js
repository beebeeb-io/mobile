const { withAppDelegate } = require('@expo/config-plugins');

// Forwards Home-screen quick action selections (3D Touch shortcuts defined in
// app.json under UIApplicationShortcutItems) into React Native's URL handler.
// Each shortcut carries a `url` in its userInfo (e.g. beebeeb://search). When
// the user picks one, iOS hands the shortcut to AppDelegate; we extract the
// URL and route it through RCTLinkingManager so it surfaces in JS via
// Linking.addEventListener('url', ...).
//
// Idempotent: skipped when the marker is already present.
const MARKER = '@beebeeb-shortcut-bridge';

const OBJC_METHOD = `
// ${MARKER}
- (void)application:(UIApplication *)application performActionForShortcutItem:(UIApplicationShortcutItem *)shortcutItem completionHandler:(void (^)(BOOL succeeded))completionHandler
{
  NSString *urlString = shortcutItem.userInfo[@"url"];
  if (urlString.length > 0) {
    NSURL *url = [NSURL URLWithString:urlString];
    if (url != nil) {
      BOOL handled = [RCTLinkingManager application:application openURL:url options:@{}];
      completionHandler(handled);
      return;
    }
  }
  completionHandler(NO);
}
`;

const SWIFT_METHOD = `
  // ${MARKER}
  func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
    if let urlString = shortcutItem.userInfo?["url"] as? String, let url = URL(string: urlString) {
      let handled = RCTLinkingManager.application(application, open: url, options: [:])
      completionHandler(handled)
      return
    }
    completionHandler(false)
  }
`;

function injectObjC(contents) {
  if (contents.includes(MARKER)) return contents;

  const lastEnd = contents.lastIndexOf('@end');
  if (lastEnd === -1) {
    console.warn('[shortcut-bridge] WARNING: could not find @end in AppDelegate');
    return contents;
  }
  return contents.slice(0, lastEnd) + OBJC_METHOD + '\n' + contents.slice(lastEnd);
}

function injectSwift(contents) {
  if (contents.includes(MARKER)) return contents;

  // Insert before the final closing brace of the AppDelegate class body.
  const lastBrace = contents.lastIndexOf('}');
  if (lastBrace === -1) {
    console.warn('[shortcut-bridge] WARNING: could not find class closing brace in AppDelegate');
    return contents;
  }
  return contents.slice(0, lastBrace) + SWIFT_METHOD + contents.slice(lastBrace);
}

module.exports = function withShortcutBridge(config) {
  return withAppDelegate(config, (config) => {
    const { language, contents } = config.modResults;

    if (language === 'swift') {
      config.modResults.contents = injectSwift(contents);
    } else {
      config.modResults.contents = injectObjC(contents);
    }

    return config;
  });
};
