// <copyright file="Issue5626ConstantPatternNarrowingTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Collections.Generic
import System.IO
import System.Runtime.Loader
import Xunit

/// Issue #5626: gsc narrows a nullable local by the native form of a constant pattern (`x is "a"`), but not by
/// the equality (`x == "a"`) that cs2gs lowered it to, while the translator still read the local as narrowed. The
/// translated read failed with GS0158. Now one decision gives the form of a boolean `is` test and the narrowing
/// that the translator assumes for it: a test of a `string?` keeps its native form where only that form narrows.
/// The same model of gsc's native narrowing decides the case of a switch section and a switch arm. Each row runs
/// the C# and its translation and compares the output.
/// @remarks Mutation witnesses (ADR-0154): on 1da01cc5d (before this fix) the `is` and combination rows do not
/// compile (GS0158) and the switch rows contain `!!`. With the native form refused
/// (`RequiresNativePatternNarrowing` false), the `is` and combination rows keep the lowered form. With the
/// narrowing of the lowered form for every test, they contain `!!`. With a native model that flips a nested
/// `not`, the `is not "a" and not "bb"` row and the `case not null` row do not compile (GS0158). Without the
/// parentheses in `GSharpPrinter`, the `&&` row does not compile. With `IsGSharpSwitchNarrowedLocal` false, the
/// switch rows contain `!!`. Without its closure check, the closure row does not compile (GS0158). With the native
/// form for a nullable value, the `HasValue` row does not compile (GS0129). With `.Value` of a narrowed local
/// unasserted, the `&&` row of `DateTime?` does not compile (GS0158). With `left ?? right` for `and`, the merge row
/// does not compile (GS0159). Without the type-test rule, the `object` and `Base` arm rows do not compile (GS0158).
/// With a `s!!` subject counted as the switched local, the suppressed row does not compile (GS0158). With the native
/// form for any reference input, the interface row does not compile (GS0171). With a simple-name constant in the
/// native form, the shadowed-constant row tests the type `Key` and does not compile (GS0158). On c90d28792, which
/// narrowed stacked type labels by each label alone, the `case Circle: case Square:` row does not compile (GS0154).
/// With a member-access constant in the native form, the `Inner.Code` row does not compile (GS0158). With the
/// right side winning over a nil guard in a lowered `&&`, the mixed `or` row does not compile (GS0159). With the C#
/// sealedness of a translated class, the `IMarker` arm row does not compile (GS0158). With the right operand of a
/// lowered `&&` bound against the input type, the `Bound` row does not compile (GS0159). With `IsTypeEmittedOpen`
/// for a gsgen semantic-only abstract stub, the stub row emits a bare `current.Visit()`. On 0cc904eb5 the `goto case`,
/// `not (Base and Derived)`, nested-`||` and `IBox<string?>` rows of the last control do not compile; with the goto
/// rule, the namesake rule, the dropped `&&` false path, the `||` operand input or nested nullability removed, one of
/// them fails (GS0158 or GS0159).
open class Issue5626ConstantPatternNarrowingTests {
    /// The issue's repro and each boolean `is` shape: the test keeps the native form, and gsc narrows the read.
    @Fact
    func AStringConstantPattern_KeepsTheNativeFormInEveryBooleanPosition() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int Is(string? seed) { string? current = seed; if (current is "a") { return current.Length; } return 0; }
        static int Parameter(string? current) { if (current is "a") { return current.Length; } return 0; }
        static int EarlyExit(string? current) { if (current is not "a") { return 0; } return current.Length; }
        static int Negated(string? current) { if (!(current is "a")) { return 0; } return current.Length; }
        static int Conditional(string? current) => current is "a" ? current.Length : 0;
        static int AndAlso(string? current) { if (current is "a" && current.Length > 0) { return current.Length; } return 0; }
        static int Loop(string? current) { int n = 0; while (current is "a") { n += current.Length; current = null; } return n; }
        public static string Run() =>
            Is("a") + " " + Is("b") + " " + Is(null) + " " + Parameter("a") + " " + EarlyExit("a") + " " + EarlyExit(null) + " " +
            Negated("a") + " " + Conditional("a") + " " + AndAlso("a") + " " + Loop("a");
    }
}`)
        Assert.Contains("if current is \"a\" {\n            return current.Length\n", printed)
        Assert.Contains(
            "if current is not \"a\" {\n            return 0\n        }\n        return current.Length\n",
            printed
        )
        Assert.Contains("if (current is \"a\") && current.Length > 0 {", printed)
        Assert.DoesNotContain("!!", printed)
    }

    /// `and` and `or` combinations: a combination that only the native form narrows keeps it. A combination whose
    /// lowered form narrows by its `!= nil` test is unchanged. gsc does not narrow `is not "a" and not "bb"` where it
    /// fails, so that read keeps its assertion.
    @Fact
    func ACombinedConstantPattern_KeepsTheFormThatNarrows() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int Or(string? current) { if (current is "a" or "bb") { return current.Length; } return 0; }
        static int AndNot(string? current) { if (current is "a" and not "b") { return current.Length; } return 0; }
        static int NotNullAndNot(string? current) { if (current is not null and not "a") { return current.Length; } return 0; }
        static int NotAndNot(string? current) { if (current is not "a" and not "bb") { return 0; } return current.Length; }
        public static string Run() =>
            Or("bb") + " " + Or(null) + " " + AndNot("a") + " " + NotNullAndNot("ccc") + " " + NotNullAndNot(null) + " " +
            NotAndNot("bb") + " " + NotAndNot(null);
    }
}`)
        Assert.Contains("if (current is \"a\" or \"bb\") {\n            return current.Length\n", printed)
        Assert.Contains("if (current is \"a\" and not \"b\") {\n            return current.Length\n", printed)
        Assert.Contains("if current != nil && current != \"a\" {\n            return current.Length\n", printed)
        Assert.Contains(
            "if current != \"a\" && current != \"bb\" {\n            return 0\n        }\n        return current!!.Length\n",
            printed
        )
    }

    /// A switch section and a switch arm narrow the switched local in gsc, so their reads need no assertion. gsc
    /// does not narrow a `default` section after `case null` or a `case not null` section, so those keep it.
    @Fact
    func ASwitchConstantCase_NarrowsTheSwitchedLocal() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
