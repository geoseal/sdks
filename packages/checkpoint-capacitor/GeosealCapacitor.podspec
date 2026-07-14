require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'GeosealCapacitor'
  # Pod name is derived by the Capacitor CLI from the npm package name
  # (@geoseal/capacitor -> GeosealCapacitor, no override exists), so this file
  # MUST exist under this exact name inside the published tarball or consumer
  # `npx cap sync` breaks. CheckpointIrlCapacitor.podspec is the identical
  # legacy-named spec (kept for the console app's hardcoded Podfile entry).
  # The Swift module keeps its original name so `import CheckpointCapacitor`
  # stays source-compatible under both CocoaPods and SwiftPM; the native rename
  # to GeosealCore is deferred to the next device-verified native release
  # (docs/runbooks/geoseal-rename-publish-day.md).
  s.module_name = 'CheckpointCapacitor'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://geoseal.dev'
  s.author = 'Nursa'
  # npm tarball source (matches the trunk CheckpointCore spec). The tgz unpacks
  # under package/, but CocoaPods flattens single-root archives, so source_files
  # stay unprefixed.
  s.source = { :http => "https://registry.npmjs.org/@geoseal/capacitor/-/capacitor-#{package['version']}.tgz", :type => 'tgz' }
  s.source_files = 'ios/Sources/CheckpointCapacitorPlugin/**/*'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.dependency 'CheckpointCore', package['version']
  s.swift_version = '5.9'
end
