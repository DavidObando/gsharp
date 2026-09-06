// <copyright file="Issue4015MapLiteralNonRuntimeTypeArgumentTests.cs" company="GSharp">
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
/// Issue #4015: a <c>map[K, V]</c> whose key or value is an ordinary CLR type
/// crashed the compiler with the internal-error <c>GS9998</c>
/// (<c>NotSupportedException: TypeBuilder generic instantiation does not support
/// resolving members</c>).
/// </summary>
/// <remarks>
/// <para><b>The mechanism, confirmed by direct measurement.</b>
/// <c>MapTypeSymbol.MakeClrType</c> builds the backing type as
/// <c>typeof(Dictionary&lt;,&gt;).MakeGenericType(key.ClrType, value.ClrType)</c>.
/// <c>RuntimeType.MakeGenericType</c> returns a real <c>RuntimeType</c> only
/// when EVERY type argument is itself a <c>RuntimeType</c>; give it one that is
/// not and it falls back to a
/// <c>System.Reflection.Emit.TypeBuilderInstantiation</c>, whose
/// <c>GetConstructor</c> and <c>GetMethod</c> both throw
/// <see cref="NotSupportedException"/>. A standalone reflection probe over the
/// compiler's own <c>MetadataLoadContext</c> shape reproduces it exactly:
/// <c>MakeGenericType(typeof(string), typeof(int))</c> gives
/// <c>System.RuntimeType</c> and resolves members, while
/// <c>MakeGenericType(typeof(string), mlcDateTime)</c> — where the second
/// argument is an <c>EcmaDefinitionType</c> — gives
/// <c>TypeBuilderInstantiation</c> and throws the exact message the compiler
/// reported.</para>
/// <para><b>The issue's diagnosis is too narrow, and the fixture says so.</b>
/// It names the failing ingredient as "an imported reference type as the map
/// literal's value type". Measured on <c>a09f4e1b</c>, the crash needs no
/// imported library at all and no reference type: <c>map[string, DateTime]{}</c>,
/// <c>map[string, Guid]{}</c>, <c>map[string, TimeSpan]{}</c> and
/// <c>map[string, List[int32]]{}</c> all crashed, as did an imported STRUCT and
/// an imported type in the KEY position. The real predicate is "a key or value
/// whose <c>ClrType</c> is not a host <c>RuntimeType</c>" — i.e. everything
/// except the handful of G# primitives bound to a literal <c>typeof(...)</c>.
/// The green controls are exactly that handful: <c>int32</c>, <c>float64</c>,
/// <c>bool</c>, <c>string</c>, <c>object</c>. A same-compilation class was green
/// for the opposite reason — its <c>ClrType</c> is NULL, so the
/// <c>ClrType == null</c> branch #1481 added already carried it.</para>
/// <para><b>The fix, and its blast radius.</b> That #1481 branch already builds
/// the right MemberRefs — parented at the reified TypeSpec, with
/// <c>!0</c>/<c>!1</c> parameter signatures — so the three emit sites that
/// reflect on the closed dictionary now fall through to it when the reflection
/// throws, rather than learning a second technique. The rows that resolved
/// members before still resolve them and emit byte-identically. The precedent is
/// #1449's <c>GetDelegateCtorReference</c>, which catches the same exception
/// from the same cause.</para>
/// <para><b>Three emit sites, not one.</b> The issue's repro is an EMPTY map
/// literal, so it only ever reached <c>GetConstructor</c>. Fixing that alone
/// moved the crash one line down, twice, which is why this fixture exercises
/// every map operation rather than construction: a non-empty literal reaches
/// <c>EmitMapLiteral</c>'s <c>set_Item</c>, <c>m[k]</c> reaches
/// <c>EmitMapIndexRead</c>'s <c>TryGetValue</c>, and <c>m[k] = v</c> reaches
/// <c>EmitMapIndexAssignment</c>'s <c>set_Item</c>. All three are fixed.</para>
/// <para><b>Sibling literal forms do NOT share the crash, measured.</b> A slice
/// literal (<c>[]ImportedBase{…}</c>, <c>[]TimeSpan{…}</c>) never reflects on a
/// constructed generic — a slice is a plain CLR array. A tuple literal was
/// already covered: <c>EmitTupleLiteral</c> routes an
/// <c>IsConstructedGenericType</c> target through
/// <c>GetCtorReferenceOnConstructedGeneric</c> for exactly this reason (#649).
/// Both are kept as green rows here so a future change cannot quietly lose
/// that. NESTED literals did share it, because the outer map is still a map:
/// <c>map[string, []ImportedBase]{}</c> and
/// <c>map[string, map[string, ImportedBase]]{}</c> both crashed and are green
/// rows now.</para>
/// <para><b>Discrimination witness (ADR-0154).</b> Reverting
/// <c>src/Core/CodeAnalysis/Emit/MethodBodyEmitter.Expressions.cs</c> and
/// <c>MethodBodyEmitter.MemberAccess.cs</c> to their parent state fails every
/// <c>MapOverANonRuntimeTypeArgument_CompilesVerifiesAndRuns</c> row with
/// <c>GS9998</c> and leaves every
/// <c>AGreenNeighbour_CompilesVerifiesAndRuns</c> row passing.</para>
/// <para><b>Out of scope, filed separately.</b> A map whose value is a CLASS —
/// imported OR same-compilation — cannot bind <c>.Count</c>,
/// <c>.Remove(k)</c> or <c>.ContainsKey(k)</c> (<c>GS0159</c>), and
/// <c>for k, v in m</c> over one with an IMPORTED value reports <c>GS9998</c>
/// from an unresolved expression reaching emission. That is a BINDING-phase gap
/// in the symbolic Dictionary receiver view, not this emit bug: it reproduces
/// on <c>map[string, Derived]</c> for a same-compilation <c>Derived</c>, a row
/// #4015 itself calls "fine", and it was measured on the unmodified compiler
/// before any change here, and it is filed as issue #4023. Hence this fixture
/// reads maps through <c>m[k]</c> and never through <c>.Count</c>.</para>
/// </remarks>
public class Issue4015MapLiteralNonRuntimeTypeArgumentTests
{
    /// <summary>Timeout for running an emitted sample.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>The C# library the imported-type rows link against.</summary>
    private const string LibrarySource = """
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
        """;

