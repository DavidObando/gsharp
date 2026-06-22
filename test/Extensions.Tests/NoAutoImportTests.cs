// <copyright file="NoAutoImportTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Extensions.Tests;

/// <summary>
/// Per ADR-0084: nothing under <c>Gsharp.Extensions.*</c> is auto-imported,
/// even with the implicit-imports compiler option enabled. This fixture
/// drives <c>gsc.dll</c> end-to-end and asserts the diagnostic on the
/// no-import path, then the success path with the explicit import added.
/// </summary>
public class NoAutoImportTests
{
    private const string SnippetWithoutImport = @"
package GSharp.Extensions.Tests.AutoImportProbe

import System

let names []string = []string { ""alpha"", ""beta"" }
let head = names.FirstOrNil()
Console.WriteLine(head ?? ""<none>"")
";

    private const string SnippetWithImport = @"
package GSharp.Extensions.Tests.AutoImportProbe

import System
import Gsharp.Extensions.Sequences

let names []string = []string { ""alpha"", ""beta"" }
let head = names.FirstOrNil()
Console.WriteLine(head ?? ""<none>"")
";

    [Fact]
    public void FirstOrNil_WithoutImport_FailsBinding()
    {
        var (exit, stdout, stderr) = CompileSnippet(SnippetWithoutImport);
        Assert.NotEqual(0, exit);
        var combined = stdout + "\n" + stderr;
        Assert.Contains("FirstOrNil", combined, StringComparison.Ordinal);
    }

    [Fact]
    public void FirstOrNil_WithImport_CompilesCleanly()
    {
        var (exit, stdout, stderr) = CompileSnippet(SnippetWithImport);
        Assert.True(
            exit == 0,
            $"expected clean compile with explicit import:\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static (int exit, string stdout, string stderr) CompileSnippet(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_noautoimport_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "snippet.gs");
            File.WriteAllText(srcPath, source);
            var outPath = Path.Combine(tempDir, "snippet.dll");
            var extensionsAssembly = LocateGsharpExtensionsAssembly();
            Assert.True(
                extensionsAssembly != null && File.Exists(extensionsAssembly),
                "Gsharp.Extensions.dll must be built before running this test (run `dotnet build`).");

            var args = new List<string>
            {
                "/out:" + outPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/r:" + extensionsAssembly,
                srcPath,
            };

            using var stdout = new StringWriter();
            using var stderr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(stdout);
            Console.SetError(stderr);
            int exit;
            try
            {
                exit = Program.Main(args.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            return (exit, stdout.ToString(), stderr.ToString());
        }
        finally
        {
            try
            {
                Directory.Delete(tempDir, recursive: true);
            }
            catch
            {
                // best-effort cleanup
            }
        }
    }

    private static string? LocateGsharpExtensionsAssembly()
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(typeof(NoAutoImportTests).Assembly.Location)!);
        while (dir != null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "GSharp.sln")))
            {
                foreach (var cfg in new[] { "Debug", "Release" })
                {
                    var candidate = Path.Combine(dir.FullName, "out", "bin", cfg, "Gsharp.Extensions", "Gsharp.Extensions.dll");
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }

                return null;
            }

            dir = dir.Parent;
        }

        return null;
    }
}
