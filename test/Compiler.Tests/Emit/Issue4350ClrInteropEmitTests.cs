// <copyright file="Issue4350ClrInteropEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4350: CLR interop shapes found by the Gsharp.Runtime.Values
/// self-migration. A ref-returning static CLR method auto-dereferences at the
/// use site (ADR-0056 §1), and an imported implicit conversion declared on the
/// SOURCE generic (<c>Span[T] -&gt; ReadOnlySpan[T]</c>) is parented at the
/// symbolic TypeSpec rather than the erased <c>&lt;object&gt;</c> instance.
/// </summary>
public class Issue4350ClrInteropEmitTests
{
    [Fact]
    public void RefReturningStaticClrCalls_AutoDereference()
    {
        var source = """
            package P
            import System
            import System.Runtime.CompilerServices
            import System.Runtime.InteropServices

            class Box[T] {
                shared {
                    func IsString(memory ReadOnlyMemory[T]) bool {
                        var memory = memory
                        return MemoryMarshal.TryGetString(Unsafe.As[ReadOnlyMemory[T], ReadOnlyMemory[char]](&memory), out _, out _, out _)
                    }
                }
            }

            let arr = []int32{7, 8}
            let first = MemoryMarshal.GetArrayDataReference(arr)
            Console.WriteLine(first + 1)
            var memory = ReadOnlyMemory[int32](arr)
            let reinterpreted = Unsafe.As[ReadOnlyMemory[int32], ReadOnlyMemory[uint32]](&memory)
            Console.WriteLine(reinterpreted.Length)
            Console.WriteLine(Box[char].IsString("abc".AsMemory()))
            Console.WriteLine(Box[int32].IsString(memory))
            """;

        Assert.Equal(Lines("8", "2", "True", "False"), CompileAndRun(source));
    }

    [Fact]
    public void SourceDeclaredGenericImplicitConversions_UseSymbolicOwner()
    {
        var source = """
            package P
            import System

            class Box[T] {
                let items []T
                init(items []T) {
                    this.items = items
                }

                func AsMemory() Memory[T] -> items.AsMemory()
                func AsReadOnlyMemory() ReadOnlyMemory[T] -> AsMemory()
                func Count() int32 {
                    let span Span[T] = items.AsSpan()
                    let view ReadOnlySpan[T] = span
                    return view.Length
                }
            }

            let box = Box[string]([]string{"a", "b", "c"})
            Console.WriteLine(box.AsReadOnlyMemory().Length)
            Console.WriteLine(box.Count())
            """;

        Assert.Equal(Lines("3", "3"), CompileAndRun(source));
    }

    [Fact]
    public void RefReturningImportedExtensionsAndStatics_StayAliasableAndWritable()
    {
        // Review question: auto-dereferencing a ref-returning imported call
        // must not lose its reference. The dereference is an lvalue, so a
        // `let ref` alias, a plain store and a compound store all go through
        // the returned reference, and a value read loads the pointee.
        var library = """
            namespace RefLib;
            public static class Ext
            {
                public static ref T First<T>(this T[] items) => ref items[0];
                public static ref int At(int[] items, int index) => ref items[index];
            }
            """;
        var source = """
            package P
            import System
            import RefLib

            func run() {
                let xs = []int32{1, 2, 3}
                let ref alias = xs.First()
                alias = 10
                Console.WriteLine(xs[0])
                xs.First() = 20
                Console.WriteLine(xs[0])
                let ref at = Ext.At(xs, 2)
                at = 30
                Console.WriteLine(xs[2])
                Ext.At(xs, 1) += 5
                Console.WriteLine(xs[1])
                Console.WriteLine(xs.First() + Ext.At(xs, 2))
            }

            run()
            """;

        var fixtureDirectory = Directory.CreateTempSubdirectory("gs_issue4350_reflib_").FullName;
        try
        {
            Assert.Equal(
                Lines("10", "20", "30", "7", "50"),
                CompileAndRun(source, CompileCSharpLibrary(library, "RefLib", fixtureDirectory)));
        }
        finally
        {
            try
            {
                Directory.Delete(fixtureDirectory, recursive: true);
            }
            catch
            {
            }
        }
    }

    private static string CompileCSharpLibrary(string source, string name, string directory)
    {
        var path = Path.Combine(directory, name + ".dll");
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Select(p => MetadataReference.CreateFromFile(p));
        var result = CSharpCompilation.Create(
                name,
                new[] { CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.Latest)) },
                references,
                new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary))
            .Emit(path);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }

    private static string Lines(params string[] lines)
        => string.Concat(Array.ConvertAll(lines, line => line + Environment.NewLine));

    private static string CompileAndRun(string source, params string[] references)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_issue4350_interop_").FullName;
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
                var compileArgs = new System.Collections.Generic.List<string>
                {
                    "/out:" + outPath,
                    "/target:exe",
                    "/targetframework:net10.0",
                };
                foreach (var reference in references)
                {
                    compileArgs.Add("/r:" + reference);
                    File.Copy(reference, Path.Combine(tempDir, Path.GetFileName(reference)), overwrite: true);
                }

                compileArgs.Add(srcPath);
                compileExit = Program.Main(compileArgs.ToArray());
            }
            finally
            {
                Console.SetOut(prevOut);
                Console.SetError(prevErr);
            }

            Assert.True(
                compileExit == 0,
                $"gsc failed:\nstdout:\n{compileOut}\nstderr:\n{compileErr}");
            IlVerifier.Verify(outPath, additionalReferences: references);

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
