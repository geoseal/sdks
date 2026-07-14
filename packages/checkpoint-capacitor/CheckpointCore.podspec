require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CheckpointCore'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://geoseal.dev'
  s.author = 'Nursa'
  # npm tarball source (matches the trunk spec). The tgz unpacks under package/,
  # but CocoaPods flattens single-root archives, so source_files stay unprefixed.
  s.source = { :http => "https://registry.npmjs.org/@geoseal/capacitor/-/capacitor-#{package['version']}.tgz", :type => 'tgz' }
  s.source_files = 'ios/Sources/CheckpointCore/**/*.swift'
  s.ios.deployment_target = '14.0'
  s.swift_version = '5.9'
end
