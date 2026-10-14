// <copyright file="RepoRoot.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import GSharp.Tests
import System
import System.IO

/// Locates the repository root by walking up from the test assembly directory
/// until a folder containing `GSharp.sln` or `GSharp.slnx` is found. This keeps the test
/// project free of build-time path injection.
internal shared class RepoRoot {
    private let _path string = Find()

    prop Path string {
        get {
            return _path
        }
    }

    private let _sdkSourceDir string = Path.Combine(RepoRoot.Path, "src", "Sdk", "Gsharp.NET.Sdk")

    prop SdkSourceDir string {
        get {
            return _sdkSourceDir
        }
    }

    private let _templatesSourceDir string = Path.Combine(RepoRoot.Path, "src", "Sdk", "Gsharp.Templates")

    prop TemplatesSourceDir string {
        get {
            return _templatesSourceDir
        }
    }

    private let _samplesDir string = Path.Combine(RepoRoot.Path, "samples")

    prop SamplesDir string {
        get {
            return _samplesDir
        }
    }

    /// Resolves a repository source path that survives the cs2gs
    /// self-migration corpus, where every translated project file is renamed
    /// `X.csproj` to `X.gsproj` and every translated source file is
    /// renamed `X.cs` to `X.gs`. Layout assertions are about the
    /// repository's shape, not about which language the file happens to be
    /// written in, so they must find the file under either name.
    /// @param path The C# spelling of the path.
    /// @returns [`path`](paramref) when it exists, otherwise the migrated sibling.
    func ResolveSourcePath(path string) string {
        if File.Exists(path) {
            return path
        }
        let migrated = MigratedSpelling(path)
        return if File.Exists(migrated) {
            migrated
        } else {
            path
        }
    }

    private func MigratedSpelling(path string) string {
        if path.EndsWith(".csproj", StringComparison.Ordinal) {
            return path.Substring(0, path.Length - ".csproj".Length) + ".gsproj"
        }
        if path.EndsWith(".cs", StringComparison.Ordinal) {
            return path.Substring(0, path.Length - ".cs".Length) + ".gs"
        }
        return path
    }

    private func Find() string {
        var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
        while dir != nil {
            if RepositoryRootMarker.IsRoot(dir.FullName) {
                return dir.FullName
            }
            dir = dir.Parent
        }
        throw InvalidOperationException(
            "Could not locate GSharp.sln or GSharp.slnx walking up from ${AppContext.BaseDirectory}."
        )
    }
}
