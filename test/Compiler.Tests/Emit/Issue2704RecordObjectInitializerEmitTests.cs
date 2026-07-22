// <copyright file="Issue2704RecordObjectInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>Issue #2704: data-class literals call init accessors.</summary>
public sealed class Issue2704RecordObjectInitializerEmitTests
{
    [Fact]
    public void ExactCliMapBook_UsesInitAccessors_AndIlVerifies()
    {
        const string source = """
            package Oahu.Cli.App.Models

            import System

            data class LibraryItem {
                prop Asin string { get; init; }
                prop Title string { get; init; }
                private var authors []string = Array.Empty[string]()
                prop Authors []string {
                    get -> authors
                    init { authors = value }
                }
                private var narrators []string = Array.Empty[string]()
                prop Narrators []string {
                    get -> narrators
                    init { narrators = value }
                }
            }

            class CoreLibraryService {
                shared {
                    public func MapBook(asin string, title string) LibraryItem ->
                        LibraryItem{
                            Asin: asin,
                            Title: title,
                            Authors: []string{"author"},
                            Narrators: []string{"narrator"}
                        }
                }
            }

            let item = CoreLibraryService.MapBook("A1", "Book")
            Console.WriteLine(item.Asin)
            Console.WriteLine(item.Title)
            Console.WriteLine(item.Authors[0])
            Console.WriteLine(item.Narrators[0])
            """;

        using var result = Compile(source);
        Assert.Equal("A1\nBook\nauthor\nnarrator\n", Run(result.OutputPath));
        IlVerifier.Verify(result.OutputPath);

        var loadContext = new AssemblyLoadContext("issue2704-" + Guid.NewGuid(), isCollectible: true);
        try
        {
            Assembly assembly = loadContext.LoadFromAssemblyPath(result.OutputPath);
            Type itemType = assembly.GetType("Oahu.Cli.App.Models.LibraryItem", throwOnError: true)!;
            foreach (string name in new[] { "Asin", "Title", "Authors", "Narrators" })
            {
                PropertyInfo property = itemType.GetProperty(name)!;
                Assert.True(
                    property.SetMethod!.ReturnParameter.GetRequiredCustomModifiers()
                        .Contains(typeof(IsExternalInit)),
                    $"{name} setter must carry modreq(IsExternalInit).");
            }

            MethodInfo mapBook = assembly
                .GetType("Oahu.Cli.App.Models.CoreLibraryService", throwOnError: true)!
                .GetMethod("MapBook", BindingFlags.Public | BindingFlags.Static)!;
            byte[] il = mapBook.GetMethodBody()!.GetILAsByteArray()!;
            Assert.DoesNotContain(unchecked((byte)OpCodes.Stfld.Value), il);
            Assert.Equal(4, il.Count(b => b == unchecked((byte)OpCodes.Callvirt.Value)));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    [Fact]
    public void InitProperty_AssignmentAfterConstruction_RemainsRejected()
    {
        const string source = """
            package Oahu.Cli.App.Models

            data class LibraryItem {
                prop Asin string { get; init; }
            }

            let item = LibraryItem{Asin: "A1"}
            item.Asin = "A2"
            """;

        var tree = SyntaxTree.Parse(SourceText.From(source, "CoreLibraryService.gs"));
        var compilation = new Compilation(tree);
        using var pe = new MemoryStream();
        var result = compilation.Emit(pe, refStream: null);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, diagnostic => diagnostic.Id == "GS0372");
    }

    private static CompilationResult Compile(string source)
    {
        string directory = Path.Combine(
            AppContext.BaseDirectory,
            "issue2704-artifacts",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string sourcePath = Path.Combine(directory, "CoreLibraryService.gs");
        string outputPath = Path.Combine(directory, "Oahu.Cli.App.dll");
        File.WriteAllText(sourcePath, source);

        var args = new List<string>
        {
            "/out:" + outputPath,
            "/target:exe",
            "/targetframework:net10.0",
        };
        args.AddRange(TrustedPlatformAssemblies().Select(path => "/reference:" + path));
        args.Add(sourcePath);

        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        TextWriter previousOut = Console.Out;
        TextWriter previousError = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        int exitCode;
        try
        {
            exitCode = Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        Assert.True(exitCode == 0, $"compile failed ({exitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return new CompilationResult(directory, outputPath);
    }

    private static string Run(string assemblyPath)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath)!,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Failed to start dotnet exec.");
        string stdout = process.StandardOutput.ReadToEnd();
        string stderr = process.StandardError.ReadToEnd();
        Assert.True(process.WaitForExit(30_000), "dotnet exec timed out.");
        Assert.True(process.ExitCode == 0, $"exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        string value = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        return string.IsNullOrEmpty(value)
            ? Enumerable.Empty<string>()
            : value.Split(Path.PathSeparator);
    }

    private sealed class CompilationResult : IDisposable
    {
        public CompilationResult(string directoryPath, string outputPath)
        {
            DirectoryPath = directoryPath;
            OutputPath = outputPath;
        }

        public string DirectoryPath { get; }

        public string OutputPath { get; }

        public void Dispose()
        {
            try
            {
                Directory.Delete(DirectoryPath, recursive: true);
            }
            catch
            {
            }
        }
    }
}
