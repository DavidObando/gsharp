// <copyright file="Issue2235FilteredCatchFallthroughTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Translation tests for issue #2235 (follow-up to #1724, ADR-0115 §B): a
/// `catch ... when (filter)` clause with a later sibling catch whose
/// type could also receive the exception. C# requires a false filter to fall
/// through to that sibling, which the per-clause rethrow-on-false-filter
/// lowering could not express — so cs2gs used to merge the offending clause
/// and every clause after it into ONE G# catch whose body manually replayed
/// C#'s top-to-bottom type-then-filter matching over a synthetic binder.
///
/// ADR-0177 gave G# native `catch (T) when …` clauses backed by real CLR
/// filter regions, so top-to-bottom matching and fall-through-on-false-filter
/// are the runtime's job again: every C# clause maps to exactly one G# clause
/// and no `__caught` binder is invented (issue #3897 family 1).
///
/// The end-to-end expectations below are unchanged from the merge era — the
/// same programs must still print the same answers.
open class Issue2235FilteredCatchFallthroughTranslationTests {
    /// The issue's exact repro: two back-to-back filtered
    /// `OperationCanceledException when (...)` clauses, both of which
    /// must fall through to a later `catch (Exception)` when their own
    /// filter is false. Proves 2+ filtered clauses in a row still chain.
    @Fact
    func TwoBackToBackFilteredClauses_FallThroughToLaterExceptionCatch() {
        let printed = TranslateUnit(`
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
}`)
        Assert.DoesNotContain("__caught", printed)
        Assert.Contains("catch (OperationCanceledException) when ct.IsCancellationRequested", printed)
        Assert.Contains("catch (OperationCanceledException) when !ct.IsCancellationRequested", printed)
        Assert.Contains("catch (Exception)", printed)
        Assert.Contains("return 1", printed)
        Assert.Contains("return 2", printed)
        Assert.Contains("return 3", printed)
        // A CancellationToken defaults to not-requested, so `ct.IsCancellationRequested`
        // is false for the first filtered clause and its negation is true for the
        // second: the exception must fall through the first filter and be caught
        // by the second clause's body (return 2), not the first or the final
        // `catch (Exception)`.
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(System.Threading.CancellationToken()))", "2")
    }

    /// Simpler shape: a single filtered clause with one overlapping later
    /// sibling. Runtime proof both clauses are live: a filter-true exception is
    /// caught by the first clause, a filter-false one falls through to the
    /// sibling.
    @Fact
    func SingleFilteredClause_WithOverlappingSibling_FallsThroughWhenFilterFalse() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        public int Run(bool retryable)
        {
            try
            {
                throw new InvalidOperationException("boom");
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
}`)
        Assert.DoesNotContain("__caught", printed)
        Assert.Contains("catch (ex InvalidOperationException) when retryable", printed)
        Assert.Contains("catch (Exception)", printed)
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "1")
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(false))", "2")
    }

    /// Disjoint sibling types used to select the "safe" rethrow-if-false
    /// lowering instead of the merge. Neither path exists now: the clause
    /// translates the same way whatever its siblings are.
    @Fact
    func FilteredClause_WithDisjointSibling_EmitsTheSameNativeFilter() {
        let printed = TranslateUnit(`
using System;
namespace Demo
{
    public class C
    {
        public int Run(bool retryable)
        {
            try
            {
                throw new InvalidOperationException("boom");
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
}`)
        Assert.Contains("catch (ex InvalidOperationException) when retryable", printed)
        Assert.Contains("catch (FormatException)", printed)
        Assert.DoesNotContain("rethrow", printed)
        Assert.DoesNotContain("__caught", printed)
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "1")
    }

    /// M2 regression guard, now trivially satisfied: the handler reads a
    /// SUBTYPE-only member off its own binder. The merge had to recover that
    /// type through an `is` smart cast (ADR-0069); a native clause is simply
    /// declared at the subtype, so the member is in scope directly.
    @Fact
    func FilteredClause_AccessesSubtypeOnlyMember_OnItsOwnBinder() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("catch (ex MyCustomException) when retryable", printed)
        Assert.DoesNotContain("__caught", printed)
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "42")
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(false))", "-1")
    }

    /// M1 regression guard: a closure inside a filtered handler captures the
    /// catch variable and reads a subtype-only member from it. Under the merge
    /// this was where a shared-binder name collision silently produced the
    /// unnarrowed type; with one clause per source clause there is no shared
    /// binder to collide with, and the capture is of the real catch variable.
    @Fact
    func FilteredClause_ClosureCapturesCatchVariable_ReadsSubtypeOnlyMember() {
        let printed = TranslateUnit(`
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
}`)
        Assert.Contains("catch (ex MyCustomException) when retryable", printed)
        Assert.DoesNotContain("__caught", printed)
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "99")
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(false))", "-1")
    }

    /// A method whose own parameter is literally named `__caught`: the merge
    /// had to rename its synthetic binder around it. Nothing is synthesized now,
    /// so the only `__caught` in the output is the user's own parameter.
    @Fact
    func NestedFilteredCatches_InventNoBinder_AndLeaveASourceNamedCaughtAlone() {
        let printed = TranslateUnit(`using System;

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
}`)
        Assert.DoesNotContain("__caught_", printed)
        Assert.Contains("catch (ex InvalidOperationException) when __caught == \"outer\"", printed)
        Assert.Contains("catch (inner ArgumentException) when __caught == \"outer\"", printed)
        Assert.Contains("catch (Exception)", printed)
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(\"outer\"))", "7")
    }

    /// A bare C# `catch` stays a bare G# `catch` (ADR-0177), so there is
    /// no synthesized binder that could shadow the outer `ex` the body reads.
    @Fact
    func BareCatch_StaysBare_AndCannotShadowAnOuterNameCalledEx() {
        let printed = TranslateUnit(`using System;

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
}`)
        Assert.DoesNotContain("__caught", printed)
        Assert.Contains("} catch {", printed)
        Assert.Contains("return ex.Length", printed)
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(\"outer\"))", "5")
    }

    /// C# `catch (Exception)` maps to the typed-but-unbound G# form of the
    /// same shape (ADR-0177), so a local named `__caught` in the same method
    /// keeps its meaning and the body still reads both outer locals.
    @Fact
    func UnboundTypedCatch_BindsNothing_AndLeavesOuterLocalsAlone() {
        let printed = TranslateUnit(`using System;

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
}`)
        Assert.DoesNotContain("__caught_", printed)
        Assert.Contains("} catch (Exception) {", printed)
        Assert.Contains("return ex.Length", printed)
        CompileAndRun(printed, "System.Console.WriteLine(C().Run())", "12")
    }

    /// The merge used to synthesize binders here and had to number them around
    /// the snippet's own `__caught` / `__caught_2` locals. Nothing is
    /// synthesized now: the filter's `out` declaration stays inline in the
    /// native `when`, the bare inner `catch` stays bare, and the only
    /// `__caught` names in the output are the ones the author wrote.
    @Fact
    func FilterWithOutDeclaration_StaysInline_AndInventsNoBinder() {
        let printed = TranslateUnit(`using System;

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
}`)
        Assert.DoesNotContain("__caught_3", printed)
        Assert.DoesNotContain("__caught_4", printed)
        Assert.Contains("catch (Exception) when Bind(ex, out var __caught) {", printed)
        Assert.Contains("} catch {", printed)
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(\"nested\"))", "6")
    }

    /// A nested type also named `Exception` must not capture the catch's
    /// `System.Exception`: the clause keeps the aliased identity.
    @Fact
    func UnboundCatch_InsideNestedExceptionHomonym_PreservesSystemExceptionIdentity() {
        let printed = TranslateUnit(`using System;

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
}`)
        Assert.Contains("import SystemException_2 = System.Exception", printed)
        Assert.Contains("catch (SystemException_2)", printed)
        Assert.DoesNotContain("__caught", printed)
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(true))", "1")
        CompileAndRun(printed, "System.Console.WriteLine(C().Run(false))", "2")
    }

    shared {
        private func TranslateUnit(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            let printed = GSharpPrinter.Print(unit)
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(printed)
            Assert.True(
                result!!.Success,
                "Translated G# must round-trip. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + printed
            )
            return printed
        }

        /// Compiles [`printed`](paramref) (with [`callExpression`](paramref)
        /// appended as a top-level entry statement) with the real `gsc` and runs
        /// it, asserting its stdout equals [`expectedOutput`](paramref) — proving
        /// the clause chain's runtime control flow (not just its shape) is correct.
        private func CompileAndRun(printed string, callExpression string, expectedOutput string) {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-2235-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + callExpression + Environment.NewLine)
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, runOut) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + runOut)
            Assert.Equal(expectedOutput, runOut.Trim())
        }

        private func RunDotnet(arguments string)(Exit int32, Output string) {
            let psi = ProcessStartInfo("dotnet", arguments){
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            }
            using let process Process? = Process.Start(psi)
            let output = StringBuilder()
            output.Append(process!!.StandardOutput.ReadToEnd())
            output.Append(process!!.StandardError.ReadToEnd())
            process!!.WaitForExit()
            return (process!!.ExitCode, output.ToString())
        }

        private func FindCompiler() string? {
            var dir DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while dir != nil {
                for config in[]string{"Release", "Debug"} {
                    let candidate = Path.Combine(dir.FullName, "out", "bin", config, "Compiler", "gsc.dll")
                    if File.Exists(candidate) {
                        return candidate
                    }
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
