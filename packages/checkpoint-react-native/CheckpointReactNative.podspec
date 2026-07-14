require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'CheckpointReactNative'
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']
  s.homepage     = 'https://geoseal.dev'
  s.author       = 'Nursa'
  s.platforms    = { :ios => '14.0' }
  s.source       = { :git => 'https://github.com/geoseal/sdks.git', :tag => s.version.to_s }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.swift_version = '5.1'
  s.requires_arc = true

  # React Native core — pulled in by autolinking's install_modules_dependencies on
  # RN >= 0.71 (covers both Old and New Architecture pods).
  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency 'React-Core'
  end

  # The Checkpoint iOS core. The Swift binding (ios/CheckpointGeofence.swift)
  # does `import CheckpointCore` and drives `GeofenceManager.shared` — the
  # Capacitor-FREE engine pod split out of @geoseal/capacitor
  # (CheckpointCore.podspec; no Capacitor dependency). Resolves from the
  # CocoaPods trunk (CDN).
  s.dependency 'CheckpointCore', '~> 0.1'
end
