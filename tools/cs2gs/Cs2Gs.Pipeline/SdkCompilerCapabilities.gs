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
    func SupportsScopedConditionalSymbols(config string, version string?) bool {
        try {
            let version = version ?? SdkCompileRunner.ResolveSdkVersion(config, explicitVersion: nil)
            if string.IsNullOrEmpty(version) {
                return false
            }
            let packageRoot = SdkCompileRunner.ResolveNugetPackagesRoot()
            if packageRoot != nil {
                let compiler = Path.Combine(
                    packageRoot,
                    "gsharp.net.sdk",
                    version,
                    "tools",
                    "compiler",
                    "GSharp.Core.dll"
                )
                if File.Exists(compiler) {
                    using let stream = File.OpenRead(compiler)
                    return HasScopedConditionalSymbols(stream)
                }
            }
            let packagePath = GsharpTestProjectRunner.FindLocalPackageVersion(
                GsharpTestProjectRunner.TryFindRepoRoot(),
                "Gsharp.NET.Sdk",
                version,
                config
            )
            if packagePath == nil {
                return false
            }
            using let archive = ZipFile.OpenRead(packagePath)
            let entry = archive.GetEntry("tools/compiler/GSharp.Core.dll")
            if entry == nil {
                return false
            }
            using let stream = MemoryStream()
            using let compressed = entry.Open()
            compressed.CopyTo(stream)
            stream.Position = 0
            return HasScopedConditionalSymbols(stream)
        } catch (IOException) {
            return false
        } catch (UnauthorizedAccessException) {
            return false
        } catch (InvalidDataException) {
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
