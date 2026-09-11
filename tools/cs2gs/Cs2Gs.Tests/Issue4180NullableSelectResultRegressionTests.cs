// <copyright file="Issue4180NullableSelectResultRegressionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Issue #4180 (split from #4129's clustering work, umbrella #3501): six of
/// #4129's test-parity failures (all sharing the shared
/// <c>AssertImplementsGenericOf</c>/<c>AssertImplementsEnumerableOf</c> helper
/// pattern in <c>test/Compiler.Tests/Emit/Issue1489GenericAsyncIteratorEmitTests.cs</c>,
/// <c>Issue1481MapFunctionIteratorEmitTests.cs</c> and
/// <c>Issue813TupleSequenceReturnEmitTests.cs</c>) crashed under self-hosting
/// with a bare <c>System.NullReferenceException</c> raised INSIDE a
/// <c>.Select(i =&gt; i.FullName)</c> lambda (via
/// <c>System.Linq.Enumerable.ArraySelectIterator.MoveNext()</c>, invoked from
/// <c>String.Join</c>) — even though the same C# compiled and run natively
/// never throws, because <see cref="Type.FullName"/> legitimately returns
/// <see langword="null"/> (not merely falsy) for a reified generic
/// interface row closed over an unresolved class type parameter — exactly
/// the shape these tests construct and reflect over.
/// <para>
/// Root cause: this is NOT a gsc emitter defect (the emitted state machines'
/// interface metadata is correct under both native and self-hosted gsc — see
/// the issue's investigation). It is a cs2gs TRANSLATOR defect:
/// <c>CSharpToGSharpTranslator.Expressions.LambdaResultFlowsToNullableSink</c>
/// (added by issue #4046 to keep a generic selector's result unasserted when
/// its fluent call chain "collapses back to the same scalar type" as a
/// nullable-tolerant terminal operator, e.g. <c>.Select(...).FirstOrDefault()</c>)
/// only recognised that shape — a Select result CHAINED into a further
/// scalar-returning call. It did not recognise the sibling shape where the
/// Select result flows WHOLE, as a collection, into an ordinary ARGUMENT
/// position whose parameter itself accepts a nullable-element sequence (e.g.
/// <c>string.Join(string?, IEnumerable&lt;string?&gt;)</c>). Its final
/// <c>sinkType == resultType</c> equality check compares the SCALAR lambda
/// result type against the whole COLLECTION parameter type, which can never
/// match, so the function reports "does not flow to a nullable sink" and
/// falls through to the general oblivious-forwarding bridge, which inserts a
/// G# <c>!!</c> — a RUNTIME assertion, unlike C#'s erased <c>!</c> — on
/// <c>i.FullName</c>. The fix teaches the function to also unwrap a single
/// generic type argument from the sink and compare ELEMENT-to-element,
/// matching when that element is already nullable-ANNOTATED (e.g. the
/// BCL-declared <c>IEnumerable&lt;string?&gt;</c> <c>string.Join</c> accepts).
/// </para>
/// <para>
/// Issue #4115 ("selfmig: generic iterator state-machine metadata
/// inspection throws NRE (6 parity failures)", split from #4045) describes
/// this exact same defect against the same three files
/// (<c>Issue1489GenericAsyncIteratorEmitTests.cs</c>,
/// <c>Issue1481MapFunctionIteratorEmitTests.cs</c>,
/// <c>Issue813TupleSequenceReturnEmitTests.cs</c>) with the same
/// <c>NullReferenceException</c>-while-inspecting-the-generated-interfaces
/// signature, and the same count: of those three files' seven
/// <c>AssertImplementsGenericOf</c>/<c>AssertImplementsEnumerableOf</c>
/// reflection tests, exactly six assert an interface row closed over the
/// state machine's own unresolved Var(0) type parameter (so
/// <see cref="Type.FullName"/> is null on that row and the stray <c>!!</c>
/// throws); the seventh —
/// <c>StateMachineClass_MapOfListElement_StaysErased_AndVerifies</c> —
/// asserts a fully-closed, erased row (<c>Dictionary&lt;string,
/// List&lt;object&gt;&gt;</c>) whose <c>FullName</c> is never null, so it
/// was never among the failures. There is no defect left to fix for #4115
/// either — this class's <c>TranslatedSnippet_*</c> and
/// <c>SelfHostedNullableSelectResult_*</c> tests (four in total, two
/// shapes) already pin the exact translator defect, and
/// <c>test/Compiler.Tests</c>' 25 native tests across
/// <c>Issue1481MapFunctionIteratorEmitTests</c>,
/// <c>Issue1489GenericAsyncIteratorEmitTests</c>, and
/// <c>Issue813TupleSequenceReturnEmitTests</c> were never affected (native
/// gsc never hits this bug — it is purely a self-hosting translation-fidelity
/// issue; see #4180's PR description for the documented re-translation of
/// these exact three files confirming no <c>!!</c> remains on any
/// <c>i.FullName</c> selector). This provenance note is the same shape
/// #4199 used to record that #4195's regression test also pinned #4112's
/// rows.
/// </para>
/// </summary>
public sealed class Issue4180NullableSelectResultRegressionTests
{
    // The minimal reproduction of the mistranslated shape: an oblivious file
    // (no `<Nullable>` setting — exactly test/Compiler.Tests.csproj's own
    // condition) whose `Describe` forwards a `.Select(t => t.FullName)`
    // result WHOLE into `string.Join`'s `IEnumerable<string?> values`
    // parameter, never chaining into a further scalar-returning call. `Main`
    // feeds it a genuinely null-FullName `Type` (an unbound generic type
    // parameter, `List<>`'s own `T` — issue #4180 does not require building a
    // full reified state machine to exhibit the same defect).
    private const string Source = """
        using System;
        using System.Collections.Generic;
        using System.Linq;

        public static class Probe
        {
            public static string Describe(IEnumerable<Type> types)
            {
                return string.Join(", ", types.Select(t => t.FullName));
            }

            public static void Main()
            {
                Type[] typeParameters = typeof(List<>).GetGenericArguments();
                string described = Describe(typeParameters);
                Console.WriteLine("OK:" + described);
            }
        }
        """;

