// <copyright file="Issue3992NullableChannelAtDirectionalClrParameterTests.cs" company="GSharp">
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
/// Issue #3992: a nullable channel reached an imported <c>Channel&lt;T&gt;</c>
/// parameter but not a NON-GENERIC <c>ChannelWriter&lt;T&gt;</c> /
/// <c>ChannelReader&lt;T&gt;</c> one — <c>Plain.W(c)</c> reported GS0159 for a
/// <c>chan[int32]?</c> and bound for a <c>chan[int32]</c>.
/// </summary>
/// <remarks>
/// <para><b>What #3995 left.</b> That PR fixed the CONVERSION for every element
/// spelling (<c>IsReferenceLikeTarget</c> and <c>IsNominalReferenceShape</c>
/// both learned the channel) and the generic-slot APPLICABILITY
/// (<c>ChannelViewAppliesAtErasedGenericSlot</c>). What remained was
/// applicability at a slot no erased-shape probe may answer: a non-generic
/// member on a non-generic type.</para>
/// <para><b>Cause.</b> Applicability ALREADY ignores a reference annotation on
/// the CLR path — <c>NullableTypeSymbol.ClrType</c> relays its underlying, so a
/// <c>chan[int32]?</c> is presented to <c>ClrOverloadResolution</c> as
/// <c>Chan&lt;int&gt;</c> and reaches a <c>Channel[int32]</c> parameter by
/// ordinary CLR assignability, exactly as a <c>string?</c> reaches a
/// <c>string</c> parameter. Only ADR-0148's SYMBOLIC fallback
/// (<c>MakeStructuralProjectionArgumentCheck</c>, which exists because CLR
/// surrogates cannot see a G# argument's structural shape) re-asked the
/// question on the still-ANNOTATED symbol, and so re-introduced an annotation
/// the rest of the boundary had already dropped. It mattered only where no CLR
/// relation links the two shapes — precisely the ADR-0174 D2 view, since no
/// base class or interface links <c>Chan&lt;T&gt;</c> to
/// <c>ChannelWriter&lt;T&gt;</c>. The conversion the boundary then performs is
/// classified EXPLICIT on purpose (that is what keeps a G#-declared
/// <c>chan[int32]</c> parameter reporting GS0154), and the callback asked for
/// an IMPLICIT one, so the candidate was dropped before the conversion was ever
/// reached.</para>
/// <para><b>Fix.</b> <c>IsApplicableIgnoringReferenceNullability</c>: the
/// symbolic fallback also answers yes when the argument's NON-NULLABLE form is
/// applicable. Nothing becomes applicable whose non-nullable form was not, only
/// a REFERENCE nullable is peeled (a value-type <c>Nullable&lt;T&gt;</c> keeps
/// its own lifted rules), and <c>StructuralProjectionPlanner.CanProject</c> is
/// not re-asked. The leniency stays confined to CLR boundaries, because
/// <c>BindClrParameterConversions</c> is the only call path that passes
/// <c>allowExplicit: true</c>.</para>
/// <para><b>Discrimination (ADR-0154).</b> Every accepted case compiles against
/// a separately compiled C# library with nullable annotations ENABLED (with
/// them off the parameters import as nullable and the question disappears),
/// IL-VERIFIES, RUNS, and asserts the program's own stdout with a value pushed
/// through the chosen handle and read back — so a reader chosen where a writer
/// was meant, or a raw <c>Chan&lt;T&gt;</c> pushed with no <c>get_Writer</c>,
/// fails rather than merely verifies. The rejection rows hold the fix to its
/// claim that only the annotation was dropped: direction and element still
/// decide, and a G#-declared parameter still reports GS0154.</para>
/// </remarks>
public class Issue3992NullableChannelAtDirectionalClrParameterTests
{
    /// <summary>How long a compiled case may run before it counts as deadlocked.</summary>
    private const int RunTimeout = 60_000;

