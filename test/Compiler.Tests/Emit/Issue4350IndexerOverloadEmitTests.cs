// <copyright file="Issue4350IndexerOverloadEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;
using SourceText = GSharp.Core.CodeAnalysis.Text.SourceText;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// ADR-0187 / issue #4350: overloaded user indexers compile, verify, and run,
/// and each overload is emitted as its own <c>Item</c> property so a C#
/// consumer sees the same overload set a C# declaration would produce.
/// </summary>
public class Issue4350IndexerOverloadEmitTests
{
    private const string Library = """
        package Lib
        import System

        struct Buffer[T](items []T) {
            prop this[index int32] ref T -> items[index]
            prop this[index System.Index] ref T -> items[index.GetOffset(items.Length)]
            prop this[index int32, fromEnd bool] ref T -> items[if fromEnd { items.Length - index } else { index }]

            shared {
                func Of(items []T) Buffer[T] -> Buffer[T](items)
            }
        }

        class Table {
            private var values []string = []string{"a", "b", "c"}
            prop this[index int32] string {
                get { return values[index] }
                set { values[index] = value }
            }
            prop this[name string] string {
                get { return name + "!" }
            }
            prop this[row int32, column int32] int32 -> row * 10 + column
        }
        """;

    [Fact]
    public void OverloadedIndexers_CompileVerifyAndRun()
    {
        var source = """
            package P
            import System

            struct Buffer[T](items []T) {
                prop this[index int32] ref T -> items[index]
                prop this[index System.Index] ref T -> items[index.GetOffset(items.Length)]
                prop this[index int32, fromEnd bool] ref T -> items[if fromEnd { items.Length - index } else { index }]
            }

            class Table {
                private var values []string = []string{"a", "b", "c"}
                prop this[index int32] string {
                    get { return values[index] }
                    set { values[index] = value }
                }
                prop this[name string] string {
                    get { return name + "!" }
                }
                prop this[row int32, column int32] int32 -> row * 10 + column
            }

            let buffer = Buffer[int32]([]int32{10, 20, 30})
            Console.WriteLine(buffer[0])
            Console.WriteLine(buffer[^1])
            let last = ^2
            Console.WriteLine(buffer[last])
            Console.WriteLine(buffer[1, true])
            var mutable = Buffer[int32]([]int32{1, 2, 3})
            mutable[0] = 5
            mutable[^1] = 9
            Console.WriteLine(mutable[0] + mutable[2])
            let table = Table()
            table[1] = "z"
            Console.WriteLine(table[1])
            Console.WriteLine(table["key"])
            Console.WriteLine(table[2, 3])
            """;

        var nl = Environment.NewLine;
        Assert.Equal($"10{nl}30{nl}20{nl}30{nl}14{nl}z{nl}key!{nl}23{nl}", CompileAndRun(source));
    }

    [Fact]
    public void MultiParameterIndexers_SupportWritesAndCompoundAssignment()
    {
        var source = """
            package P
            import System
            import System.Collections.Generic

            class Grid {
                private var cells []int32 = []int32{0, 0, 0, 0}
                prop this[index int32] int32 {
                    get { return cells[index] }
                    set { cells[index] = value }
                }
                prop this[row int32, column int32] int32 {
                    get { return cells[row * 2 + column] }
                    set { cells[row * 2 + column] = value }
                }
            }

            struct Buffer[T](items []T) {
                prop this[index int32] ref T -> items[index]
                prop this[index int32, fromEnd bool] ref T -> items[if fromEnd { items.Length - index } else { index }]
            }

            func next(log List[string], name string, value int32) int32 {
                log.Add(name)
                return value
            }

            let log = List[string]()
            let g = Grid()
            g[1] += 5
            g[next(log, "row", 1), next(log, "column", 1)] = 7
            g[next(log, "row", 1), next(log, "column", 1)] += 1
            Console.WriteLine(g[1])
            Console.WriteLine(g[3])
            Console.WriteLine(g[1, 1])
            Console.WriteLine(String.Join(",", log))
            var buffer = Buffer[int32]([]int32{1, 2, 3})
            buffer[1, true] = 9
            buffer[0, false] += 10
            Console.WriteLine(buffer[2])
            Console.WriteLine(buffer[0])
            """;

        var nl = Environment.NewLine;
        Assert.Equal($"5{nl}8{nl}8{nl}row,column,row,column{nl}9{nl}11{nl}", CompileAndRun(source));
    }

    [Fact]
    public void GenericParameterAndConcreteIndexerOverloads_DispatchBySignature()
    {
        // Review finding: a `this[key T]` parameter has no reflected CLR type,
        // so it must not match any same-arity overload — `this[index int32]`
        // and `this[key T]` each dispatch to their own accessor.
        var source = """
            package P
            import System

            class Lookup[T] {
                prop this[key T] string -> "key:" + key.ToString()
                prop this[index int32] string -> "index:" + index.ToString()
            }

            func probe[U](lookup Lookup[U], key U) string -> lookup[key] + "|" + lookup[1]

            let lookup = Lookup[string]()
            Console.WriteLine(lookup["a"])
            Console.WriteLine(lookup[2])
            Console.WriteLine(probe(lookup, "b"))
            Console.WriteLine(probe(Lookup[bool](), true))
            """;

        Assert.Equal(
            string.Join(Environment.NewLine, "key:a", "index:2", "key:b|index:1", "key:True|index:1") + Environment.NewLine,
            CompileAndRun(source));
    }

