// <copyright file="Issue4023MapMemberSurfaceOverImportedKeyOrValueTests.cs" company="GSharp">
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
/// Issue #4023: a <c>map[K, V]</c> whose key or value is an IMPORTED type lost
/// its entire <c>Dictionary</c> member surface — <c>.Count</c>, <c>.Clear()</c>,
/// <c>.Remove</c>, <c>.ContainsKey</c>, <c>.ContainsValue</c>, <c>.Add</c>,
/// <c>.TryGetValue</c>, <c>.Keys</c>, <c>.Values</c> and <c>for k, v in m</c> —
/// while the <c>Dictionary[K, V]</c> spelling of the SAME type (ADR-0104) kept
/// every one of them.
/// </summary>
/// <remarks>
/// <para><b>Root cause.</b> <c>MapTypeSymbol.MakeClrType</c> built the backing
/// type as <c>typeof(Dictionary&lt;,&gt;).MakeGenericType(key.ClrType,
/// value.ClrType)</c>. <c>RuntimeType.MakeGenericType</c> answers a real
/// <c>RuntimeType</c> only when EVERY argument is one; hand it a
/// <c>MetadataLoadContext</c> type — which is every imported type — and it
/// answers a <c>System.Reflection.Emit.TypeBuilderInstantiation</c> whose
/// <c>GetMethod</c>, <c>GetProperty</c> and <c>GetConstructor</c> all throw
/// <see cref="NotSupportedException"/>. That stand-in is NOT null, so every
/// <c>ClrType != null</c> gate in the binder took it for a reflectable
/// dictionary and member lookup came back empty. The fix builds the closed
/// dictionary in the key/value's OWN reflection context instead — which is
/// exactly what the <c>Dictionary[K, V]</c> spelling does, and why that
/// spelling was the green control all along.</para>
/// <para><b>The issue's own diagnosis is wrong on two axes, measured.</b> It
/// names the failing ingredient as "a map whose value is a CLASS". The real
/// predicate is "a key or value whose <c>ClrType</c> is not a host
/// <c>RuntimeType</c>" — the same predicate #4015 arrived at for the emit-phase
/// twin. A 93-row probe matrix on <c>565b9a04</c> put an imported STRUCT
/// (<c>DateTime</c>), an imported GENERIC (<c>List[int32]</c>) and the KEY
/// position in the failing set alongside the two classes, and put a
/// same-compilation class with NO imported base (<c>Plain</c>) in the passing
/// set beside <c>int32</c> and a same-compilation struct — because those erase
/// to a host <c>typeof(object)</c>. And <c>.Count</c> reported <b>GS9998</b>,
/// not the <c>GS0159</c> the issue records: #4031's candidate-collection change
/// (<c>565b9a04</c>) moved it after the issue was filed. Both corrections are
/// posted on the issue and pinned by the rows below.</para>
/// <para><b>Members the issue did not name are in the same fix.</b> Beyond
/// <c>.Count</c> / <c>.Remove</c> / <c>.ContainsKey</c> / <c>for..in</c>, the
/// matrix found <c>.Clear()</c> (GS9998), <c>.Add</c> / <c>.ContainsValue</c> /
/// <c>.TryGetValue</c> (GS0159) and <c>.Keys</c> / <c>.Values</c> (GS0158)
/// broken by the same cause; all are rows here. <c>m[k]</c> and
/// <c>m[k] = v</c> were NOT affected — #4015 already routes those three emit
/// sites around the same stand-in — and are kept as must-not-change rows.</para>
/// <para><b>Out of scope, measured and reported.</b> <c>len(m)</c> reports
/// GS0566 for EVERY map including <c>map[string, int32]</c>: <c>len</c> was
/// retired as a built-in by ADR-0174 D13, so that is by design, not this
/// bug.</para>
/// <para><b>Discrimination witness (ADR-0154).</b> Reverting
/// <c>src/Core/CodeAnalysis/Symbols/MapTypeSymbol.cs</c>,
/// <c>ClrTypeUtilities.cs</c>, <c>ReferenceResolver.cs</c>,
/// <c>Binding/MemberLookup.cs</c> and
/// <c>Emit/MethodBodyEmitter.MemberAccess.cs</c> to <c>565b9a04</c> turns every
/// <see cref="AcceptedCases"/> row red and leaves every
/// <see cref="ControlCases"/> row green.</para>
/// </remarks>
public class Issue4023MapMemberSurfaceOverImportedKeyOrValueTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library the imported-value rows link against: an ordinary class
    /// and an ordinary struct, both carrying a readable member so a green row
    /// can move a value through the map and print it.
    /// </summary>
    private const string LibrarySource = """
        namespace HelperLib;

        public class ImportedBase
        {
            public string Name { get; set; } = "base";
        }

        public struct ImportedPoint
        {
            public int X { get; set; }
        }
        """;

    /// <summary>
    /// Every row is <c>GS0158</c> / <c>GS0159</c> / <c>GS9998</c> on
    /// <c>565b9a04</c>. Each moves a real value through the member (or the
    /// loop) and prints it, so a binding that resolves to the wrong thing
    /// prints the wrong answer rather than merely compiling.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> AcceptedCases()
    {
        // The three members the issue names, over an IMPORTED class value,
        // each read back through Count so a no-op would be visible.
        yield return new object[]
        {
            "count-remove-and-containskey-over-an-imported-class-value",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var m = map[string, ImportedBase]{"a": ImportedBase{}, "b": ImportedBase{}}
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.ContainsKey("a").ToString())
                Console.WriteLine(m.Remove("a").ToString())
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.ContainsKey("a").ToString())
            }

            main2()
            """,
            new[] { "2", "True", "True", "1", "False" },
        };

        // The issue's worst row: `for k, v in m` over an imported value was a
        // GS9998 internal compiler error. Both the key AND the value are read
        // in the body.
        yield return new object[]
        {
            "for-k-v-in-a-map-with-an-imported-class-value",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var one = ImportedBase{}
                one.Name = "first"
                var m = map[string, ImportedBase]{"k": one}
                for k, v in m {
                    Console.WriteLine(k + "=" + v.Name)
                }
            }

            main2()
            """,
            new[] { "k=first" },
        };

        // A same-compilation class that EXTENDS an imported one. #4015 lists
        // this shape as a working control, and it is exactly where #4023 was
        // first seen: the class's own ClrType is null, so the erasure reaches
        // for its imported base's ClrType and lands back in the same
        // cross-context hole.
        yield return new object[]
        {
            "count-and-keys-over-a-same-compilation-class-with-an-imported-base",
            """
            package Demo
            import System
            import HelperLib

            class Derived : ImportedBase {
            }

            func main2() {
                var d = Derived{}
                d.Name = "derived"
                var m = map[string, Derived]{"x": d}
                Console.WriteLine(m.Count.ToString())
                for k in m.Keys {
                    Console.WriteLine(k)
                }

                for v in m.Values {
                    Console.WriteLine(v.Name)
                }
            }

            main2()
            """,
            new[] { "1", "x", "derived" },
        };

        // The members the issue did NOT name, over an imported class value.
        yield return new object[]
        {
            "add-containsvalue-trygetvalue-and-clear-over-an-imported-class-value",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var v = ImportedBase{}
                v.Name = "added"
                var m = map[string, ImportedBase]{}
                m.Add("a", v)
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.ContainsValue(v).ToString())

                var got ImportedBase
                Console.WriteLine(m.TryGetValue("a", out got).ToString())
                Console.WriteLine(got.Name)

                m.Clear()
                Console.WriteLine(m.Count.ToString())
            }

            main2()
            """,
            new[] { "1", "True", "True", "added", "0" },
        };

        // An imported STRUCT value — the axis the issue's "value is a CLASS"
        // diagnosis misses, and the one that also exposed a spurious `box` at
        // the argument before the fix took its final shape.
        yield return new object[]
        {
            "the-full-surface-over-an-imported-struct-value",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var p = ImportedPoint{}
                p.X = 7
                var m = map[string, ImportedPoint]{}
                m.Add("a", p)
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.ContainsValue(p).ToString())
                for k, v in m {
                    Console.WriteLine(k + "=" + v.X.ToString())
                }
            }

            main2()
            """,
            new[] { "1", "True", "a=7" },
        };

        // A BCL struct and a BCL generic reached the same hole: neither is a
        // class, and neither needs a user library at all.
        yield return new object[]
        {
            "the-full-surface-over-a-bcl-struct-and-a-bcl-generic-value",
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                var m = map[string, TimeSpan]{"a": TimeSpan.FromSeconds(2.0)}
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.ContainsKey("a").ToString())
                for k, v in m {
                    Console.WriteLine(k + "=" + v.TotalSeconds.ToString())
                }

                var g = map[string, List[int32]]{"b": List[int32]()}
                g["b"].Add(5)
                Console.WriteLine(g.Count.ToString())
                Console.WriteLine(g.ContainsKey("b").ToString())
                Console.WriteLine(g.Remove("b").ToString())
                Console.WriteLine(g.Count.ToString())
            }

            main2()
            """,
            new[] { "1", "True", "a=2", "1", "True", "True", "0" },
        };

        // The KEY position, which the issue does not mention at all.
        yield return new object[]
        {
            "the-member-surface-over-an-imported-key",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var k = ImportedBase{}
                k.Name = "key"
                var m = map[ImportedBase, int32]{}
                m.Add(k, 3)
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.ContainsKey(k).ToString())
                for pk, pv in m {
                    Console.WriteLine(pk.Name + "=" + pv.ToString())
                }
            }

            main2()
            """,
            new[] { "1", "True", "key=3" },
        };
    }

    /// <summary>
    /// Rows that were already GREEN on <c>565b9a04</c> and must stay green:
    /// the <c>Dictionary[K, V]</c> spelling the issue calls "the sharpest form
    /// of the inconsistency", the index sites #4015 already fixed, and a map
    /// over shapes that never lost their members. These hold the change to its
    /// scope; they are not proof.
    /// </summary>
    /// <returns>Name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> ControlCases()
    {
        yield return new object[]
        {
            "control-the-dictionary-spelling-of-the-same-type",
            """
            package Demo
            import System
            import System.Collections.Generic
            import HelperLib

            func main2() {
                var d = Dictionary[string, ImportedBase]()
                d["a"] = ImportedBase{}
                Console.WriteLine(d.Count.ToString())
                Console.WriteLine(d.ContainsKey("a").ToString())
                for pair in d {
                    Console.WriteLine(pair.Key + "=" + pair.Value.Name)
                }
            }

            main2()
            """,
            new[] { "1", "True", "a=base" },
        };

        yield return new object[]
        {
            "control-map-index-read-and-write-over-an-imported-value",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var m = map[string, ImportedBase]{}
                var v = ImportedBase{}
                v.Name = "written"
                m["a"] = v
                Console.WriteLine(m["a"].Name)
            }

            main2()
            """,
            new[] { "written" },
        };

        yield return new object[]
        {
            "control-a-map-over-shapes-that-never-lost-their-members",
            """
            package Demo
            import System

            class Plain {
                var Tag string
            }

            struct Pt {
                var X int32
            }

            func main2() {
                var m = map[string, int32]{"a": 1}
                Console.WriteLine(m.Count.ToString())
                Console.WriteLine(m.Remove("a").ToString())

                var p = Plain{}
                p.Tag = "t"
                var c = map[string, Plain]{"b": p}
                for k, v in c {
                    Console.WriteLine(k + "=" + v.Tag)
                }

                var s = map[string, Pt]{"c": Pt{}}
                Console.WriteLine(s.ContainsKey("c").ToString())
            }

            main2()
            """,
            new[] { "1", "True", "b=t", "True" },
        };

        // An OPEN map — key or value is a type parameter — is the shape
        // #3311's symbolic Dictionary view was built for. It must keep
        // working: the fix changes when a map has a CLR type at all.
        yield return new object[]
        {
            "control-an-open-map-over-type-parameters",
            """
            package Demo
            import System

            func countVia[K, V](m map[K, V], probe K) int32 {
                if m.ContainsKey(probe) {
                    return m.Count
                }

                return 0
            }

            func main2() {
                var m = map[string, int32]{"a": 1, "b": 2}
                Console.WriteLine(countVia[string, int32](m, "a").ToString())
            }

            main2()
            """,
            new[] { "2" },
        };
    }

    /// <summary>
    /// The shapes that must still be refused, so the fix did not open the
    /// member surface to anything the map does not have.
    /// </summary>
    /// <returns>Name, G# source, an expected diagnostic id.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        yield return new object[]
        {
            "a-member-a-dictionary-does-not-have-is-still-refused",
            """
            package Demo
            import System
            import HelperLib

            func main2() {
                var m = map[string, ImportedBase]{}
                Console.WriteLine(m.NoSuchMember().ToString())
            }

            main2()
            """,
            "GS0159",
        };

        // ADR-0174 D13 retired `len` as a built-in. Measured on 565b9a04 and
        // here: GS0566 for EVERY map, `map[string, int32]` included, so it is
        // by design and NOT an instance of this issue. Pinned because the
        // matrix that found this bug also found this row, and a future reader
        // should not chase it.
        yield return new object[]
        {
            "len-of-a-map-is-retired-by-adr-0174-not-broken-by-this-issue",
            """
            package Demo
            import System

            func main2() {
                var m = map[string, int32]{"a": 1}
                Console.WriteLine(len(m).ToString())
            }

            main2()
            """,
            "GS0566",
        };
    }

    /// <summary>
    /// A map over an imported key or value has its whole member surface, and
    /// the program compiles, IL-verifies, runs, and prints what it claims.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(AcceptedCases))]
    public void AMapOverAnImportedKeyOrValue_HasItsMemberSurface(string name, string source, string[] expectedLines)
    {
        RunCase("gs_4023_", name, source, expectedLines);
    }

    /// <summary>
    /// The rows that already worked keep working.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(ControlCases))]
    public void AShapeThatAlreadyWorked_StillWorks(string name, string source, string[] expectedLines)
    {
        RunCase("gs_4023_control_", name, source, expectedLines);
    }

    /// <summary>
    /// The fix does not invent members the dictionary does not have.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the compile must report.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void AShapeTheMapDoesNotHave_IsStillRefused(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4023_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static void RunCase(string prefix, string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory(prefix).FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);
            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"'{name}' must compile:\n{appLog}");

            IlVerifier.Verify(appPath, new[] { libPath });

            var (exit, output) = RunDotnet(appPath);
            Assert.True(exit == 0, $"'{name}' must run to completion. Exit {exit}:\n{output}");
            Assert.Equal(expectedLines, SplitLines(output));
        }
        finally
        {
            Directory.Delete(tempDir, recursive: true);
        }
    }

    private static string[] SplitLines(string output) => output
        .Split('\n')
        .Select(line => line.TrimEnd('\r'))
        .Where(line => line.Length > 0)
        .ToArray();

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
