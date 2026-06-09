// <copyright file="EmitDeterminismRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Regression guard for issue #598: ensures that programs exercising
/// yield-in-try-finally and closure-to-delegate shapes produce
/// deterministic IL across consecutive <see cref="Compilation.Emit"/>
/// calls within the same process. If future dictionary-iteration changes
/// break emit determinism, these tests will fail loudly.
/// </summary>
public class EmitDeterminismRegressionTests
{
    /// <summary>
    /// Compiles <c>YieldInTryFinally.gs</c> and <c>FuncToDelegate.gs</c>
    /// twice in the same process and asserts that the SHA-256 of the
    /// metadata streams (MVID zeroed) is identical across both emissions.
    /// </summary>
    [Fact]
    public void EmitDeterminism_TwoConsecutiveEmitsInSameProcess_ProduceIdenticalIL()
    {
        var repoRoot = LocateRepoRoot();
        Assert.NotNull(repoRoot);

        var samples = new[]
        {
            "samples/refactoring-baseline/YieldInTryFinally.gs",
            "samples/FuncToDelegate.gs",
        };

        foreach (var relativePath in samples)
        {
            var absolutePath = Path.Combine(repoRoot!, relativePath);
            Assert.True(File.Exists(absolutePath), $"Sample file not found: {absolutePath}");

            var source = File.ReadAllText(absolutePath);
            var hash1 = CompileAndHash(source, Path.GetFileName(absolutePath));
            var hash2 = CompileAndHash(source, Path.GetFileName(absolutePath));

            Assert.True(
                string.Equals(hash1, hash2, StringComparison.OrdinalIgnoreCase),
                $"Non-deterministic IL detected for '{relativePath}' within the same process.\n" +
                $"  emit 1: {hash1}\n" +
                $"  emit 2: {hash2}\n" +
                "This indicates a dictionary-iteration-order regression in the emit pipeline (issue #598).");
        }
    }

    /// <summary>
    /// A more aggressive variant: compiles each sample 5 times and asserts
    /// all hashes are identical, guarding against GC-compaction-induced
    /// reference-identity hash drift within a single run.
    /// </summary>
    [Fact]
    public void EmitDeterminism_FiveConsecutiveEmits_AllIdentical()
    {
        var repoRoot = LocateRepoRoot();
        Assert.NotNull(repoRoot);

        var samples = new[]
        {
            "samples/refactoring-baseline/YieldInTryFinally.gs",
            "samples/FuncToDelegate.gs",
        };

        foreach (var relativePath in samples)
        {
            var absolutePath = Path.Combine(repoRoot!, relativePath);
            Assert.True(File.Exists(absolutePath), $"Sample file not found: {absolutePath}");

            var source = File.ReadAllText(absolutePath);
            var hashes = new string[5];
            for (int i = 0; i < 5; i++)
            {
                hashes[i] = CompileAndHash(source, Path.GetFileName(absolutePath));
            }

            var distinct = hashes.Distinct().ToArray();
            Assert.True(
                distinct.Length == 1,
                $"Non-deterministic IL detected for '{relativePath}': {distinct.Length} distinct hashes across 5 emissions.\n" +
                $"  hashes: {string.Join(", ", hashes)}\n" +
                "This indicates a dictionary-iteration-order regression in the emit pipeline (issue #598).");
        }
    }

    private static string CompileAndHash(string source, string fileName)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source, fileName));
        var compilation = new Compilation(tree)
        {
            DebugInformation = new DebugInformationOptions { Deterministic = true },
        };

        using var peStream = new MemoryStream();
        var result = compilation.Emit(
            peStream: peStream,
            pdbStream: null,
            refStream: null,
            assemblyName: "GSharp.DeterminismGuard",
            assemblyVersion: "1.0.0.0");

        Assert.True(
            result.Success,
            $"Compilation of '{fileName}' failed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        return HashEmittedContent(peStream.ToArray());
    }

    private static string HashEmittedContent(byte[] bytes)
    {
        using var pe = new PEReader(new MemoryStream(bytes, writable: false));
        var mdReader = pe.GetMetadataReader();

        using var sha = SHA256.Create();
        sha.Initialize();

        var mdStart = pe.PEHeaders.MetadataStartOffset;
        var mdSize = pe.PEHeaders.MetadataSize;

        var mdCopy = new byte[mdSize];
        Array.Copy(bytes, mdStart, mdCopy, 0, mdSize);

        // Zero out MVID so the hash is content-only.
        var mvid = mdReader.GetGuid(mdReader.GetModuleDefinition().Mvid);
        if (mvid != Guid.Empty)
        {
            var mvidBytes = mvid.ToByteArray();
            int searchStart = 0;
            while (true)
            {
                int idx = IndexOf(mdCopy, mvidBytes, searchStart);
                if (idx < 0)
                {
                    break;
                }

                for (int i = 0; i < mvidBytes.Length; i++)
                {
                    mdCopy[idx + i] = 0;
                }

                searchStart = idx + mvidBytes.Length;
            }
        }

        sha.TransformBlock(mdCopy, 0, mdCopy.Length, null, 0);

        foreach (var methodHandle in mdReader.MethodDefinitions)
        {
            var method = mdReader.GetMethodDefinition(methodHandle);
            var rva = method.RelativeVirtualAddress;
            if (rva == 0)
            {
                continue;
            }

            var body = pe.GetMethodBody(rva);
            var il = body.GetILBytes();
            if (il is { Length: > 0 })
            {
                sha.TransformBlock(il, 0, il.Length, null, 0);
            }
        }

        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
        return Convert.ToHexString(sha.Hash!);
    }

    private static int IndexOf(byte[] haystack, byte[] needle, int start)
    {
        int last = haystack.Length - needle.Length;
        for (int i = start; i <= last; i++)
        {
            bool match = true;
            for (int j = 0; j < needle.Length; j++)
            {
                if (haystack[i + j] != needle[j])
                {
                    match = false;
                    break;
                }
            }

            if (match)
            {
                return i;
            }
        }

        return -1;
    }

    private static string? LocateRepoRoot()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(EmitDeterminismRegressionTests).Assembly.Location)!);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                return dir.FullName;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
