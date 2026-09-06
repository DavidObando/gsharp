// <copyright file="Issue4016ExplicitTypeArgumentErasureTests.cs" company="GSharp">
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
/// Issue #4016: a <c>map[K, Derived]</c> did not reach an inferred
/// <c>Dictionary&lt;K, V&gt;</c> slot that the <c>List</c> spelling reaches.
/// </summary>
/// <remarks>
/// <para><b>Root cause: two erasures of one class that disagree.</b> The
/// ARGUMENT side and the explicit TYPE-ARGUMENT side project a
/// same-compilation class differently.
/// <c>MemberLookup.TryProjectErasedClrType</c> — which every structural
/// spelling (<c>map</c>, <c>[]T</c>, <c>[N]T</c>, <c>sequence</c>) goes through
/// — erases such a class to its IMPORTED BASE when it has one
/// (<c>class Derived : ImportedBase</c> becomes <c>ImportedBase</c>) and to
/// <c>object</c> only when it has none.
/// <c>TryResolveExplicitMethodTypeArgs</c> closed the candidate over a flat
/// <c>System.Object</c> placeholder regardless. So
/// <c>Probes.CountAnyMap[string, Derived](m)</c> compared an argument of
/// <c>Dictionary&lt;string, ImportedBase&gt;</c> against a parameter of
/// <c>Dictionary&lt;string, object&gt;</c>: invariant, no conversion, no
/// applicable candidate, <c>GS0159</c>. The fix projects the type argument the
/// same way the arguments are projected, so the two sides agree again. It is
/// the same correction #3087 made one site over in
/// <c>ExpressionBinder.Calls.cs</c>, which stopped flattening a symbolic TUPLE
/// type argument to <c>object</c> for exactly this reason.</para>
/// <para><b>The issue's boundary is wrong, and these rows say so.</b> A
/// 14-case matrix measured on <c>main</c> at <c>a09f4e1b</c> shows the failure
/// needs THREE things at once: the structural spelling, EXPLICIT type
/// arguments, and a type argument that is a same-compilation class WITH an
/// imported base.
/// <list type="bullet">
/// <item>The issue says "explicit vs inferred type arguments makes no
/// difference". It makes all the difference: INFERRED always bound, because
/// inference reads the argument's own shape rather than a placeholder. Pinned
/// as the <c>inferred</c> rows.</item>
/// <item>The issue frames the failing element as "a same-compilation class". A
/// same-compilation class with NO imported base bound fine, because
/// <c>TryProjectErasedClrType</c> answers <c>object</c> for it and the two
/// sides already agreed. Pinned as the <c>standalone</c> rows.</item>
/// <item>The issue titles this as a <c>map</c>-versus-<c>List</c> asymmetry. It
/// is not <c>map</c>-specific: <c>[]Derived</c> and <c>[N]Derived</c> at a
/// <c>T[]</c> slot failed identically, for the identical reason. Pinned as the
/// <c>slice</c> and <c>array</c> rows.</item>
/// </list></para>
/// <para><b>Why the <c>List</c> spelling was already green.</b>
/// <c>List[Derived]</c> is an <c>ImportedTypeSymbol</c>, so it takes
/// <c>TryProjectErasedClrType</c>'s <c>OpenDefinition</c> branch into
/// <c>TryBuildErasedClosedGeneric</c>, whose component eraser
/// (<c>ProjectSymbolicArgToErasedClr</c>) has no user-class arm and answers
/// <c>object</c> — which is what the flat placeholder produced, so those two
/// already agreed. That accident is the whole of the reported asymmetry.</para>
/// <para><b>What the fix does NOT loosen.</b> #4006's rejections are
/// unchanged: an erased class surrogate still does not satisfy a GENUINE
/// (non-erased) slot, whether spelled <c>map</c> or <c>List</c>. Those are the
/// rejected rows here, and they are the reason this fix had to be made at the
/// placeholder rather than by relaxing the erasure itself.</para>
/// <para><b>Out of scope, filed separately.</b> Naming a BASE of the real
/// element as the explicit type argument — <c>Probes.CountAny[ImportedBase]</c>
/// applied to a <c>List[Derived]</c> — compiles and runs on <c>main</c> but
/// emits IL that ILVerify rejects (<c>StackUnexpected</c>, <c>List&lt;Derived&gt;</c>
/// found where <c>List&lt;ImportedBase&gt;</c> is expected). That is a
/// pre-existing #4006-shaped hole in the explicit-type-argument path, measured
/// identical before and after this change, and is NOT what this fix addresses;
/// it is filed as #4026. The same hole reaches the INFERENCE path: the issue's
/// own control `Probes.CountAnyMap(entries)` on a `map[string, Derived]`
/// compiles and runs but does not IL-verify either, before or after, because
/// inference reads `V` off the argument's surrogate and emits
/// `CountAnyMap&lt;string, ImportedBase&gt;` while pushing a
/// `Dictionary&lt;string, Derived&gt;`. Note which way round the result lands:
/// after this change the EXPLICIT spelling verifies (it emits over the real
/// `Derived`, recovered from `typeArgSymbols`) while the inferred one still
/// does not. Every row in THIS fixture IL-verifies.</para>
/// </remarks>
public class Issue4016ExplicitTypeArgumentErasureTests
{
    /// <summary>How long a compiled case may run before it counts as hung.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>The C# library every fixture case links against.</summary>
    private const string LibrarySource = """
        using System.Collections.Generic;

        namespace Interop;

        public class ImportedBase
        {
            public string Name { get; set; } = "base";
        }

        public static class Probes
        {
            // The inferred generic slots the erasure exists to serve.
            public static string CountAny<T>(List<T> items) => "any:" + items.Count;

            public static string CountAnyMap<K, V>(Dictionary<K, V> entries)
                where K : notnull
                => "anymap:" + entries.Count;

            public static string CountArray<T>(T[] items) => "arr:" + items.Length;

            // Genuine, non-erased slots: #4006 territory, and still refused.
            public static string TakeBaseMap(Dictionary<string, ImportedBase> d)
                => "basemap:" + d.Count;

            public static string TakeBaseList(List<ImportedBase> l)
                => "baselist:" + l.Count;
        }
        """;

