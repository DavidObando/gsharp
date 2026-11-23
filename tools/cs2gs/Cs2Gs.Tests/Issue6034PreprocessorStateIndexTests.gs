// <copyright file="Issue6034PreprocessorStateIndexTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import CompilationMeasurements = GSharp.Core.CodeAnalysis.Compilation.CompilationMeasurements
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Linq
import System.Text
import System.Threading.Tasks
import Xunit
import Xunit.Abstractions

/// Issue #6034: index conditional preprocessor state once per syntax tree instead
/// of re-enumerating `SyntaxTree.GetRoot().DescendantTrivia(descendIntoTrivia: true)`
/// up to each conditional invocation.
/// @remarks Discrimination witness (ADR-0154): reverting `IsElidedInvocation` to
/// prefix trivia traversal fails both scaling tests (`builds=0`); an uncached
/// index mutant fails `builds == 1` (`128/256/512`) and scales directives;
/// dropping `directive.IsActive` fails inactive-branch controls (`"a|-|c|d|3:3"`
/// and `NullReferenceException`); dropping `OverriddenMethod` fails the
/// inherited-attribute control (`"1|-|3|4|3:3"`).
open class Issue6034PreprocessorStateIndexTests {
    private let output ITestOutputHelper

    init(output ITestOutputHelper) {
        this.output = output
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func CommentedConditionalCalls_ScaleLinearlyInWorkAndAllocations(withDirectives bool) {
        let builds = List[int64]()
        let directiveVisits = List[int64]()
        let queries = List[int64]()
        let allocatedBytes = List[int64]()
        for repetitions in[]int32{16, 128, 256, 512} {
            let source = BuildCommentedConditionalSource(repetitions, withDirectives)
            let tree = CSharpSyntaxTree.ParseText(
                source,
                CSharpParseOptions(LanguageVersion.Latest).WithPreprocessorSymbols([]string{"FROM_OPTIONS"}),
                path: "Scaling.cs"
            )
            let compilation = CSharpCompilation.Create(
                "Issue6034Scaling$repetitions",
                []SyntaxTree{tree},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            Assert.Empty(compilation.GetDiagnostics().Where((d Diagnostic) -> d.Severity == DiagnosticSeverity.Error))
            let model = compilation.GetSemanticModel(tree)
            let document = LoadedDocument("Scaling.cs", tree, model)
            let (printed, bytes) = MeasureTranslationAllocations(compilation, document)
            let runBody = RunBodyOf(printed)
            Assert.DoesNotContain("Skip(", runBody, StringComparison.Ordinal)
            let (buildCount, visitCount, queryCount, measuredPrinted) = MeasurePreprocessorWork(compilation, document)
            Assert.Equal(Encoding.UTF8.GetBytes(printed), Encoding.UTF8.GetBytes(measuredPrinted))
            this.output.WriteLine(
                "Issue6034 withDirectives=$withDirectives N=$repetitions: builds=$buildCount, " +
                    "directives=$visitCount, queries=$queryCount, alloc=$bytes"
            )
            if repetitions != 16 {
                builds.Add(buildCount)
                directiveVisits.Add(visitCount)
                queries.Add(queryCount)
                allocatedBytes.Add(bytes)
            }
        }
        Assert.All(builds, (count int64) -> Assert.Equal(1, count))
        let expectedDirectives int64 = if withDirectives {
            3
        } else {
            0
        }
        Assert.All(directiveVisits, (count int64) -> Assert.Equal(expectedDirectives, count))
        Assert.True(
            queries[0] > 0 && queries[1] <= queries[0] * 3 && queries[2] <= queries[1] * 3,
            "Conditional symbol queries must scale linearly: ${string.Join(", ", queries)}."
        )
        Assert.True(
            allocatedBytes[0] > 0 &&
                allocatedBytes[1] <= allocatedBytes[0] * 3 &&
                allocatedBytes[2] <= allocatedBytes[1] * 3,
            "Translation allocations must scale linearly: ${string.Join(", ", allocatedBytes)}."
        )
    }

    @Fact
    func DirectivesAndInactiveIfBranch_ControlElisionAndArgumentEffects() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#define ACTIVE
#define SHADOWED
#undef SHADOWED
#if false
#define INACTIVE_BRANCH
#endif
#if ACTIVE
#define NESTED_ACTIVE
#endif
#nullable enable
using System;
using System.Diagnostics;

public static class Demo
{
    static int effects, calls;
    static string Touch(string tag) { effects++; return tag; }

    [Conditional("ACTIVE")]
    static void OnActive(string value) { calls++; }

    [Conditional("SHADOWED")]
    static void OnShadowed(string value) { calls++; }

    [Conditional("INACTIVE_BRANCH")]
    static void OnInactiveBranch(string value) { calls++; }

    [Conditional("NESTED_ACTIVE")]
    static void OnNestedActive(string value) { calls++; }

    public static string Run()
    {
        string? a = null;
        OnActive(a ??= Touch("a"));
        string? b = null;
        OnShadowed(b ??= Touch("b"));
        string? c = null;
        OnInactiveBranch(c ??= Touch("c"));
        string? d = null;
        OnNestedActive(d ??= Touch("d"));
        return (a?[0].ToString() ?? "-") + "|" + (b?[0].ToString() ?? "-") + "|" +
            (c?[0].ToString() ?? "-") + "|" + (d?[0].ToString() ?? "-") + "|" +
            effects + ":" + calls;
    }
}
`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "a|-|-|d|2:2", conditionalCompilation: ConditionalCompilationPolicy.Warn)
        let runBody = RunBodyOf(printed)
        Assert.Contains("OnActive(", runBody, StringComparison.Ordinal)
        Assert.Contains("OnNestedActive(", runBody, StringComparison.Ordinal)
        Assert.DoesNotContain("OnShadowed(", runBody, StringComparison.Ordinal)
        Assert.DoesNotContain("OnInactiveBranch(", runBody, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(false, "-|-|-|0:0")
    @InlineData(true, "a|-|c|2:2")
    func ParseOptionSymbols_RespectSyntaxTreeOptionsAndUndef(defineFromOptions bool, expectedOutput string) {
        let symbols = if defineFromOptions {
            []string{"FROM_OPTIONS", "UNDEF_FROM_SOURCE", "BOTH"}
        } else {
            Array.Empty[string]()
        }
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#undef UNDEF_FROM_SOURCE
#nullable enable
using System;
using System.Diagnostics;

public static class Demo
{
    static int effects, calls;
    static string Touch(string tag) { effects++; return tag; }

    [Conditional("FROM_OPTIONS")]
    static void OnOption(string value) { calls++; }

    [Conditional("UNDEF_FROM_SOURCE")]
    static void OnUndef(string value) { calls++; }

    [Conditional("FROM_OPTIONS"), Conditional("OTHER")]
    static void OnEither(string value) { calls++; }

    public static string Run()
    {
        string? a = null;
        OnOption(a ??= Touch("a"));
        string? b = null;
        OnUndef(b ??= Touch("b"));
        string? c = null;
        OnEither(c ??= Touch("c"));
        return (a?[0].ToString() ?? "-") + "|" + (b?[0].ToString() ?? "-") + "|" +
            (c?[0].ToString() ?? "-") + "|" + effects + ":" + calls;
    }
}
`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: expectedOutput, preprocessorSymbols: symbols)
        let runBody = RunBodyOf(printed)
        Assert.DoesNotContain("OnUndef(", runBody, StringComparison.Ordinal)
        if defineFromOptions {
            Assert.Contains("OnOption(", runBody, StringComparison.Ordinal)
            Assert.Contains("OnEither(", runBody, StringComparison.Ordinal)
        } else {
            Assert.DoesNotContain("OnOption(", runBody, StringComparison.Ordinal)
            Assert.DoesNotContain("OnEither(", runBody, StringComparison.Ordinal)
        }
    }

