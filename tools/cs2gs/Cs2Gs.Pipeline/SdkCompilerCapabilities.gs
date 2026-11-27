// <copyright file="SdkCompilerCapabilities.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Pipeline

import System
import System.IO
import System.IO.Compression
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable

/// Reads compiler capabilities without loading destination assemblies into the translator process.
internal shared class SdkCompilerCapabilities {
    func SupportsScopedConditionalSymbols(context StageExecutionContext) bool -> if context.Options.CompileViaSdk {
        SupportsScopedConditionalSymbols(
            context.Options.Config,
            context.Options.RepositorySdkVersion ?? context.Options.SdkVersion
        )
    } else {
        HasScopedConditionalSymbolsAtPath(
            Path.Combine(Path.GetDirectoryName(context.Gsc.GscPath) ?? string.Empty, "GSharp.Core.dll")
        )
    }

    func SupportsScopedConditionalSymbols(config string, version string?) bool {
        try {
            let version = version ?? SdkCompileRunner.ResolveSdkVersion(config, explicitVersion: nil)
            if string.IsNullOrEmpty(version) {
                return false
            }
            return SupportsScopedConditionalSymbolsInPackage(
                version,
                GsharpTestProjectRunner.FindLocalPackageVersion(
                    GsharpTestProjectRunner.TryFindRepoRoot(),
                    "Gsharp.NET.Sdk",
                    version,
                    config
                )
            )
        } catch (IOException) {
            return false
        } catch (UnauthorizedAccessException) {
            return false
        } catch (InvalidDataException) {
            return false
        }
    }

    func SupportsScopedConditionalSymbolsInPackage(version string, packagePath string?) bool {
        try {
            if packagePath != nil {
                using let archive = ZipFile.OpenRead(packagePath)
                let entry = FindCompilerCoreEntry(archive)
                if entry == nil {
                    return false
                }
                using let stream = MemoryStream()
                using let compressed = entry.Open()
                compressed.CopyTo(stream)
                stream.Position = 0
                return HasScopedConditionalSymbols(stream)
            }
            let installedPath = FindInstalledCompilerCorePath(SdkCompileRunner.ResolveNugetPackagesRoot(), version)
            return installedPath != nil && HasScopedConditionalSymbolsAtPath(installedPath)
        } catch (IOException) {
            return false
        } catch (UnauthorizedAccessException) {
            return false
        } catch (InvalidDataException) {
            return false
        }
    }

    private func FindCompilerCoreEntry(archive ZipArchive) ZipArchiveEntry? {
        let exact = archive.GetEntry("tools/compiler/GSharp.Core.dll")
        if exact != nil {
            return exact
        }
        // NuGet pack can write redundant separators such as tools/compiler//GSharp.Core.dll (#6256).
        for entry in archive.Entries {
            let segments = entry.FullName.Split([]char{'/', '\\'}, StringSplitOptions.RemoveEmptyEntries)
            if segments.Length == 3 && string.Equals(segments[0], "tools", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(segments[1], "compiler", StringComparison.OrdinalIgnoreCase) && string.Equals(
                segments[2],
                "GSharp.Core.dll",
                StringComparison.OrdinalIgnoreCase
            ) {
                return entry
            }
        }
        return nil
    }

    private func FindInstalledCompilerCorePath(packageRoot string?, version string) string? {
        let packageDir = SdkCompileRunner.FindInstalledPackageDirectory(packageRoot, "Gsharp.NET.Sdk")
        if packageDir == nil {
            return nil
        }
        let lowerVersionDir = Path.Combine(packageDir, version.ToLowerInvariant())
        if Directory.Exists(lowerVersionDir) {
            return Path.Combine(lowerVersionDir, "tools", "compiler", "GSharp.Core.dll")
        }
        for dir in Directory.EnumerateDirectories(packageDir) {
            if string.Equals(Path.GetFileName(dir), version, StringComparison.OrdinalIgnoreCase) {
                return Path.Combine(dir, "tools", "compiler", "GSharp.Core.dll")
            }
        }
        return nil
    }

    private func HasScopedConditionalSymbolsAtPath(path string) bool {
        try {
            if !File.Exists(path) {
                return false
            }
            using let stream = File.OpenRead(path)
            return HasScopedConditionalSymbols(stream)
        } catch (IOException) {
            return false
        } catch (UnauthorizedAccessException) {
            return false
        }
    }

    internal func HasScopedConditionalSymbols(stream Stream) bool {
        try {
            using let pe = PEReader(stream, PEStreamOptions.LeaveOpen)
            if !pe.HasMetadata {
                return false
            }
            let metadata = pe.GetMetadataReader()
            for handle in metadata.TypeDefinitions {
                let definition = metadata.GetTypeDefinition(handle)
                if metadata.GetString(definition.Namespace) == "GSharp.Core.CodeAnalysis" && metadata.GetString(
                    definition.Name
                ) == "ConditionalSymbols" &&
                    (definition.Attributes & TypeAttributes.VisibilityMask) == TypeAttributes.Public {
                    return true
                }
            }
        } catch (BadImageFormatException) {
            return false
        }
        return false
    }
}