    /// <summary>
    /// The rows that were red on <c>main</c> and are green after the fix, plus
    /// every neighbour that was already green and must stay so.
    /// </summary>
    /// <returns>Case name, G# source, expected stdout lines.</returns>
    public static IEnumerable<object[]> BindingCases()
    {
        // RED BEFORE. The issue's own repro: the map spelling at an inferred
        // slot with explicit type arguments.
        yield return new object[]
        {
            "a-map-of-a-derived-class-reaches-an-inferred-dictionary-slot",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let entries = map[string, Derived]{}
            entries["k"] = Derived{}
            Console.WriteLine(Probes.CountAnyMap[string, Derived](entries))
            """,
            new[] { "anymap:1" },
        };

        // RED BEFORE. The KEY position fails for the same reason as the value
        // position, so both are pinned.
        yield return new object[]
        {
            "a-derived-class-in-the-key-position-reaches-the-slot-too",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let entries = map[Derived, string]{}
            Console.WriteLine(Probes.CountAnyMap[Derived, string](entries))
            """,
            new[] { "anymap:0" },
        };

        // RED BEFORE, and the row that shows this is not `map`-specific: the
        // issue's title says `map`, but a slice fails identically.
        yield return new object[]
        {
            "a-slice-of-a-derived-class-reaches-an-inferred-array-slot",
            """
            package P
            import System
            import Interop

            class Derived : ImportedBase {
            }

            let items = []Derived{Derived{}}
            Console.WriteLine(Probes.CountArray[Derived](items))
            """,
            new[] { "arr:1" },
        };

        // RED BEFORE. The fixed-length array spelling, same mechanism.
        yield return new object[]
        {
            "a-fixed-length-array-of-a-derived-class-reaches-the-same-slot",
            """
            package P
            import System
            import Interop

            class Derived : ImportedBase {
            }

            let items = [2]Derived{Derived{}, Derived{}}
            Console.WriteLine(Probes.CountArray[Derived](items))
            """,
            new[] { "arr:2" },
        };

        // GREEN BEFORE. The `List` spelling the issue contrasts against — the
        // row the fix RE-ROUTES (its parameter now closes over `ImportedBase`
        // rather than `object`), so it is pinned with IL verification.
        yield return new object[]
        {
            "the-list-spelling-that-already-bound-still-binds-and-verifies",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let items = List[Derived]()
            items.Add(Derived{})
            Console.WriteLine(Probes.CountAny[Derived](items))
            """,
            new[] { "any:1" },
        };

        // GREEN BEFORE. Inference never went through the placeholder, so it
        // always worked — the control that disproves the issue's claim that
        // explicit versus inferred makes no difference.
        //
        // Only the SLICE spelling is carried here. The `map` spelling of the
        // same inferred call — `Probes.CountAnyMap(entries)`, which the issue
        // lists as a working control — compiles and runs but does NOT
        // IL-verify, on `main` and after this change alike: inference reads
        // `V` off the argument's surrogate and emits
        // `CountAnyMap<string, ImportedBase>` while pushing the real
        // `Dictionary<string, Derived>` (`StackUnexpected`). That is the #4026
        // hole on the inference path, and this fix does not touch it — the
        // inferred path never reaches the explicit type-argument placeholder.
        // Note the direction of the result: after this change the EXPLICIT map
        // spelling verifies (it emits over the real `Derived`, recovered from
        // `typeArgSymbols`) while the inferred one still does not.
        yield return new object[]
        {
            "inferred-type-arguments-bound-before-and-still-do",
            """
            package P
            import System
            import Interop

            class Derived : ImportedBase {
            }

            let items = []Derived{Derived{}}
            Console.WriteLine(Probes.CountArray(items))
            """,
            new[] { "arr:1" },
        };

        // GREEN BEFORE. A same-compilation class with NO imported base erases
        // to `object` on both sides already — the control that disproves the
        // issue's "a same-compilation class" framing.
        yield return new object[]
        {
            "a-class-with-no-imported-base-bound-before-and-still-does",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Standalone {
            }

            let entries = map[string, Standalone]{}
            Console.WriteLine(Probes.CountAnyMap[string, Standalone](entries))

            let items = []Standalone{Standalone{}}
            Console.WriteLine(Probes.CountArray[Standalone](items))
            """,
            new[] { "anymap:0", "arr:1" },
        };

        // GREEN BEFORE. Primitives are unaffected: they have a real CLR type
        // and never reached the placeholder branch at all.
        yield return new object[]
        {
            "primitive-type-arguments-are-untouched",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            let entries = map[string, int32]{"a": 1}
            Console.WriteLine(Probes.CountAnyMap[string, int32](entries))
            """,
            new[] { "anymap:1" },
        };
    }

    /// <summary>
    /// #4006's rejections, which this fix must not loosen: an erased class
    /// surrogate still does not satisfy a genuine (non-erased) slot.
    /// </summary>
    /// <returns>Case name, G# source, expected diagnostic id.</returns>
    public static IEnumerable<object[]> StillRejectedCases()
    {
        yield return new object[]
        {
            "a-derived-map-still-does-not-satisfy-a-genuine-base-dictionary",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let entries = map[string, Derived]{}
            Console.WriteLine(Probes.TakeBaseMap(entries))
            """,
            "GS0159",
        };

        yield return new object[]
        {
            "a-derived-list-still-does-not-satisfy-a-genuine-base-list",
            """
            package P
            import System
            import System.Collections.Generic
            import Interop

            class Derived : ImportedBase {
            }

            let items = List[Derived]()
            Console.WriteLine(Probes.TakeBaseList(items))
            """,
            "GS0159",
        };
    }

    /// <summary>
    /// A structural spelling closed over an explicit user-class type argument
    /// reaches its inferred generic slot, compiles, IL-verifies and runs.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(BindingCases))]
    public void AStructuralSpellingAtAnInferredSlot_CompilesVerifiesAndRuns(string name, string source, string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4016_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
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

    /// <summary>
    /// The #4006 rejections stay rejected: agreeing on the erasure must not
    /// make an erased surrogate satisfy a genuine slot.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedId">The diagnostic id the log must carry.</param>
    [Theory]
    [MemberData(nameof(StillRejectedCases))]
    public void AGenuineSlot_StillRefusesAnErasedSurrogate(string name, string source, string expectedId)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_4016_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedId, appLog, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", appLog, StringComparison.Ordinal);
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
            "Interop",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "Interop.dll");
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
