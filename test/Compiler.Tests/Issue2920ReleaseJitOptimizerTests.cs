// <copyright file="Issue2920ReleaseJitOptimizerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public class Issue2920ReleaseJitOptimizerTests
{
    [Theory]
    [InlineData(
        null,
        "/debug:portable",
        true,
        (int)DebuggableAttribute.DebuggingModes.IgnoreSymbolStoreSequencePoints)]
    [InlineData(
        "/optimize+",
        "/debug:portable",
        true,
        (int)DebuggableAttribute.DebuggingModes.IgnoreSymbolStoreSequencePoints)]
    [InlineData(
        "/optimize-",
        "/debug:portable",
        true,
        (int)(DebuggableAttribute.DebuggingModes.Default | DebuggableAttribute.DebuggingModes.DisableOptimizations))]
    [InlineData(
        "/optimize-",
        "/debug-",
        false,
        (int)(DebuggableAttribute.DebuggingModes.Default | DebuggableAttribute.DebuggingModes.DisableOptimizations))]
    public void Main_OptimizeFlag_ControlsJitFlagsIndependentlyFromPdb(
        string optimizeFlag,
        string debugFlag,
        bool expectPdb,
        int expectedFlags)
    {
        var id = Guid.NewGuid().ToString("N");
        var directory = Path.Combine(Directory.GetCurrentDirectory(), ".issue2920-" + id);
        Assert.False(Directory.Exists(directory));
        Directory.CreateDirectory(directory);

        var sourcePath = Path.Combine(directory, "program.gs");
        var outputPath = Path.Combine(directory, "Issue2920" + id + ".dll");
        var pdbPath = Path.ChangeExtension(outputPath, ".pdb");
        File.WriteAllText(
            sourcePath,
            $"package Issue2920{id}\n\nfunc Value() int {{\n    return 11\n}}\n");

        try
        {
            var arguments = new[]
            {
                "/out:" + outputPath,
                "/target:library",
                debugFlag,
                optimizeFlag,
                sourcePath,
            }.Where(argument => argument is not null).ToArray();

            var exit = Program.Main(arguments);

            Assert.Equal(0, exit);
            Assert.True(File.Exists(outputPath));
            Assert.Equal(expectPdb, File.Exists(pdbPath));
            IlVerifier.Verify(outputPath);

            var assembly = EmittedFixture.Load(outputPath);
            Assert.NotEmpty(assembly.GetTypes());
            var debuggable = assembly.GetCustomAttribute<DebuggableAttribute>();
            Assert.NotNull(debuggable);
            Assert.Equal((DebuggableAttribute.DebuggingModes)expectedFlags, debuggable!.DebuggingFlags);

            if (expectPdb)
            {
                using var pdbStream = File.OpenRead(pdbPath);
                using var provider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
                var reader = provider.GetMetadataReader();
                Assert.NotEmpty(reader.Documents);
                Assert.Contains(
                    reader.MethodDebugInformation,
                    handle => reader.GetMethodDebugInformation(handle).GetSequencePoints().Any());
            }
        }
        finally
        {
            try { Directory.Delete(directory, recursive: true); } catch { }
        }
    }
}
