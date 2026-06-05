// <copyright file="IlVerifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.IO;
using Xunit;
using Xunit.Sdk;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Smoke tests for the <see cref="IlVerifier"/> helper itself. These guard the
/// gate: if these break, every Compile…+Verify call elsewhere in this assembly
/// is producing meaningless results.
/// </summary>
public class IlVerifierTests
{
    [Fact]
    public void Verify_AcceptsValidEmittedAssembly_DoesNotThrow()
    {
        // Compile the smallest possible gs program and verify the result.
        // This is the actual usage pattern for Compile…Verify() helpers, and
        // guards against regressions in IlVerifier itself (e.g., wrong system
        // module name, missing reference probe).
        var tempDir = Directory.CreateTempSubdirectory("gs_ilv_smoke_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "smoke.gs");
            var outPath = Path.Combine(tempDir, "smoke.dll");
            File.WriteAllText(srcPath, "package P\n\nfunc Main() {\n}\n");

            var exit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
            Assert.Equal(0, exit);
            Assert.True(File.Exists(outPath), $"expected output at {outPath}");

            IlVerifier.Verify(outPath);
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
            }
        }
    }

    [Fact]
    public void Verify_MissingAssembly_Throws()
    {
        var bogus = Path.Combine(Path.GetTempPath(), $"does-not-exist-{Guid.NewGuid():N}.dll");
        Assert.Throws<XunitException>(() => IlVerifier.Verify(bogus));
    }

    [Fact]
    public void Verify_RespectsSkipEnvVar()
    {
        var prev = Environment.GetEnvironmentVariable("GSHARP_SKIP_ILVERIFY");
        Environment.SetEnvironmentVariable("GSHARP_SKIP_ILVERIFY", "1");
        try
        {
            // With the gate disabled, even a missing assembly is a no-op so
            // developers can locally bypass the tool requirement.
            var bogus = Path.Combine(Path.GetTempPath(), $"does-not-exist-{Guid.NewGuid():N}.dll");
            IlVerifier.Verify(bogus);
            Assert.False(IlVerifier.IsEnabled);
        }
        finally
        {
            Environment.SetEnvironmentVariable("GSHARP_SKIP_ILVERIFY", prev);
        }
    }
}
