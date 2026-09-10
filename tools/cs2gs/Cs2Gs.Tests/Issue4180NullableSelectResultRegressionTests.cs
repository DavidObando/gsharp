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