    /// <summary>
    /// The rows that reported <c>GS9998</c> before the fix. Every one of them
    /// has a key or value whose <c>ClrType</c> is not a host
    /// <c>RuntimeType</c>.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> CrashingCases()
    {
        // The issue's own repro, minus the `.Count` read it spells (see the
        // out-of-scope note in this class's remarks): an EMPTY map literal over
        // an imported reference type. This alone reached only `GetConstructor`.
        yield return new object[]
        {
            "empty-literal-imported-class",
            """
            package P
            import System
            import HelperLib

            let entries = map[string, ImportedBase]{}
            entries["k"] = ImportedBase{}
            Console.WriteLine(entries["k"].Name)
            """,
            new[] { "base" },
        };

        // Non-empty: adds `EmitMapLiteral`'s `set_Item`, which the issue's empty
        // repro never reached.
        yield return new object[]
        {
            "populated-literal-imported-class",
            """
            package P
            import System
            import HelperLib

            let entries = map[string, ImportedBase]{"k": ImportedBase{Name: "one"}}
            Console.WriteLine(entries["k"].Name)
            """,
            new[] { "one" },
        };

        // The title's "value type", taken literally: an imported STRUCT.
        yield return new object[]
        {
            "populated-literal-imported-struct",
            """
            package P
            import System
            import HelperLib

            let entries = map[string, ImportedPoint]{"a": ImportedPoint{X: 3, Y: 4}}
            let p = entries["a"]
            Console.WriteLine(p.X.ToString() + "," + p.Y.ToString())
            """,
            new[] { "3,4" },
        };

        // The KEY position, which the issue does not mention at all.
        yield return new object[]
        {
            "imported-class-in-the-key-position",
            """
            package P
            import System
            import HelperLib

            let k = ImportedBase{Name: "key"}
            let entries = map[ImportedBase, string]{k: "v"}
            Console.WriteLine(entries[k])
            """,
            new[] { "v" },
        };

        // No imported library at all: a plain BCL value type. This row is the
        // correction to the issue's diagnosis.
        yield return new object[]
        {
            "bcl-value-type-no-imported-library",
            """
            package P
            import System

            let entries = map[string, TimeSpan]{"a": TimeSpan.FromSeconds(3)}
            Console.WriteLine(entries["a"].TotalSeconds.ToString())
            """,
            new[] { "3" },
        };

        // A BCL generic reference type, likewise with no library in sight.
        yield return new object[]
        {
            "bcl-generic-reference-type",
            """
            package P
            import System
            import System.Collections.Generic

            let inner = List[int32]()
            inner.Add(7)
            let entries = map[string, List[int32]]{"a": inner}
            Console.WriteLine(entries["a"][0].ToString())
            """,
            new[] { "7" },
        };

        // Nested: a slice of an imported type as the map's value.
        yield return new object[]
        {
            "nested-slice-value",
            """
            package P
            import System
            import HelperLib

            let entries = map[string, []ImportedBase]{"a": []ImportedBase{ImportedBase{Name: "n"}}}
            Console.WriteLine(entries["a"][0].Name)
            """,
            new[] { "n" },
        };

        // Nested: a map of maps. The outer literal is still a map literal.
        yield return new object[]
        {
            "nested-map-value",
            """
            package P
            import System
            import HelperLib

            let entries = map[string, map[string, ImportedBase]]{}
            entries["outer"] = map[string, ImportedBase]{"inner": ImportedBase{Name: "deep"}}
            Console.WriteLine(entries["outer"]["inner"].Name)
            """,
            new[] { "deep" },
        };

        // A missing key must still produce the CLR default through the symbolic
        // `TryGetValue`, exactly as it does through the reflected one.
        yield return new object[]
        {
            "missing-key-yields-the-zero-value",
            """
            package P
            import System
            import HelperLib

            let entries = map[string, ImportedBase]{}
            Console.WriteLine((entries["nope"] == nil).ToString())
            """,
            new[] { "True" },
        };
    }

