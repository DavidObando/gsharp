// <copyright file="ByRefOperandNullForgivenessTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// A by-reference argument never carries a non-null assertion. C#'s `!`
/// is allowed on a variable passed `ref`/`out`/`in` and only
/// silences a warning; its
/// G# spelling `x!!` is a value, so `&x!!` is rejected (GS9001,
/// "Cannot take address"). The Regex generator's backtracking code passes
/// `ref base.runstack!`, which gsgen back-translates (ADR-0192 follow-on 2).
open class ByRefOperandNullForgivenessTranslationTests {
    @Fact
    func RefArgument_OnInheritedField_DropsTheAssertion() {
        // The generator's shape: a protected nullable base field under `!`.
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Runner
    {
        protected int[]? runstack = new int[4];
    }

    public static class Stack
    {
        public static void Push(ref int[] stack, int value) => stack[0] = value;
    }

    public class Derived : Runner
    {
        public int Run()
        {
            Stack.Push(ref base.runstack!, 7);
            return base.runstack![0];
        }
    }
}`)
        Assert.Contains("Stack.Push(&base.runstack, 7)", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("&base.runstack!!", printed, StringComparison.Ordinal)
    }

    @Fact
    func RefArgument_OnLocalAndParenthesized_DropsTheAssertion() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public static class C
    {
        private static void Fill(ref string text) => text = "x";

        public static string Run(string? input)
        {
            string? local = input;
            Fill(ref local!);
            Fill(ref (local!));
            return local;
        }
    }
}`)
        Assert.DoesNotMatch("&\\(?local!!", printed)
        Assert.Contains("Fill(&local)", printed, StringComparison.Ordinal)
    }

    @Fact
    func OutAndInArguments_DropTheAssertion() {
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Holder
    {
        public string? Text;
    }

    public static class C
    {
        private static void Produce(out string text) => text = "x";

        private static int Measure(in string text) => text.Length;

        public static int Run(Holder holder)
        {
            string? local = null;
            Produce(out local!);
            Produce(out holder.Text!);
            return Measure(in local!) + Measure(in holder.Text!);
        }
    }
}`)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        Assert.Contains("Produce(out local)", printed, StringComparison.Ordinal)
        Assert.Contains("Produce(&holder.Text)", printed, StringComparison.Ordinal)
        Assert.Contains("Measure(in local)", printed, StringComparison.Ordinal)
        Assert.Contains("Measure(&holder.Text)", printed, StringComparison.Ordinal)
    }

    @Fact
    func RefConstructorInitializerArgument_DropsTheAssertion() {
        // Constructor-initializer arguments take the null-seam path
        // (TranslateNullSeamArgument), not TranslateArgumentValue.
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Base
    {
        public Base(ref string? text) => text = "x";
    }

    public class Derived : Base
    {
        private static string? s_text;

        public Derived()
            : base(ref s_text!)
        {
        }
    }
}`)
        Assert.DoesNotContain("!!", printed, StringComparison.Ordinal)
        Assert.Contains(": base(&", printed, StringComparison.Ordinal)
    }

    @Fact
    func OnlyTheOutermostAssertionIsDropped() {
        // `Next!` guards a real dereference on the way to the variable, so it
        // stays `Next!!`; only the assertion on the variable itself goes.
        let printed = TranslateUnit(`
#nullable enable
namespace Demo
{
    public class Node
    {
        public Node? Next;
        public int[]? Items;
    }

    public static class C
    {
        private static void Fill(ref int[] items) => items = new int[1];

        public static void Run(Node holder)
        {
            Fill(ref holder.Next!.Items!);
            Fill(ref (holder.Next!.Items!));
        }
    }
}`)
        Assert.Equal(2, CountOccurrences(printed, "holder.Next!!.Items"))
        Assert.DoesNotContain("Items!!", printed, StringComparison.Ordinal)
        Assert.Contains("Fill(&holder.Next!!.Items)", printed, StringComparison.Ordinal)
    }

    shared {
        private func CountOccurrences(haystack string, needle string) int32 {
            var count = 0
            for var index = haystack.IndexOf(needle, StringComparison.Ordinal); index >= 0; index = haystack.IndexOf(
                needle,
                index + needle.Length,
                StringComparison.Ordinal
            ) {
                count++
            }
            return count
        }

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
            TranslationTestValidation.AssertBinds(printed)
            return printed
        }
    }
}