    /// <summary>
    /// The C# library every case links against. Nullable annotations are
    /// ENABLED — that is what makes each parameter genuinely non-nullable.
    /// Every member is NON-GENERIC and declared on a NON-GENERIC type, which is
    /// exactly the slot #3995's erased-shape probe may not answer.
    /// </summary>
    private const string LibrarySource = """
        using System.Threading.Channels;

        namespace OvlLib;

        // The three handles are observably different: only a writer can push,
        // only a reader can take, and the whole channel reports its own tag.
        // A wrong choice prints the wrong value or deadlocks.
        public static class Plain
        {
            public static int W(ChannelWriter<int> writer) => writer.TryWrite(11) ? 11 : 0;

            public static int R(ChannelReader<int> reader) => reader.TryRead(out var v) ? v : -1;

            public static int C(Channel<int> whole) => 7;

            // A reader-only overload of a DIFFERENT name, so direction is the
            // only thing that can pick it.
            public static int OnlyReader(ChannelReader<int> reader) => 22;

            public static int OnlyWriter(ChannelWriter<int> writer) => 33;
        }

        // A non-generic type with a non-generic constructor taking a view.
        public sealed class PlainSink
        {
            public PlainSink(ChannelWriter<int> writer, int tag)
            {
                Kind = writer.TryWrite(tag) ? tag : 0;
            }

            public int Kind { get; }
        }
        """;

