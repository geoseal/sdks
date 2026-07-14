// Keeps `import CheckpointCapacitor` source-compatible for hosts (AppDelegate revive path)
// after the engine moved to the CheckpointCore module. Underscored-but-stable attribute;
// escape hatch is a one-line `import CheckpointCore` in hosts.
@_exported import CheckpointCore