namespace Demo
{
    public static class P
    {
        static int Case(string? current) { switch (current) { case "a": return current.Length; default: return 0; } }
        static int Stacked(string? current) { switch (current) { case "a": case "bb": return current.Length; default: return 0; } }
        static int When(string? current) { switch (current) { case "a" when current.Length > 0: return current.Length; default: return 0; } }
        static int Arm(string? current) => current switch { "a" => current.Length, _ => 0 };
        static int ArmOr(string? current) => current switch { "a" or "bb" => current.Length, _ => 0 };
        static int CaseNull(string? current) { switch (current) { case null: return 0; default: return current.Length; } }
        static int CaseNotNull(string? current) { switch (current) { case not null: return current.Length; default: return 0; } }
        public static string Run() =>
            Case("a") + " " + Case(null) + " " + Stacked("bb") + " " + When("a") + " " + Arm("a") + " " + ArmOr("bb") + " " +
            ArmOr(null) + " " + CaseNull("ccc") + " " + CaseNull(null) + " " + CaseNotNull("dd");
    }
}`)
        Assert.Contains("case \"a\" {\n                return current.Length\n", printed)
        Assert.Contains("case \"a\", \"bb\" {\n                return current.Length\n", printed)
        Assert.Contains("case \"a\" when current.Length > 0 {\n                return current.Length\n", printed)
        Assert.Contains("case \"a\": current.Length\n", printed)
        Assert.Contains("case \"a\" or \"bb\": current.Length\n", printed)
        Assert.Contains("default {\n                return current!!.Length\n", printed)
        Assert.Contains("case not nil {\n                return current!!.Length\n", printed)
    }

    /// Control: a constant pattern on a nullable value (`int32?`, `char?`, `decimal?`, `Color?`) keeps its lowered
    /// form. The native form would narrow the local to the underlying type, so `HasValue` (`!= nil`) would not bind
    /// and `Pick(current)` would call `Pick(int32)` where C# calls `Pick(int?)`. A `.Value` read keeps its
    /// assertion, also in the right operand of `&&`, where gsc does not narrow a nullable value.
    @Fact
    func ANullableValueConstantPattern_KeepsTheLoweredForm() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public enum Color { Red, Green }
    public static class P
    {
        static string Pick(int? value) => "nullable";
        static string Pick(int value) => "plain";
        static int Int(int? current) { if (current is 1) { return current.Value + 1; } return 0; }
        static int Char(char? current) { if (current is 'q') { return current.Value; } return 0; }
        static int Decimal(decimal? current) { if (current is 2.5m) { return (int)(current.Value * 2); } return 0; }
        static int NotEnum(Color? current) { if (current is not Color.Green) { return 0; } return (int)current.Value; }
        static int HasValue(int? current) { if (current is 1) { return current.HasValue ? 1 : 0; } return 0; }
        static string Overload(int? current) { if (current is 1) { return Pick(current); } return "none"; }
        static int AndAlso(DateTime? current) { if (current != null && current.Value.Day > 0) { return 1; } return 0; }
        static int CaseInt(int? current) { switch (current) { case 1: return current.Value + 1; default: return 0; } }
        static int ArmEnum(Color? current) => current switch { Color.Green => (int)current.Value + 5, _ => 0 };
        public static string Run() =>
            Int(1) + " " + Int(null) + " " + Char('q') + " " + Decimal(2.5m) + " " + NotEnum(Color.Green) + " " +
            NotEnum(null) + " " + HasValue(1) + " " + Overload(1) + " " + AndAlso(new DateTime(2020, 1, 2)) + " " +
            CaseInt(1) + " " + ArmEnum(Color.Green) + " " + ArmEnum(null);
    }
}`)
        Assert.Contains("if current == 1 {\n            return current!! + 1\n", printed)
        Assert.Contains(
            "if current != Color.Green {\n            return 0\n        }\n        return int32(current!!)\n",
            printed
        )
        Assert.Contains("if current != nil && current!!.Day > 0 {", printed)
    }

    /// Control: gsc narrows an `and` pattern to the type of its right side, and a type test of a proper supertype
    /// (`object` for a `string?`) or of a class that does not implement the input interface does not narrow. Stacked
    /// type labels (`case Circle: case Square:`) become one arm, which gsc does not narrow to either type. An interface
    /// arm on a class that cs2gs emits sealed does not narrow, and a lowered `&&` keeps a type test over a nil guard. gsc
    /// does not narrow the local of a `s!!` subject either. Such a switch arm or section keeps the assertion on the
    /// read.
    @Fact
    func ASwitchArmThatGscDoesNotNarrow_KeepsTheAssertion() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public interface IValue { int Value { get; } }
    public class Base { }
    public class Derived : Base, IValue { public int Value => 7; }
    public interface IMarker { }
    internal class Plain { public int Value => 1; }
    public abstract class Shape { }
    public sealed class Circle : Shape { }
    public sealed class Square : Shape { }
    public static class P
    {
        static int Sealed(Plain? current) => current switch { IMarker => current.Value, _ => 0 };
        static string Bound(object? current) { if (current is ((string and IComparable) or IComparable) and not string) { return current.ToString()!; } return "none"; }
        static string Mixed(object? current) { if (current is ((string and not null) or object) and not string) { return current.ToString()!; } return "none"; }
        static string Describe(Shape shape) => shape.GetType().Name;
        static string Stacked(Shape? current) { switch (current) { case Circle: case Square: return Describe(current); default: return "none"; } }
        static string Single(Shape? current) { switch (current) { case Circle: return Describe(current); default: return "none"; } }
        static string Merge(object? current) => current switch { (1 and int) or 2 => current.ToString()!, _ => "none" };
        static int Supertype(string? current) => current switch { object => current.Length, _ => 0 };
        static int Unrelated(IValue? current) => current switch { Base => current.Value, _ => 0 };
        static bool TryGet(string? value, [NotNullWhen(true)] out string? result) { result = value; return value != null; }
        static int Suppressed(string? input)
        {
            if (TryGet(input, out var current) && current.Length > 0)
            {
                switch (current!) { case "a": return current.Length; default: return 0; }
            }
            return 0;
        }
        public static string Run() =>
            Merge(1) + " " + Merge(2) + " " + Merge(null) + " " + Supertype("ab") + " " + Supertype(null) + " " +
            Unrelated(new Derived()) + " " + Unrelated(null) + " " + Suppressed("a") + " " + Stacked(new Square()) + " " +
            Stacked(null) + " " + Single(new Circle()) + " " + Sealed(new Plain()) + " " + Mixed(3) + " " + Mixed("s") + " " + Bound(3) + " " + Bound("s");
    }
}`)
        Assert.Contains("current!!.ToString()", printed)
        Assert.Contains("case _ is object: current!!.Length", printed)
        Assert.Contains("case _ is Base: current!!.Value", printed)
        Assert.Contains("case Circle, Square {\n                return Describe(current!!)\n", printed)
        Assert.Contains("case Circle {\n                return Describe(current)\n", printed)
        Assert.Contains(
            "switch current!! {\n                case \"a\" {\n                    return current!!.Length\n",
            printed
        )
        Assert.Contains("case _ is IMarker: current!!.Value", printed)
        Assert.Contains("return current!!.ToString()", printed)
        Assert.Equal(2, printed.Split("return current!!.ToString()").Length - 1)
    }

    /// Control: gsc cannot bind every constant pattern natively. A string constant on an interface input and a named
    /// constant (gsc reads a name in a boolean `is` as a type first: the type `Key`, the inherited type `Inner.Code`)
    /// keep the lowered test, and the read keeps its assertion.
    @Fact
    func AConstantPatternThatGscCannotBindNatively_KeepsTheLoweredForm() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public class Key { }
    public class Outer { public class Code { } }
    public class Inner : Outer { public new const string Code = "a"; }
    public static class P
    {
        static bool Interface(IComparable? current) => current is "a";
        static int Qualified(string? current) { if (current is not Inner.Code) { return 0; } return current.Length; }
        static int Shadowed(string? current)
        {
            const string Key = "a";
            if (current is not Key) { return 0; }
            return current.Length;
        }
        public static string Run() =>
            Interface("a") + " " + Interface(null) + " " + Shadowed("a") + " " + Shadowed("b") + " " + Qualified("a") + " " +
            Qualified("b");
    }
}`)
        Assert.DoesNotContain("current is \"a\"\n", printed)
        Assert.Contains(
            "if current != Key {\n            return 0\n        }\n        return current!!.Length\n",
            printed
        )
        Assert.Contains(
            "if current != Inner.Code {\n            return 0\n        }\n        return current!!.Length\n",
            printed
        )
    }

    /// Control: gsc does not narrow a section that a `goto case` enters, discards the narrowing of a local when a
    /// closure assigns another local of the same name, keeps no narrowing where a lowered `&&` fails, binds the right
    /// operand of `||` where its left operand fails, and keeps nested nullability when it intersects alternatives.
    /// Each read keeps its assertion.
    @Fact
    func AShapeThatGscDoesNotNarrow_KeepsTheAssertion() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public class Base { }
    public class Derived : Base { }
    public interface IBox<T> { }
    public class First { }
    public class Second { }
    public class StringBox : IBox<string> { }
    public static class P
    {
        static void Touch() { }
        static int Jump(string? current, bool jump)
        {
            switch (current) { case not null when jump: goto case "a"; case "b": return 0; case "a": return current.Length; default: return 0; }
        }
        static int Namesake(bool flag)
        {
            if (flag) { string? current = "zz"; Action clear = () => current = null; clear(); }
            {
                string? current = "b";
                if (flag) { current = "a"; }
                switch (current) { case "a": Touch(); return current.Length; }
            }
            return 0;
        }
        static string NotBoth(object? current) { if (current is not (Base and Derived) and not Derived) { return ""; } return current.ToString()!; }
        static string Either(object? current)
        {
            if (current is ((not (not string or not IComparable)) or IComparable) and not string) { return current.ToString()!; }
            return "none";
        }
        static string Boxes(object? current) => current switch { (IBox<string> and not First) or (IBox<string?> and not Second) => current.ToString()!, _ => "none" };
        public static string Run() =>
            Jump("xyz", true) + " " + Jump("a", false) + " " + Namesake(true) + " " + NotBoth(new Derived()) + " " + NotBoth(null) + " " +
            Either(4) + " " + Either("s") + " " + Boxes(new StringBox()) + " " + Boxes(null);
    }
}`)
        Assert.Contains("return current!!.Length", printed)
        Assert.Contains("return current!!.ToString()", printed)
        Assert.Contains(": current!!.ToString()", printed)
    }

    /// Control: gsgen renders a stub `abstract` only because it inherits unimplemented members (#5252), and the
    /// printed G# class is sealed. An interface arm does not narrow such an input, so the read keeps its assertion.
    @Fact
    func AnInterfaceArmOnASemanticOnlyAbstractStub_KeepsTheAssertion() {
        let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", `
