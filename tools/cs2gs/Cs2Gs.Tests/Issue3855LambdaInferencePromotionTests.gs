// <copyright file="Issue3855LambdaInferencePromotionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import System
import System.Diagnostics
import System.IO
import System.Text
import Xunit

/// Issue #3855: in a nullable-OBLIVIOUS compilation the #1072 promotion
/// (`PromoteIfUsedAsNullable`) renders a null-tested parameter `T?`.
/// That is right for a parameter whose annotation is merely DESCRIPTIVE — the
/// target type is already fixed, and widening an input position is
/// contravariance, so a `(T?) -> R` literal still converts to a
/// `(T) -> R` target.
///
/// It is wrong for a LAMBDA parameter that is an argument to a generic method
/// with INFERRED type arguments. There the annotation is not checked against a
/// target — it CHOOSES one. `xs.Where(d => d != null)` emitted
/// `.Where((d T?) -> d != nil)`, gsc inferred `TSource := T?`, and
/// the whole sequence widened to `sequence[T?]`: every downstream member
/// access then ran on a nullable receiver (`GS0158 Cannot find member` /
/// `GS0154`) several lines away from the lambda that caused it.
///
/// The canonical shape is the one from
/// `CSharpToGSharpTranslator.PragmaSuppressions.cs` — a
/// `Select(cast).Where(x => x is not null).OrderBy(...)` chain, which
/// has now defeated two separate fixes (#3835's rewrite and #3854's cast
/// lowering) — so it is asserted here both at the translation level and by
/// EXECUTING the emitted G#.
class Issue3855LambdaInferencePromotionTests {
    @Fact
    func InferredGenericCall_NullTestedLambdaParameter_IsNotWidenedToNullable() {
        let printed = Translate(InequalityChainSource)
        // The whole point: the filter lambda keeps the element type the chain
        // actually carries, so the ORDERING lambda four characters later sees
        // the same type. Asserted on both lambdas, not just the promoted one —
        // the pre-fix output was internally inconsistent on its face
        // (`(d Node?)` feeding `(d Node)`).
        Assert.Contains("(d Node) -> d != nil", printed, StringComparison.Ordinal)
        Assert.Contains("(d Node) -> d.Span", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("(d Node?)", printed, StringComparison.Ordinal)
    }

    @Fact
    func InferredGenericCall_IsNotNullPattern_IsNotWidenedToNullable() {
        let printed = Translate(PatternChainSource)
        Assert.Contains("(d Node) -> d != nil", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("(d Node?)", printed, StringComparison.Ordinal)
    }

    /// The executing half. On `origin/main` the emitted G# does not even
    /// compile (`GS0158 Cannot find member Span` plus `GS0129` on the
    /// accumulation), so this pins BOTH that gsc accepts the emitted chain and
    /// that it computes the same answer the C# does — 3 + 1 = 4 — rather than,
    /// say, silently dropping the filtered elements.
    @Fact
    func InferredGenericCall_TranslatedChainCompilesAndProducesTheCSharpAnswer() {
        let printed = Translate(InequalityChainSource)
        let stdout = CompileAndRun(
            printed,
            "let xs = []object{ Node(3), Node(1) }\nSystem.Console.WriteLine(Chain.Total(xs).ToString())"
        )
        Assert.Equal("4", stdout.Trim())
    }

    /// The `is not null` spelling must reach the same executable answer as
    /// the `!= null` one — the two entries into `IsUsedAsNullable`
    /// must not diverge.
    @Fact
    func InferredGenericCall_PatternChainCompilesAndProducesTheCSharpAnswer() {
        let printed = Translate(PatternChainSource)
        let stdout = CompileAndRun(
            printed,
            "let xs = []object{ Node(3), Node(1) }\nSystem.Console.WriteLine(PatternChain.Total(xs).ToString())"
        )
        Assert.Equal("4", stdout.Trim())
    }

    @Fact
    func ConjoinedYieldGuard_DoesNotWidenTheIteratorElement() {
        let printed = Translate(ConjoinedYieldGuardSource)
        Assert.Contains("Names(raw IEnumerable[string]) sequence[string]", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("sequence[string?]", printed, StringComparison.Ordinal)
    }

    /// The executing half: the guard the analyzer now believes really does hold
    /// at run time, so the narrowed element must not merely compile — it must
    /// produce the same answer, and no `!!` in the emitted chain may throw.
    @Fact
    func ConjoinedYieldGuard_CompilesAndProducesTheCSharpAnswer() {
        let printed = Translate(ConjoinedYieldGuardSource)
        let stdout = CompileAndRun(
            printed,
            "let xs = []string{ \"Ga\", \"\", \"Gb\", \"z\" }\nSystem.Console.WriteLine(Ids.Count(xs).ToString())"
        )
        Assert.Equal("2", stdout.Trim())
    }

    @Fact
    func FixedDelegateTarget_NullTestedLambdaParameter_IsStillPromoted() {
        let printed = Translate(FixedTargetSource)
        Assert.Contains("(s string?)", printed, StringComparison.Ordinal)
    }

    @Fact
    func ExplicitTypeArguments_NullTestedLambdaParameter_IsStillPromoted() {
        let printed = Translate(ExplicitTypeArgumentSource)
        Assert.Contains("(s string?)", printed, StringComparison.Ordinal)
    }

    @Fact
    func ConcreteArrowPositionInGenericCall_NullTestedLambdaParameter_IsStillPromoted() {
        let printed = Translate(ConcreteArrowPositionSource)
        Assert.Contains("(s string?)", printed, StringComparison.Ordinal)
    }

    shared {
        /// The canonical #3855/#3843 chain, in a nullable-oblivious compilation:
        /// `Select` an explicit cast, filter the nulls out at sequence level,
        /// then reach a member on the surviving elements.
        private const InequalityChainSource string = `
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;

    public class Node
    {
        public Node(int span) { this.Span = span; }

        public int Span { get; set; }
    }

    public class Chain
    {
        public static int Total(IEnumerable<object> items)
        {
            var sum = 0;
            foreach (var d in items
                .Select(t => (Node)t)
                .Where(d => d != null)
                .OrderBy(d => d.Span))
            {
                sum += d.Span;
            }

            return sum;
        }
    }
}
`

        /// The same chain spelled with the `is not null` pattern the real
        /// `PragmaSuppressions.cs` uses — a second, independent entry into
        /// `IsUsedAsNullable` (its `IsPatternExpressionSyntax` arm).
        private const PatternChainSource string = `
namespace Demo
{
    using System.Collections.Generic;
    using System.Linq;

    public class Node
    {
        public Node(int span) { this.Span = span; }

        public int Span { get; set; }
    }

    public class PatternChain
    {
        public static int Total(IEnumerable<object> items)
        {
            var sum = 0;
            foreach (var d in items
                .Select(t => (Node)t)
                .Where(d => d is not null)
                .OrderBy(d => d.Span))
            {
                sum += d.Span;
            }

            return sum;
        }
    }
}
`

        /// The fix's boundary on the other side: a lambda handed to a NON-generic
        /// callee has a fixed target type, so the #1072 promotion still applies.
        /// Nothing infers from the annotation; the widened input position is plain
        /// contravariance.
        private const FixedTargetSource string = `
namespace Demo
{
    using System;

    public class FixedTarget
    {
        public static void Run(Action<string> handler)
        {
            handler("x");
        }

        public static void Go()
        {
            Run(s => { if (s == null) { return; } });
        }
    }
}
`

        /// A generic callee whose type arguments are written EXPLICITLY infers
        /// nothing, so the annotation is descriptive again and the promotion stands.
        private const ExplicitTypeArgumentSource string = `
namespace Demo
{
    using System;

    public class ExplicitArgs
    {
        public static void Run<T>(Action<T> handler, T value)
        {
            handler(value);
        }

        public static void Go()
        {
            Run<string>(s => { if (s == null) { return; } }, "x");
        }
    }
}
`

        /// A generic callee whose lambda parameter position is CONCRETE — the
        /// method's type parameter appears only in the RESULT position — infers
        /// nothing from this annotation either, so the promotion stands. This is
        /// what keeps the rule narrower than "any lambda in any generic call".
        private const ConcreteArrowPositionSource string = `
namespace Demo
{
    using System;

    public class ConcreteArrow
    {
        public static T Run<T>(Func<string, T> project)
        {
            return project("x");
        }

        public static int Go()
        {
            return Run(s => s == null ? 0 : s.Length);
        }
    }
}
`

        /// The THIRD seam behind `PragmaSuppressions.cs` (the two above are the
        /// #3843 cast lowering and the #3855 lambda promotion): the #3501 yield
        /// element-taint rule already stands down for a yield a null guard
        /// dominates (#3700/#3714), but its `IsNullTestOf` only recognised a
        /// BARE test. The real shape conjoins the guard with the test it protects —
        /// `if (text != null && text.StartsWith("GSA")) { yield return
        /// text; }` — so the iterator's element widened to `string?` and the
        /// widened element then failed every non-nullable consumer downstream
        /// (`GS0155` at `state[id] = disable`).
        private const ConjoinedYieldGuardSource string = `
namespace Demo
{
    using System.Collections.Generic;

    public class Ids
    {
        public static IEnumerable<string> Names(IEnumerable<string> raw)
        {
            foreach (string candidate in raw)
            {
                string text = candidate.Length == 0 ? null : candidate;
                if (text != null && text.StartsWith("G"))
                {
                    yield return text;
                }
            }
        }

        public static int Count(IEnumerable<string> raw)
        {
            var seen = new Dictionary<string, bool>();
            foreach (string id in Names(raw))
            {
                seen[id] = true;
            }

            return seen.Count;
        }
    }
}
`

        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            Assert.Equal(NullableContextOptions.Disable, project.Compilation.Options.NullableContextOptions)
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

        private func CompileAndRun(printed string, entryStatements string) string {
            let compiler string? = FindCompiler()
            Assert.True(
                compiler != nil,
                "gsc.dll must be built (build the repository solution) before running this test."
            )
            let workDir = Path.Combine(AppContext.BaseDirectory, "issue-3855-e2e", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(workDir)
            let gsPath = Path.Combine(workDir, "Snippet.gs")
            let dllPath = Path.Combine(workDir, "Snippet.dll")
            File.WriteAllText(gsPath, printed + Environment.NewLine + entryStatements + Environment.NewLine)
            let (compileExit, compileOut) = RunDotnet("\"$compiler\" /target:exe /out:\"$dllPath\" \"$gsPath\"")
            Assert.True(
                compileExit == 0 && !compileOut.Contains("error", StringComparison.OrdinalIgnoreCase),
                "gsc must compile the translated snippet with zero errors. Output:\n" + compileOut + `

Translated G#:
` + printed
            )
            let (runExit, stdout) = RunDotnet("\"$dllPath\"")
            Assert.True(runExit == 0, "Translated snippet must run successfully. Output:\n" + stdout + `

Translated G#:
` + printed)
            return stdout
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
