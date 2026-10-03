const fs = require('fs');
const path = require('path');
const { withAppBuildGradle } = require('@expo/config-plugins');

// `expo prebuild` regenerates android/ from scratch every time (including
// `--clean` or deleting the folder outright), which throws away any manual
// edit to android/app/build.gradle. Without this plugin, a fresh prebuild
// silently falls back to signing release builds with debug.keystore — a
// different key than EAS Build uses — which Play Console then rejects as an
// upload-key mismatch the next time you try to upload.
//
// This plugin re-applies the same release signingConfig on every prebuild,
// reading the real keystore + passwords from credentials.json (the file
// `eas credentials` downloads) so local builds (`gradlew bundleRelease`,
// `expo run:android --variant release`) always match EAS cloud builds.
function withReleaseSigning(config) {
  return withAppBuildGradle(config, (config) => {
    const credentialsPath = path.join(config.modRequest.projectRoot, 'credentials.json');

    if (!fs.existsSync(credentialsPath)) {
      throw new Error(
        [
          'withReleaseSigning: apps/mobile/credentials.json not found.',
          '',
          'Release builds need the real signing keystore, not a placeholder.',
          'Run `npx eas credentials` (Android) and download it, or ask Claude',
          'to walk through it again.',
        ].join('\n'),
      );
    }

    const { keystore } = JSON.parse(fs.readFileSync(credentialsPath, 'utf8')).android;
    // keystorePath in credentials.json is relative to apps/mobile/; this file
    // lives at apps/mobile/android/app/build.gradle, two levels down.
    const storeFile = path.join('../..', keystore.keystorePath).replace(/\\/g, '/');

    const releaseSigningConfig = `
        release {
            storeFile file('${storeFile}')
            storePassword '${keystore.keystorePassword}'
            keyAlias '${keystore.keyAlias}'
            keyPassword '${keystore.keyPassword}'
        }`;

    let contents = config.modResults.contents;

    contents = contents.replace(/(signingConfigs\s*\{)/, `$1${releaseSigningConfig}`);

    contents = contents.replace(
      /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/,
      '$1signingConfig signingConfigs.release',
    );

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withReleaseSigning;