    /// <summary>
    /// The rows that were green before the fix and must stay green: the
    /// primitive elements whose closed dictionary really does resolve members,
    /// the same-compilation class the <c>ClrType == null</c> branch already
    /// carried, the <c>Dictionary[…]</c> spelling ADR-0104 says is the same
    /// type, and the sibling literal forms that never shared the crash.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> GreenNeighbours()
    {
        // `int32` is a host `RuntimeType`, so this row's emit is untouched.
        yield return new object[]
        {
            "primitive-value-type-element",
            """
            package P
            import System

            let entries = map[string, int32]{"a": 1}
            entries["b"] = 2
            Console.WriteLine(entries["a"].ToString() + entries["b"].ToString())
            """,
            new[] { "12" },
        };

        // `string` keeps its #1714 Go zero value ("" rather than the CLR null)
        // on a miss — a branch that sits right beside the changed code.
        yield return new object[]
        {
            "string-element-keeps-its-go-zero-value",
            """
            package P
            import System

            let entries = map[string, string]{"a": "x"}
            Console.WriteLine(entries["a"] + "|" + entries["zz"] + "|")
            """,
            new[] { "x||" },
        };

        // A same-compilation class: `ClrType` is null, so #1481's branch already
        // handled it, which is why the issue found this row "fine".
        yield return new object[]
        {
            "same-compilation-class-element",
            """
            package P
            import System
            import HelperLib

            class Derived : ImportedBase {
            }

            let d = Derived{}
            d.Name = "d"
            let entries = map[string, Derived]{}
            entries["k"] = d
            Console.WriteLine(entries["k"].Name)
            """,
            new[] { "d" },
        };

        // ADR-0104 says this IS the same type as `map[string, ImportedBase]`,
        // and it compiled throughout — the workaround #4019's fixture used.
        yield return new object[]
        {
            "dictionary-spelling-of-the-same-type",
            """
            package P
            import System
            import System.Collections.Generic
            import HelperLib

            let entries = Dictionary[string, ImportedBase]()
            entries["k"] = ImportedBase{Name: "dict"}
            Console.WriteLine(entries["k"].Name)
            """,
            new[] { "dict" },
        };

        // The sibling literal forms, over the very element types that crashed
        // the map literal. A slice is a plain CLR array; a tuple literal has
        // routed a constructed generic through the open definition since #649.
        yield return new object[]
        {
            "slice-literal-over-an-imported-type",
            """
            package P
            import System
            import HelperLib

            let items = []ImportedBase{ImportedBase{Name: "s"}}
            Console.WriteLine(items[0].Name)
            """,
            new[] { "s" },
        };

        yield return new object[]
        {
            "slice-literal-over-a-bcl-value-type",
            """
            package P
            import System

            let items = []TimeSpan{TimeSpan.FromSeconds(2)}
            Console.WriteLine(items[0].TotalSeconds.ToString())
            """,
            new[] { "2" },
        };

        yield return new object[]
        {
            "tuple-literal-over-an-imported-type",
            """
            package P
            import System
            import HelperLib

            let pair = (1, ImportedBase{Name: "t"})
            Console.WriteLine(pair.Item1.ToString() + pair.Item2.Name)
            """,
            new[] { "1t" },
        };

        yield return new object[]
        {
            "tuple-literal-over-a-bcl-value-type",
            """
            package P
            import System

            let pair = (1, TimeSpan.FromSeconds(2))
            Console.WriteLine(pair.Item2.TotalSeconds.ToString())
            """,
            new[] { "2" },
        };
    }

    /// <summary>
    /// A map whose key or value has no host <c>RuntimeType</c> compiles,
    /// IL-verifies and runs. Every row reported <c>GS9998</c> before the fix.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(CrashingCases))]
    public void MapOverANonRuntimeTypeArgument_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
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
        var tempDir = Directory.CreateTempSubdirectory("gs_4015_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
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

    private static string Compile(string dir, string fileName, string source, string outPath, params string[] extra)
    {
        var srcPath = Path.Combine(dir, fileName);
        File.WriteAllText(srcPath, source);
        var args = new List<string> { "/out:" + outPath, "/targetframework:net10.0" };
        args.AddRange(extra);
        foreach (var reference in TrustedPlatformAssemblies())
        {
            args.Add("/reference:" + reference);
        }

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
