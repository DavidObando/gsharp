// <copyright file="MultiPackageEmitShapeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using Xunit;

namespace GSharp.Compiler.Tests.LanguageConformance;

/// <summary>
/// Locks the structural contract from ADR-0028: a multi-package compilation
/// emits one assembly that contains one <c>&lt;Program&gt;</c> type per declared
/// package, each placed in its package's namespace.
/// </summary>
public class MultiPackageEmitShapeTests
{
    [Fact]
    public void MultiPackageSample_EmitsOneProgramTypePerPackage()
    {
        var samplesDir = LocateSamplesDirectory();
        Assert.NotNull(samplesDir);
        var sampleDir = Path.Combine(samplesDir, "MultiPackage");
        Assert.True(Directory.Exists(sampleDir));

        var tempDir = Directory.CreateTempSubdirectory("gs_mp_shape_").FullName;
        try
        {
            var outPath = Path.Combine(tempDir, "MultiPackage.dll");
            var exit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                Path.Combine(sampleDir, "Core.gs"),
                Path.Combine(sampleDir, "Cli.gs"),
            });
            Assert.Equal(0, exit);
            Assert.True(File.Exists(outPath));
            IlVerifier.Verify(outPath);

            using var pe = new PEReader(File.OpenRead(outPath));
            var reader = pe.GetMetadataReader();

            var programs = reader.TypeDefinitions
                .Select(reader.GetTypeDefinition)
                .Where(td => reader.GetString(td.Name) == "<Program>")
                .Select(td => reader.GetString(td.Namespace))
                .OrderBy(ns => ns)
                .ToArray();

            Assert.Equal(
                new[]
                {
                    "GSharp.Example.MultiPackage.Cli",
                    "GSharp.Example.MultiPackage.Core",
                },
                programs);
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { }
        }
    }

    private static string LocateSamplesDirectory()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(MultiPackageEmitShapeTests).Assembly.Location));
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "samples");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return candidate;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
