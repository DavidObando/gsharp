// <copyright file="Issue5706NarrowedConditionalIndexTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.Pipeline
import System
import System.IO
import Xunit

/// Issue #5706: preserve nullable results without conditional indexing on a non-null receiver.
/// @remarks ADR-0154: disabling the non-null receiver rewrite makes the original five tests fail with GS0300.
/// On 14f1e3aa2, cast receivers throw on nil, and named constant guards cause nullable indexing errors.
/// Each test also compares the translated program's output with C#.
open class Issue5706NarrowedConditionalIndexTests {
    @Fact
    func NarrowedLocalsAndParameters_PreserveNullableValueTypes() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static string Pick(char value) => "char";
        static string Pick(char? value) => "nullable";
        static string Local(string? seed)
        {
            string? s = seed;
            if (s != null)
            {
                var c = s?[0];
                return Pick(s?[0]) + ":" + c.HasValue + ":" + Pick(c) + ":" + (s?[0]).HasValue;
            }
            return "nil";
        }
        static char? Parameter(string? s) { if (s != null) { return s?[0]; } return null; }
        static char? TypeTest(string? s) { if (s is string) { return s?[0]; } return null; }
        static char? Binding(string? s) { if (s is string value) { return value?[0]; } return null; }
        static char? Constant(string? s) { if (s is "a") { return s?[0]; } return null; }
        static char? Switched(string? s) => s switch { "a" => s?[0], _ => null };
        static char? EarlyExit(string? s) { if (s == null) { return null; } return s?[0]; }
        static string Infer<T>(System.Func<T> value) => typeof(T).Name;
        static string Lambda(string? s) { if (s != null) { return Infer(() => s?[0]); } return "nil"; }
        static string InnerLambda(string? s) => Infer(() => { if (s != null) { return s?[0]; } return null; });
        public static string Run() =>
            Local("a") + " " + Local(null) + " " + Parameter("b") + " " + Parameter(null) + " " +
            TypeTest("c") + " " + Binding("d") + " " + Constant("a") + " " + Switched("a") + " " +
            EarlyExit("e") + " " + Lambda("f") + " " + InnerLambda("g");
    }
}`)
        Assert.Contains("cast[char?](s[0])", printed)
        Assert.DoesNotContain("?[", printed)
    }

    @Fact
    func ArrayAndIndexerElements_PreserveValueAndReferenceNullability() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
using System.Collections.Generic;
namespace Demo
{
    public static class P
    {
        static int? Array(int[]? a) { if (a != null) { return a?[0]; } return null; }
        static int? Collection(List<int>? a) { if (a != null) { var x = a?[0]; return x; } return null; }
        static int? NullableElement(int?[]? a) { if (a != null) { return a?[0]; } return null; }
        static string? ReferenceElement(string[]? a) { if (a != null) { return a?[0]; } return null; }
        static string? NullableReferenceElement(string?[]? a) { if (a != null) { return a?[0]; } return null; }
        public static string Run() =>
            Array(new[] { 4 }) + " " + Collection(new List<int> { 5 }) + " " + NullableElement(new int?[] { null }) + " " +
            NullableElement(new int?[] { 6 }) + " " + ReferenceElement(new[] { "x" }) + " " +
            NullableReferenceElement(new string?[] { null }) + " " + Array(null) + " " + ReferenceElement(null) + "end";
    }
}`)
        Assert.Contains("cast[int32?](a[0])", printed)
        Assert.Contains("cast[string?](a[0])", printed)
        Assert.DoesNotContain("?[", printed)
    }

    @Fact
    func Continuations_LiftOnlyTheFinalResultAndKeepInnerNullChecks() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public class Cell { public static int Touched; public void Touch() { Touched++; } }
    public static class P
    {
        static int indices;
        static int Index() { indices++; return 0; }
        static string? Text(string? s) { if (s != null) { return s?[Index()].ToString(); } return null; }
        static int? Length(string?[]? a) { if (a != null) { return a?[Index()]?.Length; } return null; }
        static char? Nested(string[]? a) { if (a != null) { return a?[Index()][1]; } return null; }
        static char? NestedConditional(string[]? a) { if (a != null) { return a?[Index()]?[1]; } return null; }
        static int? Chained(string?[]? a) { if (a != null) { return a?[Index()]?.ToString().Length; } return null; }
        static void Void(Cell[]? a) { if (a != null) { a?[Index()].Touch(); } }
        public static string Run()
        {
            Void(new[] { new Cell() });
            Void(null);
            return Text("a") + " " + Text(null) + " " + Length(new string?[] { null }) + " " +
                Length(new string?[] { "ab" }) + " " + Nested(new[] { "xy" }) + " " + NestedConditional(new[] { "xy" }) + " " +
                Chained(new string?[] { null }) + " " + Cell.Touched + " " + indices;
        }
    }
}`)
        Assert.Contains("s[Index()].ToString()", printed)
        Assert.Contains("a[Index()]?.Length", printed)
        Assert.Contains("cast[char?](a[Index()][1])", printed)
        Assert.DoesNotContain("?[", printed)
    }

    @Fact
    func OtherNonNullableReceivers_RemoveOnlyTheRedundantHop() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int calls;
        static string Get() { calls++; return "ab"; }
        static char? NonNull(string s) => s?[0];
        static char? Created() => new[] { 'x' }?[0];
        static char? Call() => Get()?[0];
        static char? Conditional(string? s) => (s ?? "z")?[0];
        static char? Maybe(string? s) => s?[0];
        static char? MutableLambda(string? s)
        {
            if (s != null) { System.Func<char?> read = () => s?[0]; s = null; return read(); }
            return null;
        }
        static char? InnerWrite(string? s)
        {
            System.Func<char?> read = () => { if (s != null) { s = null; return s?[0]; } return null; };
            return read();
        }
        public static string Run() =>
            NonNull("a") + " " + Created() + " " + Call() + " " + Conditional(null) + " " +
            Maybe(null) + " " + Maybe("c") + " " + MutableLambda("m") + " " + InnerWrite("w") + " " + calls;
    }
}`)
        Assert.Contains("object.ReferenceEquals(s, nil)", printed)
        Assert.Contains("s?[0]", printed)
        Assert.DoesNotContain("Get()?[", printed)
    }

    @Fact
    func CheckedCastReceivers_KeepNullGuardsAndEvaluateIndicesOnlyAfterTheGuard() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int receivers;
        static int indices;
        static object? Get(object? value) { receivers++; return value; }
        static int Index() { indices++; return 0; }
        static char? Read(object? value) => ((string)value)?[Index()];
        static char? Captured(object? value) => ((string)Get(value))?[Index()];
        static int? Continued(object? value) => ((string)Get(value))?[Index()].GetHashCode();
        static int? Nested(object? value) => ((string?[])Get(value))?[Index()]?.Length;
        static char? Conditional(bool run, object? value) => run ? ((string)Get(value))?[Index()] : null;
        public static string Run() =>
            Read(null) + "|" + Read("a") + "|" + Captured(null) + "|" + Captured("b") + "|" +
            Continued(null) + "|" + Continued("c") + "|" + Nested(null) + "|" +
            Nested(new string?[] { null }) + "|" + Nested(new string?[] { "ab" }) + "|" +
            Conditional(false, "x") + "|" + Conditional(true, null) + "|" + Conditional(true, "d") + "|" +
            receivers + ":" + indices;
    }
}`)
        Assert.Contains("object.ReferenceEquals", printed)
        Assert.DoesNotContain("?[", printed)
    }

    @Fact
    func NonNullableContracts_StillGuardNullValuesAndVoidContinuations() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public class Cell { public static int Touched; public void Touch() { Touched++; } }
    public static class P
    {
        static int receivers;
        static int indices;
        static int Index() { indices++; return 0; }
        static string Get(object? value) { receivers++; return (string)value; }
        static char? Parameter(string s) => s?[Index()];
        static char? Result(object? value) => Get(value)?[Index()];
        static void Void(object? value) { ((Cell[])value)?[Index()].Touch(); }
        public static string Run()
        {
            Void(null);
            Void(new[] { new Cell() });
            return Parameter((string)(object?)null) + "|" + Parameter("a") + "|" +
                Result(null) + "|" + Result("b") + "|" + receivers + ":" + indices + ":" + Cell.Touched;
        }
    }
}`)
        Assert.Contains("object.ReferenceEquals(s, nil)", printed)
        Assert.DoesNotContain("?[", printed)
    }

    @Fact
    func NamedConstantGuards_DoNotImplyGSharpTypeTestNarrowing() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public static class P
    {
        const string K = "a";
        static char? Read(string? s) { if (s is K) { return s?[0]; } return null; }
        public static string Run() => Read("a") + "|" + Read("b") + "|" + Read(null) + "|end";
    }
}`)
        Assert.Contains("s?[0]", printed)
        Assert.DoesNotContain("cast[char?](s[0])", printed)
    }

    @Fact
    func GuardedMembers_UseTheSharedStablePathNarrowing() {
        let printed = AssertRunsWithoutConditionalIndexWarning(`
