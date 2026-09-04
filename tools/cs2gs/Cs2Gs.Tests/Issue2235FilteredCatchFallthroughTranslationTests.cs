// <copyright file="Issue2235FilteredCatchFallthroughTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using Cs2Gs.CodeModel.Ast;
using Cs2Gs.CodeModel.Printing;
using Cs2Gs.CodeModel.RoundTrip;
using Cs2Gs.Translator;
using Cs2Gs.Translator.Loading;
using Xunit;

namespace Cs2Gs.Tests;

/// <summary>
/// Translation tests for issue #2235 (follow-up to #1724, ADR-0115 §B): a
/// <c>catch ... when (filter)</c> clause with a later sibling catch whose
/// type could also receive the exception. C# requires a false filter to fall
/// through to that sibling, which the per-clause rethrow-on-false-filter
/// lowering could not express — so cs2gs used to merge the offending clause
/// and every clause after it into ONE G# catch whose body manually replayed
/// C#'s top-to-bottom type-then-filter matching over a synthetic binder.
///
/// ADR-0177 gave G# native <c>catch (T) when …</c> clauses backed by real CLR
/// filter regions, so top-to-bottom matching and fall-through-on-false-filter
/// are the runtime's job again: every C# clause maps to exactly one G# clause
/// and no <c>__caught</c> binder is invented (issue #3897 family 1).
///
/// The end-to-end expectations below are unchanged from the merge era — the
/// same programs must still print the same answers.
/// </summary>
public class Issue2235FilteredCatchFallthroughTranslationTests
{
    /// <summary>
    /// The issue's exact repro: two back-to-back filtered
    /// <c>OperationCanceledException when (...)</c> clauses, both of which
    /// must fall through to a later <c>catch (Exception)</c> when their own
    /// filter is false. Proves 2+ filtered clauses in a row still chain.
    /// </summary>
    [Fact]
    public void TwoBackToBackFilteredClauses_FallThroughToLaterExceptionCatch()
    {
        string printed = TranslateUnit(@"
using System;
using System.Threading;
namespace Demo
{
    public class C
    {
        public int Run(CancellationToken ct)
        {
            try
            {
                throw new OperationCanceledException();
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                return 1;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return 2;
            }
            catch (Exception)
            {
                return 3;
            }
        }
    }
}");

        Assert.DoesNotContain("__caught", printed);
        Assert.Contains("catch (OperationCanceledException) when ct.IsCancellationRequested", printed);
        Assert.Contains("catch (OperationCanceledException) when !ct.IsCancellationRequested", printed);
        Assert.Contains("catch (Exception)", printed);
        Assert.Contains("return 1", printed);
        Assert.Contains("return 2", printed);
        Assert.Contains("return 3", printed);

        // A CancellationToken defaults to not-requested, so `ct.IsCancellationRequested`
        // is false for the first filtered clause and its negation is true for the
        // second: the exception must fall through the first filter and be caught
        // by the second clause's body (return 2), not the first or the final
        // `catch (Exception)`.
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(System.Threading.CancellationToken()))", "2");
    }

