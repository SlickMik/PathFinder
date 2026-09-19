const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('@expo/config-plugins');

function replaceIfPresent(filePath, search, replacement) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const source = fs.readFileSync(filePath, 'utf8');
  if (!source.includes(search)) {
    return;
  }

  fs.writeFileSync(filePath, source.replace(search, replacement));
}

module.exports = function withSpaceSafeIosScripts(config) {
  return withDangerousMod(config, [
    'ios',
    (modConfig) => {
      const projectRoot = modConfig.modRequest.projectRoot;
      const platformProjectRoot = modConfig.modRequest.platformProjectRoot;

      // Expo SDK 57 emits an unquoted Constants script command. Quote the
      // executable and PROJECT_ROOT so builds also work from paths containing
      // spaces (which is common on macOS Desktop folders).
      replaceIfPresent(
        path.join(projectRoot, 'node_modules', 'expo-constants', 'ios', 'EXConstants.podspec'),
        String.raw`:script => "bash -l -c \"#{env_vars}$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\"",`,
        String.raw`:script => "#{env_vars}\"$PODS_TARGET_SRCROOT/../scripts/get-app-config-ios.sh\"",`
      );

      // Expo Constants also calls basename with the Xcode project directory
      // unquoted. Without this patch, a Release build from a path containing a
      // space creates an empty EXConstants.bundle and expo-linking crashes at
      // launch because app.config is missing.
      replaceIfPresent(
        path.join(
          projectRoot,
          'node_modules',
          'expo-constants',
          'scripts',
          'get-app-config-ios.sh'
        ),
        'PROJECT_DIR_BASENAME=$(basename $PROJECT_DIR)',
        'PROJECT_DIR_BASENAME=$(basename "$PROJECT_DIR")'
      );

      const appProject = fs
        .readdirSync(platformProjectRoot)
        .find((entry) => entry.endsWith('.xcodeproj'));

      if (appProject) {
        replaceIfPresent(
          path.join(platformProjectRoot, appProject, 'project.pbxproj'),
          '\\n`\\\"$NODE_BINARY\\\" --print \\"require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'\\\"`\\n\\n',
          '\\n\\\"$(\\\"$NODE_BINARY\\\" --print \\"require(\'path\').dirname(require.resolve(\'react-native/package.json\')) + \'/scripts/react-native-xcode.sh\'\\\")\\\"\\n\\n'
        );
      }

      return modConfig;
    },
  ]);
};