#nullable enable
namespace Demo
{
    public class Holder { public readonly string? Text; public Holder(string? text) { Text = text; } }
    public static class P
    {
        static bool Guard(Holder h) => h.Text != null && (h.Text?[0]).HasValue;
        public static string Run() => Guard(new Holder("a")) + " " + Guard(new Holder(null));
    }
}`)
        Assert.Contains("cast[char?](h.Text[0])", printed)
        Assert.DoesNotContain("?[", printed)
    }

    shared {
        private func AssertRunsWithoutConditionalIndexWarning(source string) string {
            let printed = Issue5626ConstantPatternNarrowingTests.AssertRunsLikeCSharp(source)
            let directory = Path.Combine(AppContext.BaseDirectory, "issue-5706", Guid.NewGuid().ToString("N"))
            Directory.CreateDirectory(directory)
            try {
                let sourcePath = Path.Combine(directory, "Snippet.gs")
                File.WriteAllText(sourcePath, printed)
                let compiler = LocalFunctionHoistTranslationTests.FindCompiler()
                Assert.NotNull(compiler)
                let result = GscInvoker(compiler!!).Compile(
                    []string{sourcePath},
                    Path.Combine(directory, "Snippet.dll"),
                    TargetKind.Library,
                    Array.Empty[string]()
                )
                Assert.True(result.Succeeded, result.Output)
                Assert.True(!result.Output.Contains("GS0300", StringComparison.Ordinal), result.Output + "\n" + printed)
            } finally {
                Directory.Delete(directory, recursive: true)
            }
            return printed
        }
    }
}
