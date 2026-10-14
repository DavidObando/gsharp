// <copyright file="MultiPackageEmitShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.LanguageConformance

import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests

/// Locks the structural contract from ADR-0028: a multi-package compilation
/// emits one assembly that contains one `<Program>` type per declared
/// package, each placed in its package's namespace.
open class MultiPackageEmitShapeTests {
    @Fact
    func MultiPackageSample_EmitsOneProgramTypePerPackage() {
        let samplesDir string? = LocateSamplesDirectory()
        Assert.NotNull(samplesDir)
        let sampleDir = Path.Combine(samplesDir!!, "MultiPackage")
        Assert.True(Directory.Exists(sampleDir))
        let tempDir = Directory.CreateTempSubdirectory("gs_mp_shape_").FullName
        try {
            let outPath = Path.Combine(tempDir, "MultiPackage.dll")
            let exit = Program.Main(
                []string{
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    Path.Combine(sampleDir, "Core.gs"),
                    Path.Combine(sampleDir, "Cli.gs")
                }
            )
            Assert.Equal(0, exit)
            Assert.True(File.Exists(outPath))
            IlVerifier.Verify(outPath)
            using let pe = PEReader(File.OpenRead(outPath))
            let reader = pe.GetMetadataReader()
            let programs = reader
                .TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Where((td TypeDefinition) -> reader.GetString(td.Name) == "<Program>")
                .Select((td TypeDefinition) -> reader.GetString(td.Namespace))
                .OrderBy((ns string) -> ns)
                .ToArray()
            Assert.Equal([]string{"GSharp.Example.MultiPackage.Cli", "GSharp.Example.MultiPackage.Core"}, programs)
        } finally {
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
    }

    shared {
        private func LocateSamplesDirectory() string? {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(MultiPackageEmitShapeTests).Assembly.Location)!!
            )
            while dir != nil {
                let candidate = Path.Combine(dir.FullName, "samples")
                if Directory.Exists(candidate) && RepositoryRootMarker.IsRoot(dir.FullName) {
                    return candidate
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
