// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// The Firebase JS SDK ships its React Native build through package "exports"
// maps that Metro's package-exports resolver doesn't fully satisfy — bare
// imports like "@firebase/util" fail to resolve from the RN auth build. Turning
// package exports off falls back to Metro's classic main-field resolution, which
// still routes "@firebase/auth" to its React Native build and which Firebase
// officially supports.
config.resolver.unstable_enablePackageExports = false;

// Some Firebase packages ship .cjs entry files; make sure Metro treats them as
// source so they resolve.
if (!config.resolver.sourceExts.includes('cjs')) {
  config.resolver.sourceExts.push('cjs');
}

module.exports = config;