    [Fact]
    public void OverloadedIndexers_EmitOneItemPropertyPerSignature()
    {
        var libraryPath = EmitGSharpLibrary("Shape", Library);
        var assembly = EmittedFixture.Load(libraryPath);

        var table = assembly.GetTypes().Single(t => t.Name == "Table");
        var tableIndexers = table.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.Name == "Item")
            .Select(p => string.Join(",", p.GetIndexParameters().Select(i => i.ParameterType.Name)))
            .OrderBy(s => s, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(new[] { "Int32", "Int32,Int32", "String" }, tableIndexers);
        Assert.Equal("Item", table.GetCustomAttribute<DefaultMemberAttribute>()?.MemberName);

        var buffer = assembly.GetTypes().Single(t => t.Name.StartsWith("Buffer", StringComparison.Ordinal));
        var bufferIndexers = buffer.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(p => p.Name == "Item")
            .ToArray();
        Assert.Equal(3, bufferIndexers.Length);
        Assert.All(bufferIndexers, p => Assert.True(p.PropertyType.IsByRef));
    }

    [Fact]
    public void CSharpConsumer_SelectsEachOverload()
    {
        var libraryPath = EmitGSharpLibrary("Consumer", Library);
        var consumerPath = EmitCSharpConsumer(
            "Consumer",
            """
            public static class Probe
            {
                public static string Run()
                {
                    var table = new Lib.Table();
                    table[0] = "q";
                    var buffer = Lib.Buffer<int>.Of(new[] { 1, 2, 3 });
                    buffer[^1] = 8;
                    return table[0] + table["x"] + table[4, 2] + buffer[0] + buffer[2] + buffer[1, true];
                }
            }
            """,
            libraryPath);

        var assemblies = EmittedFixture.LoadTogether(libraryPath, consumerPath);
        var probe = assemblies[1].GetType("Probe", throwOnError: true)!;
        var result = probe.GetMethod("Run")!.Invoke(null, null);
        Assert.Equal("qx!42188", result);
    }

    private static string EmitGSharpLibrary(string caseName, string source)
    {
        var assemblyPath = Path.Combine(LibraryDirectory(), "Issue4350Indexers." + caseName + ".dll");
        var compilation = new GsCompilation(GsSyntaxTree.Parse(SourceText.From(source))) { IsLibrary = true };
        using (var peStream = File.Create(assemblyPath))
        {
            var result = compilation.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue4350Indexers." + caseName);
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        }

        IlVerifier.Verify(assemblyPath);
        return assemblyPath;
    }

    private static string EmitCSharpConsumer(string caseName, string source, string libraryPath)
    {
        var outputDir = Path.Combine(LibraryDirectory(), caseName);
        Directory.CreateDirectory(outputDir);
        var consumerPath = Path.Combine(outputDir, "Issue4350IndexerConsumer.dll");
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .Append(MetadataReference.CreateFromFile(libraryPath))
            .ToList();
        var compilation = CSharpCompilation.Create(
            "Issue4350IndexerConsumer",
            new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using (var peStream = File.Create(consumerPath))
        {
            var emitResult = compilation.Emit(peStream);
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics));
        }

        IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });
        return consumerPath;
    }

    private static string LibraryDirectory()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Issue4350IndexerOverloads");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string CompileAndRun(string source)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4350_indexers_").FullName;
        try
        {
            var srcPath = Path.Combine(tempDir, "test.gs");
            var outPath = Path.Combine(tempDir, "test.dll");
            File.WriteAllText(srcPath, source);

            using var compileOut = new StringWriter();
            using var compileErr = new StringWriter();
            var prevOut = Console.Out;
            var prevErr = Console.Error;
            Console.SetOut(compileOut);
            Console.SetError(compileErr);
            int compileExit;
            try
            {
                compileExit = Program.Main(new[]
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                    srcPath,
                });
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath);

            var psi = new ProcessStartInfo("dotnet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                WorkingDirectory = tempDir,
            };
            psi.ArgumentList.Add("exec");
            psi.ArgumentList.Add("--runtimeconfig");
            psi.ArgumentList.Add(Path.ChangeExtension(outPath, ".runtimeconfig.json"));
            psi.ArgumentList.Add(outPath);

            using var proc = Process.Start(psi)!;
            var stdout = proc.StandardOutput.ReadToEnd();
            var stderr = proc.StandardError.ReadToEnd();
            Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
            Assert.True(
                proc.ExitCode == 0,
                $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");

            return stdout.ReplaceLineEndings(Environment.NewLine);
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
}