#nullable enable
namespace Demo
{
    public interface IMarker { }
    public abstract partial class Visitor { public abstract int Visit(); }
    public static class P
    {
        static int Arm(Visitor? current) => current switch { IMarker => current.Visit(), _ => 0 };
    }
}`)})
        Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
        let document = Assert.Single(project.Documents)
        let visitor = project.Compilation.GetTypeByMetadataName("Demo.Visitor")!!
        let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
        let translator = CSharpToGSharpTranslator(){
            SemanticOnlyAbstractTypes = Dictionary[string, bool]{[SemanticAbstractTypeKey.Of(visitor)] = false}
        }
        let printed = GSharpPrinter.Print(translator.TranslateDocument(document, context))
        Assert.Contains("case _ is IMarker: current!!.Visit()", printed)
    }

    /// Control: a closure can clear a local when a call runs between the case and the read, and gsc does not narrow
    /// the local there (ADR-0208 R15). The switch row keeps its assertion. `null` and `not null` tests keep their
    /// lowered form.
    @Fact
    func AClosureAssignedLocalAndNullTests_KeepTheirForm() {
        let printed = AssertRunsLikeCSharp(`
#nullable enable
using System;
namespace Demo
{
    public static class P
    {
        static int Closure(string? current)
        {
            Action keep = () => current = "a";
            switch (current) { case "a": keep(); return current.Length; }
            return 0;
        }
        static int Null(string? current) { if (current is null) { return 0; } return current.Length; }
        static int NotNull(string? current) { if (current is not null) { return current.Length; } return 0; }
        public static string Run() => Closure("a") + " " + Null("dd") + " " + Null(null) + " " + NotNull("eee");
    }
}`)
        Assert.Contains("keep()\n                return current!!.Length\n", printed)
        Assert.Contains(
            "if current == nil {\n            return 0\n        }\n        return current.Length\n",
            printed
        )
        Assert.Contains("if current != nil {\n            return current.Length\n", printed)
    }

    shared {
        // Runs `P.Run()` of the C# and of its translation, compares the output, and returns the translation.
        private func AssertRunsLikeCSharp(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            using let peStream = MemoryStream()
            let emitted = project.Compilation.Emit(peStream)
            Assert.True(emitted.Success, string.Join(Environment.NewLine, emitted.Diagnostics))
            let loadContext = AssemblyLoadContext("Issue5626", isCollectible: true)
            var expected string
            try {
                peStream.Position = 0
                expected = cast[string](
                    loadContext.LoadFromStream(peStream).GetType("Demo.P", throwOnError: true)!!.GetMethod(
                        "Run"
                    )!!.Invoke(nil, nil)
                )
            } finally {
                loadContext.Unload()
            }
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            LocalFunctionHoistTranslationTests.CompileAndRun(printed, "System.Console.WriteLine(P.Run())", expected)
            return printed
        }
    }
}