    /// <summary>
    /// Translates the reproduction snippet and asserts the emitted G# no
    /// longer asserts the selector's nullable result — the cheap, syntactic
    /// guard that discriminates this PR's fix (reverting the production hunk
    /// turns this test red; see
    /// <see cref="SelfHostedNullableSelectResult_DoesNotThrowWhenForwardedToStringJoin"/>
    /// for the full functional proof that the fixed shape survives
    /// self-hosted compilation and execution).
    /// </summary>
    [Fact]
    public void TranslatedSnippet_NoLongerAssertsTheSelectResultForwardedToStringJoin()
    {
        string printed = Translate(Source);

        Assert.DoesNotContain("t.FullName!!", printed, StringComparison.Ordinal);
        Assert.Contains("types.Select((t Type) -> t.FullName)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The functional proof that the fixed shape actually survives
    /// self-hosting: translates the SAME reproduction snippet, compiles the
    /// result with the REAL <c>gsc.dll</c>, and runs it. Before the fix this
    /// throws <see cref="NullReferenceException"/> from inside the
    /// <c>Select</c> lambda (exactly the crash reported in #4180's gate
    /// runs); after the fix it prints <c>OK:</c> with an empty joined
    /// segment for the null <c>FullName</c>, the same as running the
    /// original C# natively.
    /// </summary>
    [Fact]
    public void SelfHostedNullableSelectResult_DoesNotThrowWhenForwardedToStringJoin()
    {
        string printed = Translate(Source);
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4180NullableSelectResultRegressionTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        try
        {
            string gsPath = Path.Combine(workDir, "Probe.gs");
            string dllPath = Path.Combine(workDir, "Probe.dll");
            File.WriteAllText(gsPath, printed);

            (int compileExit, string compileOutput) = RunDotnet(
                $"\"{compiler}\" /target:exe /targetframework:net10.0 /out:\"{dllPath}\" \"{gsPath}\"");
            Assert.True(
                compileExit == 0,
                "gsc must compile the translated probe. Output:\n" + compileOutput
                    + "\n\nTranslated G#:\n" + printed);

            (int runExit, string output) = RunDotnet($"\"{dllPath}\"");
            Assert.True(
                runExit == 0,
                "the compiled probe must run without throwing. Output:\n" + output);
            Assert.Equal("OK:", output.Trim());
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    // The COVARIANT sibling shape flagged on this PR's own review (Copilot,
    // on the original `SymbolEqualityComparer.Default.Equals(resultType,
    // sinkElement...)` fix): the sink's nullable-annotated element type need
    // not be IDENTICAL to the selector's result type, only ASSIGNABLE to it
    // through an implicit reference conversion. `Consume(IEnumerable<object?>
    // values)` accepts `types.Select(t => t.FullName)`'s `IEnumerable<string?>`
    // through `IEnumerable<T>`'s covariance — `string` is not symbol-equal to
    // `object`, but every `string` IS an `object`. Exact-identity missed this:
    // the selector result stayed `!!`-asserted and threw on a null
    // `FullName` even though the sink tolerates it exactly like #4180's
    // `string.Join` case.
    private const string CovariantSource = """
        using System;
        using System.Collections.Generic;
        using System.Linq;

        public static class Probe
        {
            public static string Consume(IEnumerable<object?> values)
            {
                return string.Join(", ", values);
            }

            public static string Describe(IEnumerable<Type> types)
            {
                return Consume(types.Select(t => t.FullName));
            }

            public static void Main()
            {
                Type[] typeParameters = typeof(List<>).GetGenericArguments();
                string described = Describe(typeParameters);
                Console.WriteLine("OK:" + described);
            }
        }
        """;

    /// <summary>
    /// Translates the covariant reproduction snippet and asserts the emitted
    /// G# no longer asserts the selector's nullable result — the cheap,
    /// syntactic guard that discriminates the review fix (reverting the
    /// element-conversion check back to exact identity turns this test red;
    /// see
    /// <see cref="SelfHostedNullableSelectResult_DoesNotThrowWhenForwardedThroughCovariantSink"/>
    /// for the full functional proof).
    /// </summary>
    [Fact]
    public void TranslatedSnippet_NoLongerAssertsTheSelectResultForwardedThroughCovariantSink()
    {
        string printed = Translate(CovariantSource);

        Assert.DoesNotContain("t.FullName!!", printed, StringComparison.Ordinal);
        Assert.Contains("types.Select((t Type) -> t.FullName)", printed, StringComparison.Ordinal);
    }

    /// <summary>
    /// The functional proof that the covariant shape actually survives
    /// self-hosting: translates the covariant reproduction snippet, compiles
    /// the result with the REAL <c>gsc.dll</c>, and runs it. With the
    /// pre-review exact-identity check this throws
    /// <see cref="NullReferenceException"/> from inside the <c>Select</c>
    /// lambda (the same shape of crash as #4180's report, but through a
    /// covariant sink rather than an identical one); after the fix it prints
    /// <c>OK:</c> with an empty joined segment for the null <c>FullName</c>.
    /// </summary>
    [Fact]
    public void SelfHostedNullableSelectResult_DoesNotThrowWhenForwardedThroughCovariantSink()
    {
        string printed = Translate(CovariantSource);
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4180NullableSelectResultRegressionTests),
            Guid.NewGuid().ToString("N") + "-covariant");
        Directory.CreateDirectory(workDir);
        try
        {
            string gsPath = Path.Combine(workDir, "Probe.gs");
            string dllPath = Path.Combine(workDir, "Probe.dll");
            File.WriteAllText(gsPath, printed);

            (int compileExit, string compileOutput) = RunDotnet(
                $"\"{compiler}\" /target:exe /targetframework:net10.0 /out:\"{dllPath}\" \"{gsPath}\"");
            Assert.True(
                compileExit == 0,
                "gsc must compile the translated probe. Output:\n" + compileOutput
                    + "\n\nTranslated G#:\n" + printed);

            (int runExit, string output) = RunDotnet($"\"{dllPath}\"");
            Assert.True(
                runExit == 0,
                "the compiled probe must run without throwing. Output:\n" + output);
            Assert.Equal("OK:", output.Trim());
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static string Translate(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(
            new[] { ("Issue4180.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);
        return GSharpPrinter.Print(unit);
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var startInfo = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("failed to start dotnet");
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(directory.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static void TryDelete(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