    /// <summary>
    /// The rows that must now COMPILE, IL-verify, RUN and print. Each moves a
    /// value THROUGH the view the call selected.
    /// </summary>
    /// <returns>Name, source, and the expected stdout lines.</returns>
    public static IEnumerable<object[]> Cases()
    {
        // The corrected repro. `Plain.W` is non-generic on a non-generic type;
        // the non-nullable form already bound, the nullable form did not.
        yield return new object[]
        {
            "the-corrected-repro-a-nullable-channel-reaches-a-non-generic-writer-parameter",
            """
            package P
            import System
            import OvlLib

            func plainNonNullable(c chan[int32]) int32 {
                return Plain.W(c)
            }

            func plainNullable(c chan[int32]?) int32 {
                return Plain.W(c)
            }

            let ch = chan[int32](4)
            Console.WriteLine(plainNonNullable(ch))
            Console.WriteLine(plainNullable(ch))
            Console.WriteLine(<-ch)
            Console.WriteLine(<-ch)
            """,
            new[] { "11", "11", "11", "11" },
        };

        // The READER direction of the same view, and it must genuinely take
        // the value the writer put in — so `get_Reader` really was emitted.
        yield return new object[]
        {
            "a-nullable-channel-reaches-a-non-generic-reader-parameter",
            """
            package P
            import System
            import OvlLib

            func push(c chan[int32]?) int32 {
                return Plain.W(c)
            }

            func take(c chan[int32]?) int32 {
                return Plain.R(c)
            }

            let ch = chan[int32](2)
            Console.WriteLine(push(ch))
            Console.WriteLine(take(ch))
            """,
            new[] { "11", "11" },
        };

        // The fix is not confined to a non-generic enclosing scope: the same
        // call binds from inside a generic function. NOTE the element axis
        // cannot be exercised at this kind of slot at all — a NON-generic C#
        // `ChannelWriter<int>` parameter can only ever take a closed `int`
        // element — which is itself the reason this issue is a different axis
        // from #3985 rather than the same one.
        yield return new object[]
        {
            "the-same-call-binds-from-inside-a-generic-function",
            """
            package P
            import System
            import OvlLib

            func plainNullable(c chan[int32]?) int32 {
                return Plain.OnlyWriter(c)
            }

            func openish[T](c chan[T]?, w chan[int32]?) int32 {
                return Plain.OnlyWriter(w)
            }

            let ch = chan[int32](1)
            Console.WriteLine(plainNullable(ch))
            Console.WriteLine(openish[int32](ch, ch))
            """,
            new[] { "33", "33" },
        };

        // Direction still selects: a reader-only member and a writer-only
        // member are both reachable from the SAME nullable bidirectional
        // handle, and they answer differently.
        yield return new object[]
        {
            "direction-still-selects-from-one-nullable-bidirectional-handle",
            """
            package P
            import System
            import OvlLib

            func both(c chan[int32]?) int32 {
                return Plain.OnlyReader(c) + Plain.OnlyWriter(c)
            }

            Console.WriteLine(both(chan[int32](1)))
            """,
            new[] { "55" },
        };

        // A non-generic CONSTRUCTOR on a non-generic type takes the view too.
        yield return new object[]
        {
            "a-non-generic-constructor-takes-a-directional-view-from-a-nullable-channel",
            """
            package P
            import System
            import OvlLib

            func make(c chan[int32]?) int32 {
                return PlainSink(c, 6).Kind
            }

            let ch = chan[int32](2)
            Console.WriteLine(make(ch))
            Console.WriteLine(<-ch)
            """,
            new[] { "6", "6" },
        };

        // Control 1 (from the issue): the WHOLE-channel parameter was never
        // broken — it binds by ordinary CLR assignability.
        yield return new object[]
        {
            "control-the-whole-channel-parameter-was-never-broken",
            """
            package P
            import System
            import OvlLib

            func toWhole(c chan[int32]?) int32 {
                return Plain.C(c)
            }

            Console.WriteLine(toWhole(chan[int32](1)))
            """,
            new[] { "7" },
        };

        // Control 2 (from the issue): `!!` was and remains the remedy.
        yield return new object[]
        {
            "control-the-bang-bang-remedy-still-works",
            """
            package P
            import System
            import OvlLib

            func bang(c chan[int32]?) int32 {
                return Plain.W(c!!)
            }

            let ch = chan[int32](1)
            Console.WriteLine(bang(ch))
            Console.WriteLine(<-ch)
            """,
            new[] { "11", "11" },
        };

        // Control 3: the non-nullable form, which always bound. Carried so a
        // regression that broke it cannot hide behind the new rows.
        yield return new object[]
        {
            "control-the-non-nullable-channel-still-reaches-both-directions",
            """
            package P
            import System
            import OvlLib

            func w(c chan[int32]) int32 {
                return Plain.OnlyWriter(c)
            }

            func r(c chan[int32]) int32 {
                return Plain.OnlyReader(c)
            }

            let ch = chan[int32](1)
            Console.WriteLine(w(ch))
            Console.WriteLine(r(ch))
            """,
            new[] { "33", "22" },
        };

        // Control 4: a DECLARED directional nullable reaches its own view by
        // identity, with no annotation-dropping needed.
        yield return new object[]
        {
            "control-a-declared-directional-nullable-reaches-its-own-parameter",
            """
            package P
            import System
            import OvlLib

            func w(c out chan[int32]?) int32 {
                return Plain.OnlyWriter(c)
            }

            func r(c in chan[int32]?) int32 {
                return Plain.OnlyReader(c)
            }

            let ch = chan[int32](1)
            Console.WriteLine(w(ch))
            Console.WriteLine(r(ch))
            """,
            new[] { "33", "22" },
        };
    }

