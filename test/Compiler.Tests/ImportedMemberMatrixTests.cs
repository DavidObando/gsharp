// <copyright file="ImportedMemberMatrixTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests;

public class ImportedMemberMatrixTests
{
    [Fact]
    public void ImportedMemberMatrix_GenericImportedInterfaceMethodAndInterfaceObjectMembers_CompileAndRun()
    {
        const string csSource = """
            namespace ImportedMemberMatrix.CSharp
            {
                public interface IStore
                {
                    void Put<T>(T value);
                }

                public interface IHasDefault
                {
                    int Ping() => 7;
                }

                public sealed class DefaultThing : IHasDefault
                {
                    public override string ToString() => "thing";
                }
            }
            """;

        const string gsSource = """
            package ImportedMemberMatrix.Probe
            import ImportedMemberMatrix.CSharp
            import System

            class Store : IStore {
                func Put[T](value T) { Console.WriteLine(value.ToString()) }
            }

            var store IStore = Store()
            store.Put[int32](42)
            store.Put[string]("ok")

            var thing IHasDefault = DefaultThing()
            Console.WriteLine(thing.Ping())
            Console.WriteLine(thing.ToString())
            Console.WriteLine(thing.GetHashCode() == thing.GetHashCode())
            Console.WriteLine(thing.Equals(thing))
            """;

        Assert.Equal("42\nok\n7\nthing\nTrue\nTrue\n", CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp"));
    }

    [Fact]
    public void ImportedMemberMatrix_LinqExtensionsOnImportedGenericEnumerableReceivers_CompileAndRun()
    {
        const string csSource = """
            namespace ImportedMemberMatrix.CSharp
            {
                public sealed class Item
                {
                    public string Name { get; set; } = "";
                    public int Rank { get; set; }
                }
            }
            """;

        const string gsSource = """
            package ImportedMemberMatrix.Probe
            import ImportedMemberMatrix.CSharp
            import System
            import System.Collections.Generic
            import System.Linq

            var xs = List[Item]()
            var b = Item()
            b.Name = "b"
            b.Rank = 2
            xs.Add(b)
            var a = Item()
            a.Name = "a"
            a.Rank = 1
            xs.Add(a)

            var collection ICollection[Item] = xs
            var enumerable IEnumerable[Item] = collection
            Console.WriteLine(enumerable.FirstOrDefault() == nil)
            Console.WriteLine(collection.Any())
            Console.WriteLine(enumerable.Count())
            Console.WriteLine(enumerable.Where(func(i Item) bool { return i.Rank > 0 }).Count())
            Console.WriteLine(enumerable.OrderBy(func(i Item) int32 { return i.Rank }).Count())
            """;

        Assert.Equal("False\nTrue\n2\n2\n2\n", CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp"));
    }

    [Fact]
    public void ImportedMemberMatrix_ImportedRecordClassAndRecordStruct_WithCopy_CompileAndRun()
    {
        const string csSource = """
            namespace ImportedMemberMatrix.CSharp
            {
                public record PersonRecord(string Name, int Age);
                public readonly record struct PointRecord(int X, int Y);
            }
            """;

        const string gsSource = """
            package ImportedMemberMatrix.Probe
            import ImportedMemberMatrix.CSharp
            import System

            var p = PersonRecord("ana", 1)
            var p2 = p with { Age = 2 }
            Console.WriteLine(p.Name)
            Console.WriteLine(p.Age)
            Console.WriteLine(p2.Name)
            Console.WriteLine(p2.Age)

            var pt = PointRecord(3, 4)
            var pt2 = pt with { Y = 9 }
            Console.WriteLine(pt.X)
            Console.WriteLine(pt.Y)
            Console.WriteLine(pt2.X)
            Console.WriteLine(pt2.Y)
            """;

        Assert.Equal("ana\n1\nana\n2\n3\n4\n3\n9\n", CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp"));
    }

    [Fact]
    public void ImportedMemberMatrix_SourceOnlyDataAndLinqReceivers_StillBind()
    {
        const string source = """
            package ImportedMemberMatrix.SourceOnly
            import System
            import System.Collections.Generic
            import System.Linq

            data class SourceItem(Name string, Rank int32) {}

            var item = SourceItem("a", 1)
            var updated = item with { Name = "b" }
            Console.WriteLine(item.Name)
            Console.WriteLine(updated.Name)

            var xs = List[SourceItem]()
            xs.Add(item)
            xs.Add(updated)
            Console.WriteLine(xs.FirstOrDefault().Name)
            Console.WriteLine(xs.Where(func(i SourceItem) bool { return i.Rank == 1 }).Count())
            Console.WriteLine(xs.OrderBy(func(i SourceItem) string { return i.Name }).Count())
            """;

        Assert.Equal("a\nb\na\n2\n2\n", CompileAndRun(source));
    }

    [Fact]
    public void ImportedMemberMatrix_NonDataImportedClass_WithCopy_StillRejected()
    {
        const string csSource = """
            namespace ImportedMemberMatrix.CSharp
            {
                public sealed class PlainClass
                {
                    public string Name { get; set; } = "";
                }
            }
            """;

        const string gsSource = """
            package ImportedMemberMatrix.Probe
            import ImportedMemberMatrix.CSharp

            var value = PlainClass()
            value.Name = "before"
            var copy = value with { Name = "after" }
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp");
        Assert.Contains(diagnostics, d => d.Contains("GS0161", StringComparison.Ordinal));
        Assert.Contains(diagnostics, d => d.Contains("data class or data struct", StringComparison.Ordinal));
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var workDir = CreateWorkDir("imported_member_matrix_");
        try
        {
            var siblingDll = BuildCsLibrary(workDir, csSource, siblingName);
            File.Copy(siblingDll, Path.Combine(workDir, Path.GetFileName(siblingDll)), overwrite: true);
            return CompileAndRun(gSource, new[] { siblingDll }, workDir);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static List<string> CompileExpectingErrorsWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var workDir = CreateWorkDir("imported_member_matrix_err_");
        try
        {
            var siblingDll = BuildCsLibrary(workDir, csSource, siblingName);
            return CompileExpectingErrors(gSource, new[] { siblingDll }, workDir);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static string CompileAndRun(string source)
    {
        var workDir = CreateWorkDir("imported_member_matrix_source_");
        try
        {
            return CompileAndRun(source, Array.Empty<string>(), workDir);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static string CompileAndRun(string source, IReadOnlyCollection<string> references, string workDir)
    {
        var srcPath = Path.Combine(workDir, "test.gs");
        var outPath = Path.Combine(workDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = GscArgs(outPath, "exe", references, srcPath);
        var (exitCode, diagnostics) = RunCompiler(args);
        Assert.True(exitCode == 0, diagnostics);

        IlVerifier.Verify(outPath, additionalReferences: references);

        var runtimeConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json");
        if (!File.Exists(runtimeConfig))
        {
            File.WriteAllText(runtimeConfig, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);
        }

        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workDir,
        };
        psi.ArgumentList.Add("exec");
        psi.ArgumentList.Add("--runtimeconfig");
        psi.ArgumentList.Add(runtimeConfig);
        psi.ArgumentList.Add(outPath);

        using var proc = Process.Start(psi) ?? throw new InvalidOperationException("failed to start dotnet exec");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.Replace("\r\n", "\n");
    }

    private static List<string> CompileExpectingErrors(string source, IReadOnlyCollection<string> references, string workDir)
    {
        var srcPath = Path.Combine(workDir, "test.gs");
        var outPath = Path.Combine(workDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var (exitCode, diagnostics) = RunCompiler(GscArgs(outPath, "exe", references, srcPath));
        Assert.True(exitCode != 0, "expected gsc to report errors but it succeeded");
        return diagnostics.Split('\n', StringSplitOptions.RemoveEmptyEntries).ToList();
    }

    private static string[] GscArgs(string outPath, string target, IReadOnlyCollection<string> references, string srcPath)
    {
        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        foreach (var reference in references.Concat(TrustedPlatformAssemblies()))
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);
        return args.ToArray();
    }

    private static (int ExitCode, string Diagnostics) RunCompiler(string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args), stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }
    }

    private static string BuildCsLibrary(string workDir, string source, string assemblyName)
    {
        var csDir = Path.Combine(workDir, "csref");
        Directory.CreateDirectory(csDir);
        File.WriteAllText(Path.Combine(csDir, "Lib.cs"), source);
        File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Library</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
                <LangVersion>latest</LangVersion>
                <NoWarn>1591;SA1649;SA1518;SA1516;SA1122;SA1201</NoWarn>
                <RunAnalyzers>false</RunAnalyzers>
                <AssemblyName>{assemblyName}</AssemblyName>
                <RootNamespace>{assemblyName}</RootNamespace>
              </PropertyGroup>
            </Project>
            """);

        RunDotnet(csDir, "restore");
        var outDir = Path.Combine(csDir, "out");
        RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore", "-o", outDir);

        var dll = Path.Combine(outDir, assemblyName + ".dll");
        Assert.True(File.Exists(dll), $"sibling assembly not found at {dll}");
        return dll;
    }

    private static void RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var proc = Process.Start(psi) ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(120_000), $"dotnet {args[0]} timed out");
        Assert.True(proc.ExitCode == 0, $"dotnet {string.Join(" ", args)} failed ({proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static string CreateWorkDir(string prefix)
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

    private static void TryDelete(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch
        {
        }
    }
}
