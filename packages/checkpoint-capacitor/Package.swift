// swift-tools-version: 5.9
import PackageDescription

// Target name deliberately matches the CocoaPods module name (`CheckpointCapacitor`)
// so host-app code like `import CheckpointCapacitor` (see README: AppDelegate
// cold-relaunch revive) works identically under CocoaPods and SwiftPM.
//
// Two build faces over the same sources (core-split):
//   CheckpointCore       — the Capacitor-free engine (GeofenceManager) + the ObjC
//                          shim (CheckpointGeofence). Zero dependencies.
//   CheckpointCapacitor  — the Capacitor plugin shell (NativeGeofence) that
//                          re-exports CheckpointCore for source compatibility.
let package = Package(
    name: "CheckpointCapacitor",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CheckpointCapacitor",
            targets: ["CheckpointCapacitor"]
        ),
        .library(
            name: "CheckpointCore",
            targets: ["CheckpointCore"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "CheckpointCore",
            path: "ios/Sources/CheckpointCore"
        ),
        .target(
            name: "CheckpointCapacitor",
            dependencies: [
                "CheckpointCore",
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/CheckpointCapacitorPlugin"
        )
    ]
)