    /// <summary>
    /// Simpler shape: a single filtered clause with one overlapping later
    /// sibling. Runtime proof both clauses are live: a filter-true exception is
    /// caught by the first clause, a filter-false one falls through to the
    /// sibling.
    /// </summary>
    [Fact]
    public void SingleFilteredClause_WithOverlappingSibling_FallsThroughWhenFilterFalse()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        public int Run(bool retryable)
        {
            try
            {
                throw new InvalidOperationException(""boom"");
            }
            catch (InvalidOperationException ex) when (retryable)
            {
                return 1;
            }
            catch (Exception)
            {
                return 2;
            }
        }
    }
}");

        Assert.DoesNotContain("__caught", printed);
        Assert.Contains("catch (ex InvalidOperationException) when retryable", printed);
        Assert.Contains("catch (Exception)", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "1");
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(false))", "2");
    }

    /// <summary>
    /// Disjoint sibling types used to select the "safe" rethrow-if-false
    /// lowering instead of the merge. Neither path exists now: the clause
    /// translates the same way whatever its siblings are.
    /// </summary>
    [Fact]
    public void FilteredClause_WithDisjointSibling_EmitsTheSameNativeFilter()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class C
    {
        public int Run(bool retryable)
        {
            try
            {
                throw new InvalidOperationException(""boom"");
            }
            catch (InvalidOperationException ex) when (retryable)
            {
                return 1;
            }
            catch (FormatException)
            {
                return 2;
            }
        }
    }
}");

        Assert.Contains("catch (ex InvalidOperationException) when retryable", printed);
        Assert.Contains("catch (FormatException)", printed);
        Assert.DoesNotContain("rethrow", printed);
        Assert.DoesNotContain("__caught", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "1");
    }

    /// <summary>
    /// M2 regression guard, now trivially satisfied: the handler reads a
    /// SUBTYPE-only member off its own binder. The merge had to recover that
    /// type through an `is` smart cast (ADR-0069); a native clause is simply
    /// declared at the subtype, so the member is in scope directly.
    /// </summary>
    [Fact]
    public void FilteredClause_AccessesSubtypeOnlyMember_OnItsOwnBinder()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class MyCustomException : Exception
    {
        public int CustomProp { get; }
        public MyCustomException(int customProp) { CustomProp = customProp; }
    }

    public class C
    {
        public int Run(bool retryable)
        {
            try
            {
                throw new MyCustomException(42);
            }
            catch (MyCustomException ex) when (retryable)
            {
                return ex.CustomProp;
            }
            catch (Exception)
            {
                return -1;
            }
        }
    }
}");

        Assert.Contains("catch (ex MyCustomException) when retryable", printed);
        Assert.DoesNotContain("__caught", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "42");
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(false))", "-1");
    }

    /// <summary>
    /// M1 regression guard: a closure inside a filtered handler captures the
    /// catch variable and reads a subtype-only member from it. Under the merge
    /// this was where a shared-binder name collision silently produced the
    /// unnarrowed type; with one clause per source clause there is no shared
    /// binder to collide with, and the capture is of the real catch variable.
    /// </summary>
    [Fact]
    public void FilteredClause_ClosureCapturesCatchVariable_ReadsSubtypeOnlyMember()
    {
        string printed = TranslateUnit(@"
using System;
namespace Demo
{
    public class MyCustomException : Exception
    {
        public int CustomProp { get; }
        public MyCustomException(int customProp) { CustomProp = customProp; }
    }

    public class C
    {
        public int Run(bool retryable)
        {
            try
            {
                throw new MyCustomException(99);
            }
            catch (MyCustomException ex) when (retryable)
            {
                Func<int> get = () => ex.CustomProp;
                return get();
            }
            catch (Exception)
            {
                return -1;
            }
        }
    }
}");

        Assert.Contains("catch (ex MyCustomException) when retryable", printed);
        Assert.DoesNotContain("__caught", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "99");
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(false))", "-1");
    }

    /// <summary>
    /// A method whose own parameter is literally named <c>__caught</c>: the merge
    /// had to rename its synthetic binder around it. Nothing is synthesized now,
    /// so the only <c>__caught</c> in the output is the user's own parameter.
    /// </summary>
    [Fact]
    public void NestedFilteredCatches_InventNoBinder_AndLeaveASourceNamedCaughtAlone()
    {
        string printed = TranslateUnit("""
            using System;

            namespace Demo
            {
                public class C
                {
                    public int Run(string __caught)
                    {
                        try
                        {
                            throw new InvalidOperationException("outer");
                        }
                        catch (InvalidOperationException ex) when (__caught == "outer")
                        {
                            try
                            {
                                throw new ArgumentException("inner");
                            }
                            catch (ArgumentException inner) when (__caught == "outer")
                            {
                                return 7;
                            }
                            catch (Exception)
                            {
                                return 8;
                            }
                        }
                        catch (Exception)
                        {
                            return 9;
                        }
                    }
                }
            }
            """);

        Assert.DoesNotContain("__caught_", printed);
        Assert.Contains("catch (ex InvalidOperationException) when __caught == \"outer\"", printed);
        Assert.Contains("catch (inner ArgumentException) when __caught == \"outer\"", printed);
        Assert.Contains("catch (Exception)", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run(\"outer\"))", "7");
    }

    /// <summary>
    /// A bare C# <c>catch</c> stays a bare G# <c>catch</c> (ADR-0177), so there is
    /// no synthesized binder that could shadow the outer <c>ex</c> the body reads.
    /// </summary>
    [Fact]
    public void BareCatch_StaysBare_AndCannotShadowAnOuterNameCalledEx()
    {
        string printed = TranslateUnit("""
            using System;

            namespace Demo
            {
                public class C
                {
                    public int Run(string ex)
                    {
                        try
                        {
                            throw new InvalidOperationException("boom");
                        }
                        catch
                        {
                            return ex.Length;
                        }
                    }
                }
            }
            """);

        Assert.DoesNotContain("__caught", printed);
        Assert.Contains("} catch {", printed);
        Assert.Contains("return ex.Length", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run(\"outer\"))", "5");
    }

    /// <summary>
    /// C# <c>catch (Exception)</c> maps to the typed-but-unbound G# form of the
    /// same shape (ADR-0177), so a local named <c>__caught</c> in the same method
    /// keeps its meaning and the body still reads both outer locals.
    /// </summary>
    [Fact]
    public void UnboundTypedCatch_BindsNothing_AndLeavesOuterLocalsAlone()
    {
        string printed = TranslateUnit("""
            using System;

            namespace Demo
            {
                public class C
                {
                    public int Run()
                    {
                        string ex = "typed";
                        string __caught = "visible";
                        try
                        {
                            throw new InvalidOperationException("boom");
                        }
                        catch (Exception)
                        {
                            return ex.Length + __caught.Length;
                        }
                    }
                }
            }
            """);

        Assert.DoesNotContain("__caught_", printed);
        Assert.Contains("} catch (Exception) {", printed);
        Assert.Contains("return ex.Length", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run())", "12");
    }

    /// <summary>
    /// The merge used to synthesize binders here and had to number them around
    /// the snippet's own <c>__caught</c> / <c>__caught_2</c> locals. Nothing is
    /// synthesized now: the filter's <c>out</c> declaration stays inline in the
    /// native <c>when</c>, the bare inner <c>catch</c> stays bare, and the only
    /// <c>__caught</c> names in the output are the ones the author wrote.
    /// </summary>
    [Fact]
    public void FilterWithOutDeclaration_StaysInline_AndInventsNoBinder()
    {
        string printed = TranslateUnit("""
            using System;

            namespace Demo
            {
                public class C
                {
                    private static bool Bind(object value, out string text)
                    {
                        text = (string)value;
                        return true;
                    }

                    public int Run(object ex)
                    {
                        try
                        {
                            throw new InvalidOperationException("outer");
                        }
                        catch (Exception) when (Bind(ex, out string __caught))
                        {
                            string __caught_2 = (string)ex;
                            try
                            {
                                throw new ArgumentException("inner");
                            }
                            catch
                            {
                                return __caught_2.Length;
                            }
                        }
                    }
                }
            }
            """);

        Assert.DoesNotContain("__caught_3", printed);
        Assert.DoesNotContain("__caught_4", printed);
        Assert.Contains("catch (Exception) when Bind(ex, out var __caught) {", printed);
        Assert.Contains("} catch {", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run(\"nested\"))", "6");
    }

    /// <summary>
    /// A nested type also named <c>Exception</c> must not capture the catch's
    /// <c>System.Exception</c>: the clause keeps the aliased identity.
    /// </summary>
    [Fact]
    public void UnboundCatch_InsideNestedExceptionHomonym_PreservesSystemExceptionIdentity()
    {
        string printed = TranslateUnit("""
            using System;

            namespace Demo
            {
                public class C
                {
                    public sealed class Exception
                    {
                    }

                    public int Run(bool retryable)
                    {
                        try
                        {
                            throw new ArgumentException("boom");
                        }
                        catch (System.ArgumentException) when (retryable)
                        {
                            return 1;
                        }
                        catch (System.Exception)
                        {
                            return 2;
                        }
                    }
                }
            }
            """);

        Assert.Contains("import SystemException_2 = System.Exception", printed);
        Assert.Contains("catch (SystemException_2)", printed);
        Assert.DoesNotContain("__caught", printed);

        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "1");
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(false))", "2");
    }

    private static string TranslateUnit(string source)
    {
        LoadedCSharpProject project = CSharpProjectLoader.LoadInMemory(new[] { ("Snippet.cs", source) });
        Assert.True(
            project.BoundWithoutErrors,
            "Snippet should bind with no C# errors: " +
                string.Join(Environment.NewLine, project.ErrorDiagnostics));

        LoadedDocument document = Assert.Single(project.Documents);
        var context = new TranslationContext(project.Compilation, document.SemanticModel, document.FilePath);
        CompilationUnit unit = new CSharpToGSharpTranslator().TranslateDocument(document, context);

        Assert.DoesNotContain(context.Diagnostics, d => d.Severity == TranslationSeverity.Unsupported);

        string printed = GSharpPrinter.Print(unit);
        RoundTripResult result = TranslationTestValidation.AssertBinds(printed);
        Assert.True(
            result.Success,
            "Translated G# must round-trip. Errors:\n" +
                string.Join("\n", result.Errors) + "\n\nPrinted:\n" + printed);
        return printed;
    }

    /// <summary>
    /// Compiles <paramref name="printed"/> (with <paramref name="callExpression"/>
    /// appended as a top-level entry statement) with the real <c>gsc</c> and runs
    /// it, asserting its stdout equals <paramref name="expectedOutput"/> — proving
    /// the clause chain's runtime control flow (not just its shape) is correct.
    /// </summary>
    private static void CompileAndRun(string printed, string callExpression, string expectedOutput)
    {
        string compiler = FindCompiler();
        Assert.True(compiler != null, "gsc.dll must be built (dotnet build GSharp.sln) before running this test.");

        string workDir = Path.Combine(AppContext.BaseDirectory, "issue-2235-e2e", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(workDir);
        string gsPath = Path.Combine(workDir, "Snippet.gs");
        string dllPath = Path.Combine(workDir, "Snippet.dll");
        File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine);

        (int compileExit, string compileOut) = RunDotnet(
            $"\"{compiler}\" /target:exe /out:\"{dllPath}\" \"{gsPath}\"");
        Assert.True(
            compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
            "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut +
                "\n\nTranslated G#:\n" + printed);

        (int runExit, string runOut) = RunDotnet($"\"{dllPath}\"");
        Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut);
        Assert.Equal(expectedOutput, runOut.Trim());
    }

    private static (int Exit, string Output) RunDotnet(string arguments)
    {
        var psi = new ProcessStartInfo("dotnet", arguments)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = Process.Start(psi);
        var output = new StringBuilder();
        output.Append(process.StandardOutput.ReadToEnd());
        output.Append(process.StandardError.ReadToEnd());
        process.WaitForExit();
        return (process.ExitCode, output.ToString());
    }

    private static string FindCompiler()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            foreach (string config in new[] { "Release", "Debug" })
            {
                string candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            dir = dir.Parent;
        }

        return null;
    }
}
