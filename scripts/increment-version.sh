#!/bin/bash
# Auto-increment version for each build

cd "$(dirname "$0")/.."

# Read current version from package.json
current=$(grep '"version"' package.json | sed 's/.*"version": "\(.*\)".*/\1/')
echo "Current version: $current"

# Parse version parts
major=$(echo $current | cut -d. -f1)
minor=$(echo $current | cut -d. -f2)
patch=$(echo $current | cut -d. -f3)

# Increment patch
patch=$((patch + 1))
new_version="$major.$minor.$patch"

echo "New version: $new_version"

# Update package.json
sed -i "s/\"version\": \"$current\"/\"version\": \"$new_version\"/" package.json

# Update tauri.conf.json
sed -i "s/\"version\": \"$current\"/\"version\": \"$new_version\"/" src-tauri/tauri.conf.json

# Update Cargo.toml
sed -i "s/^version = \"$current\"/version = \"$new_version\"/" src-tauri/Cargo.toml

echo "Version bumped to $new_version"

# Commit
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "chore: bump version to $new_version" 2>&1 | tail -3