    @Fact
    func MultipleConditionalAttributes_AndOverriddenMethods_PreserveOrAndInheritedConditions() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#define SECOND
#nullable enable
using System;
using System.Diagnostics;

public static class Demo
{
    static int effects, calls;
    static string Touch(string tag) { effects++; return tag; }

    [Conditional("MISSING_FIRST")]
    [Conditional("SECOND")]
    static void MultiHit(string value) { calls++; }

    [Conditional("MISSING_FIRST")]
    [Conditional("MISSING_SECOND")]
    static void MultiMiss(string value) { calls++; }

    class Base
    {
        [Conditional("MISSING_BASE")]
        public virtual void ElidedVirtual(string value) { calls++; }

        [Conditional("SECOND")]
        public virtual void ActiveVirtual(string value) { calls++; }
    }

    sealed class Derived : Base
    {
        public override void ElidedVirtual(string value) { calls++; }
        public override void ActiveVirtual(string value) { calls++; }
    }

    public static string Run()
    {
        var d = new Derived();
        string? m1 = null;
        MultiHit(m1 ??= Touch("1"));
        string? m2 = null;
        MultiMiss(m2 ??= Touch("2"));
        string? v1 = null;
        d.ElidedVirtual(v1 ??= Touch("3"));
        string? v2 = null;
        d.ActiveVirtual(v2 ??= Touch("4"));
        return (m1 ?? "-") + "|" + (m2 ?? "-") + "|" + (v1 ?? "-") + "|" + (v2 ?? "-") + "|" + effects + ":" + calls;
    }
}
`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "1|-|-|4|2:2")
        let runBody = RunBodyOf(printed)
        Assert.Contains("MultiHit(", runBody, StringComparison.Ordinal)
        Assert.DoesNotContain("MultiMiss(", runBody, StringComparison.Ordinal)
        Assert.DoesNotContain("ElidedVirtual(", runBody, StringComparison.Ordinal)
        Assert.Contains("ActiveVirtual(", runBody, StringComparison.Ordinal)
    }

    @Fact
    func ElidedVsActiveCalls_PreserveConditionalAccessAndLoopArgumentEffects() {
        let printed = Issue5617ByReferenceAccessorNarrowingTests.AssertRunsLikeCSharp(`
#define ACTIVE_COND
#if false
#define INACTIVE_COND
#endif
#nullable enable
using System;
using System.Diagnostics;

public static class Demo
{
    static int effects, calls;
    static string Touch(string tag) { effects++; return tag; }

