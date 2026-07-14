// React Native autolinking descriptor. The CLI reads this to find the iOS podspec
// and the Android source/manifest/package without the host app editing
// MainApplication or its Podfile. Works on both architectures.
module.exports = {
  dependency: {
    platforms: {
      ios: {
        podspecPath: __dirname + '/CheckpointReactNative.podspec',
      },
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.checkpoint.reactnative.CheckpointGeofencePackage;',
        packageInstance: 'new CheckpointGeofencePackage()',
      },
    },
  },
};
