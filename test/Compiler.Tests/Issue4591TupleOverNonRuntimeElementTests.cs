// <copyright file="Issue4591TupleOverNonRuntimeElementTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using GSharp.Compiler;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #4591: a tuple whose element is an imported type that is not a host
/// <c>RuntimeType</c> (<c>(int32, Type)</c>, <c>(int32, Uri)</c>, a tuple over
/// a class from a referenced library) got a poisoned CLR backing type, so an
/// array of it could not convert to <c>IEnumerable[(…)]</c>.
/// </summary>
/// <remarks>
/// <para><b>The mechanism.</b> <c>TupleTypeSymbol.BuildClrType</c> closed the
/// HOST <c>typeof(ValueTuple&lt;,&gt;)</c> over the elements' CLR types. The
/// G# primitives (<c>int32</c>, <c>string</c>, <c>object</c>, …) are bound to
/// host <c>typeof(...)</c> literals, but every other imported type is loaded
/// through the compiler's <c>MetadataLoadContext</c>. Given one such argument,
/// <c>RuntimeType.MakeGenericType</c> does not throw: it silently returns a
/// <c>System.Reflection.Emit.TypeBuilderInstantiation</c>, whose
/// <c>GetInterfaces</c> and member lookups throw
/// <see cref="NotSupportedException"/> ("Not supported in a non-reflected
/// type"). This is the mechanism #4015 fixed for <c>map[K, V]</c> at its emit
/// sites; for a tuple the poisoned type is the symbol's own
/// <c>ClrType</c>, so the binder trips over it first.</para>
/// <para><b>How it surfaced.</b> The self-migrated
/// <c>Issue4313ReferenceReceiverCallvirtTests</c> passes
/// <c>[](OpCode, Method MethodBase?)</c> to xunit's <c>Assert.Single</c>. The
/// generic <c>Single&lt;T&gt;(IEnumerable&lt;T&gt;)</c> became inapplicable, so
/// overload resolution silently chose the non-generic
/// <c>Single(IEnumerable)</c> returning <c>object</c>, and the following
/// <c>call.Item1</c> / <c>call.Item2</c> reported GS0158. A plain
/// conversion of the same array to <c>IEnumerable[(int32, Type)]</c> was an
/// internal compiler error (GS9998).</para>
/// <para><b>The fix.</b> The tuple is closed in its elements' own load
/// context: the matching <c>ValueTuple`N</c> is resolved from that context's
/// core assembly and any host primitive element is remapped into it (the same
/// rule <c>MemberLookup.ResolveErasedValueTupleOpenDefinition</c> already
/// applied to erased inference shapes). When no load context can be found the
/// tuple stays symbolic (a null <c>ClrType</c>, the state a tuple over a
/// same-compilation type already has) instead of carrying the poisoned
/// instantiation.</para>
/// <para><b>Discrimination witness (ADR-0154).</b> Reverting
/// <c>src/Core/CodeAnalysis/Symbols/TupleTypeSymbol.cs</c> to its parent
/// state fails every <c>TupleOverANonRuntimeElement_CompilesVerifiesAndRuns</c>
/// row (GS9998 or GS0158/GS0159) and leaves every
/// <c>AGreenNeighbour_CompilesVerifiesAndRuns</c> row passing.</para>
/// </remarks>
public class Issue4591TupleOverNonRuntimeElementTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library the imported rows link against. <c>Picker</c> mirrors
    /// the overload set of xunit's <c>Assert.Single</c>: a generic
    /// <c>IEnumerable&lt;T&gt;</c> overload next to a non-generic
    /// <c>IEnumerable</c> one, so a lost generic candidate is observable as
    /// the wrong overload rather than as a missing function.
    /// </summary>
    private const string LibrarySource = """
        using System.Collections;
        using System.Collections.Generic;

        namespace HelperLib;

        public class ImportedBase
        {
            public string Name { get; set; } = "base";
        }

        public struct ImportedPoint
        {
            public int X { get; set; }

            public int Y { get; set; }
        }

        public interface IImportedShape
        {
            string Shape { get; }
        }

        public sealed class Square : IImportedShape
        {
            public string Shape => "square";
        }

        public static class Picker
        {
            public static T Single<T>(IEnumerable<T> items)
            {
                T? found = default;
                var count = 0;
                foreach (var item in items)
                {
                    found = item;
                    count++;
                }

                return count == 1 ? found! : throw new System.InvalidOperationException("not single");
            }

            public static object? Single(IEnumerable items) => null;

            public static int Count<T>(IEnumerable<T> items)
            {
                var count = 0;
                foreach (var unused in items)
                {
                    count++;
                }

                return count;
            }
        }
        """;

    /// <summary>
    /// The rows that failed before the fix. Every one is a tuple with at least
    /// one element whose <c>ClrType</c> is not a host <c>RuntimeType</c>.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> FailingCases()
    {
        // The GS9998 crash: no imported library involved at all, only a BCL
        // class (`System.Type`) in the tuple.
        yield return new object[]
        {
            "bcl-class-element-to-ienumerable",
            """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            let xs = [](int32, Type){(1, typeof(string)), (2, typeof(int32))}
            let e IEnumerable[(int32, Type)] = xs
            Console.WriteLine(e.Count())
            """,
            new[] { "2" },
        };

        // The same crash through a read-only list interface.
        yield return new object[]
        {
            "bcl-class-element-to-ireadonlylist",
            """
            package P
            import System
            import System.Collections.Generic

            let xs = [](int32, Uri){(7, Uri("https://example.org/"))}
            let e IReadOnlyList[(int32, Uri)] = xs
            Console.WriteLine(e[0].Item2.Host)
            """,
            new[] { "example.org" },
        };

        // The migrated Issue4313 shape: inference against an imported generic
        // that has a non-generic sibling overload. Before the fix the generic
        // candidate dropped out, the `object?` overload won, and `.Item1`
        // reported GS0158.
        yield return new object[]
        {
            "inference-picks-the-generic-overload-named-tuple",
            """
            package P
            import System
            import HelperLib

            let calls = [](Code int32, Method Type?){(3, typeof(string))}
            let call = Picker.Single(calls)
            Console.WriteLine(call.Item1)
            Console.WriteLine(call.Item2!!.Name)
            Console.WriteLine(call.Method!!.Name)
            """,
            new[] { "3", "String", "String" },
        };

        // A class from the referenced library (not in the core assembly).
        yield return new object[]
        {
            "imported-library-class-element",
            """
            package P
            import System
            import HelperLib

            let pairs = [](int32, ImportedBase){(5, ImportedBase{Name: "five"})}
            let pair = Picker.Single(pairs)
            Console.WriteLine(pair.Item1)
            Console.WriteLine(pair.Item2.Name)
            """,
            new[] { "5", "five" },
        };

        // An imported INTERFACE element, which has no base-type chain to find
        // its load context through.
        yield return new object[]
        {
            "imported-library-interface-element",
            """
            package P
            import System
            import HelperLib

            let pairs = [](int32, IImportedShape){(9, Square{})}
            Console.WriteLine(Picker.Count(pairs))
            let pair = Picker.Single(pairs)
            Console.WriteLine(pair.Item2.Shape)
            """,
            new[] { "1", "square" },
        };

        // A NULLABLE imported value type. Its `Nullable<T>` used to be built
        // from the host `typeof(Nullable<>)` before the tuple ever saw it, an
        // instantiation that is already poisoned (the #4035 trap), so the
        // wrapper has to be built in the context too.
        yield return new object[]
        {
            "nullable-bcl-struct-element-to-ienumerable",
            """
            package P
            import System
            import System.Collections.Generic
            import System.Linq

            let xs = [](int32, DateTime?){(1, DateTime(2020, 1, 2)), (2, nil)}
            let e IEnumerable[(int32, DateTime?)] = xs
            Console.WriteLine(e.Count())
            Console.WriteLine(e.Last().Item2.HasValue)
            """,
            new[] { "2", "False" },
        };

        yield return new object[]
        {
            "nullable-library-struct-element-inference",
            """
            package P
            import System
            import HelperLib

            let pairs = [](int32, ImportedPoint?){(6, ImportedPoint{X: 3, Y: 4})}
            let pair = Picker.Single(pairs)
            Console.WriteLine(pair.Item1)
            Console.WriteLine(pair.Item2!!.X)
            """,
            new[] { "6", "3" },
        };
    }

    /// <summary>
    /// Neighbours that always worked: tuples over host primitives only, and
    /// non-tuple containers of a non-runtime element.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> GreenNeighbours()
    {
        yield return new object[]
        {
            "primitive-only-tuple",
            """
            package P
            import System
            import HelperLib

            let xs = [](int32, string){(4, "four")}
            let x = Picker.Single(xs)
            Console.WriteLine(x.Item1)
            Console.WriteLine(x.Item2)
            """,
            new[] { "4", "four" },
        };

        yield return new object[]
        {
            "array-of-non-runtime-element",
            """
            package P
            import System
            import HelperLib

            let xs = []Type{typeof(string)}
            Console.WriteLine(Picker.Single(xs).Name)
            """,
            new[] { "String" },
        };

        yield return new object[]
        {
            "tuple-literal-construction-and-read",
            """
            package P
            import System

            let t = (1, typeof(string))
            Console.WriteLine(t.Item2.Name)
            """,
            new[] { "String" },
        };

        // Explicit type arguments bypass inference and already bound before the
        // fix; kept so the context-aware construction cannot regress them.
        yield return new object[]
        {
            "explicit-type-arguments",
            """
            package P
            import System
            import HelperLib

            let xs = [](int32, Version){(1, Version(1, 2))}
            Console.WriteLine(Picker.Count[(int32, Version)](xs))
            """,
            new[] { "1" },
        };
    }

    /// <summary>
    /// Each failing row now compiles, verifies, and prints the expected lines.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(FailingCases))]
    public void TupleOverANonRuntimeElement_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
        => CompileVerifyAndRun(name, source, expectedLines);

    /// <summary>
    /// The neighbours that always worked keep working, and print what they
    /// always printed.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(GreenNeighbours))]
    public void AGreenNeighbour_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
        => CompileVerifyAndRun(name, source, expectedLines);

    private static void CompileVerifyAndRun(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4591_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
            Assert.DoesNotContain(" error ", appLog, StringComparison.Ordinal);
            Assert.True(File.Exists(appPath), $"'{name}' must compile. Log:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");

            var lines = output
                .Split('\n')
                .Select(line => line.TrimEnd('\r'))
                .Where(line => line.Length > 0)
                .ToArray();
            Assert.Equal(expectedLines, lines);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string CompileCSharpLibrary(string tempDir)
    {
        var references = TrustedPlatformAssemblies()
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "HelperLib",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "HelperLib.dll");
        var result = compilation.Emit(libPath);
        Assert.True(
            result.Success,
            "the C# library must compile:\n"
                + string.Join("\n", result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)));

        return libPath;
    }

    // Compiles against the targeting pack (`/targetframework` only, no
    // runtime-assembly references), which is how the self-migrated projects
    // and the original repro are compiled: BCL classes such as `System.Type`
    // then load through the compiler's MetadataLoadContext.
    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        args.Add(srcPath);

        using var compileOut = new StringWriter();
        using var compileErr = new StringWriter();
        var prevOut = Console.Out;
        var prevErr = Console.Error;
        Console.SetOut(compileOut);
        Console.SetError(compileErr);
        try
        {
            Program.Main(args.ToArray());
        }
        finally
        {
            Console.SetOut(prevOut);
            Console.SetError(prevErr);
        }

        return compileOut.ToString() + compileErr;
    }

    private static (int Exit, string Output) RunDotnet(string assemblyPath)
    {
        var psi = new ProcessStartInfo("dotnet", $"\"{assemblyPath}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(assemblyPath) ?? ".",
        };

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("could not start dotnet");

        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(RunTimeout))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // The process exited between the timeout and the kill.
            }

            return (-1, $"timed out after {RunTimeout / 1000}s.");
        }

        var output = new StringBuilder();
        output.Append(stdout.GetAwaiter().GetResult());
        output.Append(stderr.GetAwaiter().GetResult());
        return (process.ExitCode, output.ToString());
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            return Enumerable.Empty<string>();
        }

        return tpa.Split(Path.PathSeparator).Where(File.Exists);
    }
}