    sealed class Receiver
    {
        [Conditional("INACTIVE_COND")]
        public void Skip(string value) { calls++; }

        [Conditional("ACTIVE_COND")]
        public void Keep(string value) { calls++; }

        public static Receiver Make() { effects++; return new Receiver(); }
    }

    [Conditional("INACTIVE_COND")]
    static void SkipStatic(string value) { calls++; }

    public static string Run()
    {
        string? elided = "ok";
        Receiver.Make()?.Skip(elided = null!);
        for (int i = 0; i < 2; i++)
        {
            SkipStatic(elided = null!);
        }
        string? active = null;
        Receiver.Make()?.Keep(active ??= Touch("kept"));
        return elided[0] + "|" + (active?[0].ToString() ?? "-") + "|" + effects + ":" + calls;
    }
}
`, rejectConditionalIndexWarnings: true, strictIl: true, expectedOutput: "o|k|2:1", conditionalCompilation: ConditionalCompilationPolicy.Warn)
        let runBody = RunBodyOf(printed)
        Assert.DoesNotContain("Skip(", runBody, StringComparison.Ordinal)
        Assert.DoesNotContain("SkipStatic(", runBody, StringComparison.Ordinal)
        Assert.Contains("Keep(", runBody, StringComparison.Ordinal)
    }

    shared {
        private func RunBodyOf(printed string) string {
            let start = printed.IndexOf("func Run()", StringComparison.Ordinal)
            Assert.True(start >= 0, "Expected func Run() in translated output:\n" + printed)
            return printed.Substring(start)
        }

        private func BuildCommentedConditionalSource(repetitions int32, withDirectives bool) string {
            let builder = StringBuilder()
            if withDirectives {
                builder.AppendLine("#define ACTIVE")
                builder.AppendLine("#if false")
                builder.AppendLine("#define IGNORED")
                builder.AppendLine("#endif")
                builder.AppendLine("#undef IGNORED")
                builder.AppendLine("#nullable enable")
            }
            builder.AppendLine("using System.Diagnostics;")
            builder.AppendLine()
            builder.AppendLine("public static class Demo")
            builder.AppendLine("{")
            builder.AppendLine("    [Conditional(\"MISSING\")]")
            builder.AppendLine("    static void Skip(int value) { }")
            builder.AppendLine()
            builder.AppendLine("    public static string Run()")
            builder.AppendLine("    {")
            for var i = 0; i < repetitions; i++ {
                builder.AppendLine("        // Repeat this comment and call with successive values.")
                builder.AppendLine("        Skip($i);")
            }
            builder.AppendLine("        return \"\";")
            builder.AppendLine("    }")
            builder.AppendLine("}")
            return builder.ToString()
        }

        private func MeasureTranslationAllocations(compilation CSharpCompilation, document LoadedDocument)(
            Printed string,
            AllocatedBytes int64
        ) {
            return Task
                .Run(
                () -> {
                    let context = TranslationContext(compilation, document.SemanticModel, document.FilePath)
                    let translator = CSharpToGSharpTranslator(){
                        ConditionalCompilation = ConditionalCompilationPolicy.Warn
                    }
                    let before = GC.GetAllocatedBytesForCurrentThread()
                    let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
                    let allocated = GC.GetAllocatedBytesForCurrentThread() - before
                    return (printed, allocated)
                }
            )
                .GetAwaiter()
                .GetResult()
        }

        private func MeasurePreprocessorWork(compilation CSharpCompilation, document LoadedDocument)(
            Builds int64,
            DirectiveVisits int64,
            Queries int64,
            Printed string
        ) {
            using let measurements = CompilationMeasurements.Start("issue-6034-preprocessor-work")
            let context = TranslationContext(compilation, document.SemanticModel, document.FilePath)
            let translator = CSharpToGSharpTranslator(){ConditionalCompilation = ConditionalCompilationPolicy.Warn}
            let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
            return (
                measurements.GetCounter("translation.preprocessor_index_builds"),
                measurements.GetCounter("translation.preprocessor_directive_visits"),
                measurements.GetCounter("translation.preprocessor_symbol_queries"),
                printed
            )
        }
    }
}
