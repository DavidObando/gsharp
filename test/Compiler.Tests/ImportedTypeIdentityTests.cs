// <copyright file="ImportedTypeIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit;

namespace GSharp.Compiler.Tests;

public class ImportedTypeIdentityTests
{
    [Fact]
    public void FullyQualifiedAndImportedExternalType_Unify()
    {
        var source = """
            package P
            import System
            import System.Text

            func take(value StringBuilder) string {
                return value.ToString()
            }

            let value StringBuilder = System.Text.StringBuilder()
            Console.WriteLine(take(value))
            """;

        var (exitCode, output) = Compile(source);
        Assert.True(exitCode == 0, output);
        Assert.DoesNotContain("GS0155", output, StringComparison.Ordinal);
        Assert.DoesNotContain("GS0158", output, StringComparison.Ordinal);
    }

    [Fact]
    public void TypeIdentityComparer_MatchesReresolvedType()
    {
        var references = TrustedPlatformAssemblies().ToList();
        if (references.Count == 0)
        {
            return;
        }

        using var first = ReferenceResolver.WithReferences(references);
        using var second = ReferenceResolver.WithReferences(references);

        Assert.True(first.TryResolveType("System.Text.StringBuilder", out var left));
        Assert.True(second.TryResolveType("System.Text.StringBuilder", out var right));
        Assert.NotSame(left, right);

        var comparerType = typeof(ReferenceResolver).Assembly.GetType("GSharp.Core.CodeAnalysis.Emit.TypeIdentityComparer");
        var comparer = comparerType?.GetField("Instance", BindingFlags.Public | BindingFlags.Static)?.GetValue(null);

        var dictionary = new Dictionary<Type, string>(Assert.IsAssignableFrom<IEqualityComparer<Type>>(comparer))
        {
            [left] = "hit",
        };
        Assert.True(dictionary.TryGetValue(right, out var value));
        Assert.Equal("hit", value);
    }

    private static (int ExitCode, string Output) Compile(string source)
    {
        var workDir = CreateTestDirectory("gs_identity_test_");
        try
        {
            var srcPath = Path.Combine(workDir, "test.gs");
            var outPath = Path.Combine(workDir, "test.dll");
            File.WriteAllText(srcPath, source);

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };

            foreach (var reference in TrustedPlatformAssemblies())
            {
                args.Add("/reference:" + reference);
            }

            args.Add(srcPath);

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var previousOut = Console.Out;
            var previousErr = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            try
            {
                return (Program.Main(args.ToArray()), stdout.ToString() + stderr);
            }
            finally
            {
                Console.SetOut(previousOut);
                Console.SetError(previousErr);
            }
        }
        finally
        {
            try { Directory.Delete(workDir, recursive: true); } catch { }
        }
    }

    private static string CreateTestDirectory(string prefix)
    {
        var root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, prefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }
}
