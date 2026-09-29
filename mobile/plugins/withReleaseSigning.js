const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Release builds are never signed with the debug key.
 *
 * The prebuild template signs `release` with `signingConfigs.debug` — the
 * public Android debug key that every developer machine shares. An APK or AAB
 * signed that way is rejected by Google Play, and a debug-signed build that
 * escapes onto a customer's phone can never be updated by the real one.
 *
 * This replaces it with the UPLOAD key, read from Gradle properties kept
 * outside the repo (~/.gradle/gradle.properties):
 *
 *   MANISHA_UPLOAD_STORE_FILE=/absolute/path/to/upload-keystore.jks
 *   MANISHA_UPLOAD_STORE_PASSWORD=…
 *   MANISHA_UPLOAD_KEY_ALIAS=…
 *   MANISHA_UPLOAD_KEY_PASSWORD=…
 *
 * (Download the keystore and these values with `eas credentials -p android`.)
 * Without them a local release build comes out UNSIGNED — it fails safe
 * instead of silently falling back to the debug key.
 *
 * EAS builds are unaffected: EAS injects its own signing with the
 * EAS-managed upload key, overriding whatever is set here.
 */
const PROP = 'MANISHA_UPLOAD_STORE_FILE';

const RELEASE_SIGNING_CONFIG = `
        release {
            // Upload key from ~/.gradle/gradle.properties (see plugins/withReleaseSigning.js).
            if (project.hasProperty('${PROP}')) {
                storeFile file(project.property('${PROP}'))
                storePassword project.property('MANISHA_UPLOAD_STORE_PASSWORD')
                keyAlias project.property('MANISHA_UPLOAD_KEY_ALIAS')
                keyPassword project.property('MANISHA_UPLOAD_KEY_PASSWORD')
            }
        }`;

function applyReleaseSigning(gradle) {
  if (gradle.includes(`project.hasProperty('${PROP}')`)) return gradle;

  // 1. Add a `release` signing config next to `debug`.
  const withConfig = gradle.replace(
    /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/,
    `$1${RELEASE_SIGNING_CONFIG}`,
  );
  if (withConfig === gradle) {
    throw new Error('withReleaseSigning: could not find signingConfigs.debug in app/build.gradle');
  }

  // 2. The release buildType uses it — or nothing — never the debug key.
  const releaseBlock = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  const withBuildType = withConfig.replace(
    releaseBlock,
    `$1signingConfig project.hasProperty('${PROP}') ? signingConfigs.release : null`,
  );
  if (withBuildType === withConfig) {
    throw new Error('withReleaseSigning: could not find the release buildType signingConfig');
  }
  return withBuildType;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withReleaseSigning: expected a Groovy app/build.gradle');
    }
    cfg.modResults.contents = applyReleaseSigning(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.applyReleaseSigning = applyReleaseSigning;