    /// <summary>
    /// The rows that must stay REJECTED. Only the ANNOTATION is dropped:
    /// direction and element still decide, and a G#-declared parameter still
    /// enforces nullability.
    /// </summary>
    /// <returns>Name, source, and a substring the diagnostics must name.</returns>
    public static IEnumerable<object[]> RejectedCases()
    {
        // Direction is not dropped: a send-only nullable handle cannot become
        // a reader.
        yield return new object[]
        {
            "a-send-only-nullable-cannot-reach-a-reader-parameter",
            """
            package P
            import System
            import OvlLib

            func bad(c out chan[int32]?) int32 {
                return Plain.OnlyReader(c)
            }

            Console.WriteLine(bad(chan[int32](1)))
            """,
            "OnlyReader",
        };

        // ...nor a receive-only handle a writer.
        yield return new object[]
        {
            "a-receive-only-nullable-cannot-reach-a-writer-parameter",
            """
            package P
            import System
            import OvlLib

            func bad(c in chan[int32]?) int32 {
                return Plain.OnlyWriter(c)
            }

            Console.WriteLine(bad(chan[int32](1)))
            """,
            "OnlyWriter",
        };

        // The element is not dropped either. `ChannelWriter<T>` is invariant.
        yield return new object[]
        {
            "the-element-still-has-to-match",
            """
            package P
            import System
            import OvlLib

            func bad(c chan[string]?) int32 {
                return Plain.OnlyWriter(c)
            }

            Console.WriteLine(bad(chan[string](1)))
            """,
            "OnlyWriter",
        };

        // The split #3985 settled on is preserved: the leniency is a CLR
        // boundary rule, and a G#-DECLARED parameter still reports GS0154.
        yield return new object[]
        {
            "a-gsharp-declared-directional-parameter-still-enforces-nullability",
            """
            package P
            import System
            import OvlLib

            func takes(c out chan[int32]) int32 {
                return 1
            }

            func bad(c chan[int32]?) int32 {
                return takes(c)
            }

            Console.WriteLine(bad(chan[int32](1)))
            """,
            "GS0154",
        };

        // An unrelated non-channel parameter is not made applicable by the
        // peel: only a pair whose NON-NULLABLE form was already applicable is.
        yield return new object[]
        {
            "a-nullable-string-does-not-become-applicable-to-a-writer-parameter",
            """
            package P
            import System
            import OvlLib

            func bad(s string?) int32 {
                return Plain.OnlyWriter(s)
            }

            Console.WriteLine(bad("x"))
            """,
            "OnlyWriter",
        };
    }

    /// <summary>
    /// Compiles the C# library, compiles a G# consumer against it, IL-verifies
    /// the consumer, runs it, and asserts the program's own output.
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedLines">The expected stdout lines, in order.</param>
    [Theory]
    [MemberData(nameof(Cases))]
    public void ANullableChannelAtADirectionalClrParameter_CompilesVerifiesAndRuns(
        string name,
        string source,
        string[] expectedLines)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3992_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);
            Assert.True(File.Exists(appPath), $"consumer compile failed for '{name}':\n{appLog}");

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
    /// Only the ANNOTATION is dropped: direction, element, the G#-declared
    /// null-safety rule and unrelated types all still decide, and none of these
    /// reaches the emitter (GS9998).
    /// </summary>
    /// <param name="name">The case name.</param>
    /// <param name="source">The G# source.</param>
    /// <param name="expectedMention">A substring the diagnostics must name.</param>
    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void OnlyTheAnnotation_IsDropped(string name, string source, string expectedMention)
    {
        var tempDir = Directory.CreateTempSubdirectory("gs_3992_neg_").FullName;
        try
        {
            var libPath = CompileCSharpLibrary(tempDir);

            var appPath = Path.Combine(tempDir, name + ".dll");
            var appLog = Compile(tempDir, "App.gs", source, appPath, "/target:exe", "/reference:" + libPath);

            Assert.False(File.Exists(appPath), $"'{name}' must not compile. Log:\n{appLog}");
            Assert.Contains(expectedMention, appLog, StringComparison.Ordinal);
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
            "OvlLib",
            new[] { CSharpSyntaxTree.ParseText(LibrarySource) },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
                .WithNullableContextOptions(NullableContextOptions.Enable));

        var libPath = Path.Combine(tempDir, "OvlLib.dll");
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

        // A wrong channel view fails by DEADLOCKING rather than erroring, so
        // read asynchronously and bound the wait.
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

            return (-1, $"timed out after {RunTimeout / 1000}s (deadlock).");
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
