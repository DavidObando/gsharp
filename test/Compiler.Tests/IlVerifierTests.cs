// <copyright file="IlVerifierTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
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
    public void Verify_MissingReference_Throws()
    {
        var bogus = Path.Combine(
            Directory.GetCurrentDirectory(),
            $"does-not-exist-{Guid.NewGuid():N}.dll");
        var exception = Assert.Throws<XunitException>(
            () => IlVerifier.Verify(typeof(IlVerifierTests).Assembly.Location, new[] { bogus }));

        Assert.Contains("reference assembly not found", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Verify_InvalidMethodBody_ReportsErrors()
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_ilv_bad_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "bad.gs");
            var outPath = Path.Combine(tempDir, "bad.dll");
            File.WriteAllText(srcPath, "package P\n\npublic func Bad() {\n}\n");

            var exit = Program.Main(new[]
            {
                "/out:" + outPath,
                "/target:library",
                "/targetframework:net10.0",
                srcPath,
            });
            Assert.Equal(0, exit);

            var bytes = File.ReadAllBytes(outPath);
            using (var peReader = new PEReader(new MemoryStream(bytes, writable: false)))
            {
                var metadata = peReader.GetMetadataReader();
                var method = metadata.MethodDefinitions
                    .Select(metadata.GetMethodDefinition)
                    .Single(m => metadata.GetString(m.Name) == "Bad");
                var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
                Assert.Equal(new byte[] { 0x2A }, body.GetILBytes());

                var section = peReader.PEHeaders.SectionHeaders.Single(s =>
                    method.RelativeVirtualAddress >= s.VirtualAddress
                    && method.RelativeVirtualAddress < s.VirtualAddress + s.SizeOfRawData);
                var bodyOffset = method.RelativeVirtualAddress - section.VirtualAddress + section.PointerToRawData;
                var headerSize = 1;
                bytes[bodyOffset + headerSize] = 0x26;
            }

            File.WriteAllBytes(outPath, bytes);
            var exception = Assert.Throws<XunitException>(() => IlVerifier.Verify(outPath));
            Assert.Contains("Error(s)", exception.Message, StringComparison.Ordinal);
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
