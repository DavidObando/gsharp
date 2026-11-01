// <copyright file="Issue5582VarCaptureBridgeTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #5582: a `var` pattern capture has the G# type of the value that the pattern matches. C# types
/// the capture `T?`, so a switch arm (`var c =>`) and a `case var c:` label bridged `Take(c!!)` and threw
/// where C# passes the null on, while `x is var c` passed `c` unbridged. Now one decision covers each form,
/// each property subpattern and each conjunction: the capture is non-null exactly when its input is non-null
/// in the emitted G#. A capture of a nullable or widened input keeps its bridge, also in the `is var` form.
/// @remarks Mutation witnesses (ADR-0154): on 24bb628bb (before this fix) and with
/// `TryGetVarCaptureStaticNonNull` always `false`, the switch-arm and case-label rows emit `c!!` and the
/// translated program throws `NullReferenceException`. On 24bb628bb, and with the decision limited to
/// native `is` bindings, to the scrutinee, or to a capture outside a conjunction, a control row emits
/// `Take(m)` or `Take(c)` with a `Node?` capture, which does not bind (GS0154). Without the type-test rule
/// for a conjunction, `o is Node and var c` emits a redundant `c!!`.
open class Issue5582VarCaptureBridgeTests {
    /// The issue's repro: a `var` capture of a non-null parameter, in the `is`, switch-arm and case-label
    /// forms, takes the null on as C# does.
    @Fact
    func AVarCaptureOfANonNullInput_PassesTheNullOnInEveryForm() {
        let printed = Translate(`
#nullable enable
namespace Demo
{
    public class Node { }
    public class Sink { public virtual string Take(Node n) => "taken"; }
    public static class P
    {
        public static string Is(Node p) => p is var captured ? new Sink().Take(captured) : "none";
        public static string Arm(Node q) => q switch { var c => new Sink().Take(c) };
        public static string Case(Node r)
        {
            switch (r)
            {
                case var c: return new Sink().Take(c);
            }
        }
        public static string And(Node s) => s is (var c and _) ? new Sink().Take(c) : "none";
        public static string Typed(object? o) => o is Node and var c ? new Sink().Take(c) : "none";
        public static string Run() =>
            Is(null!) + " " + Arm(null!) + " " + Case(null!) + " " + And(null!) + " " + Typed(new Node());
    }
}`)
        Assert.Contains("case var c: Sink().Take(c)\n", printed)
        Assert.Contains("return Sink().Take(c)\n", printed)
        Assert.DoesNotContain("!!", printed)
        RunsAs(printed, "taken taken taken taken taken")
    }

    /// A `var` capture in a property subpattern, at the top level and nested, has the type of the member
    /// that it reads. A member that stays non-null passes the null on in each form.
    @Fact
    func AVarCaptureOfANonNullMember_PassesTheNullOnInEveryForm() {
        let printed = Translate(`
#nullable enable
namespace Demo
{
    public class Node { }
    public class Holder
    {
        public Holder(Node child, Holder? inner) { Child = child; Inner = inner; }
        public Node Child { get; }
        public Holder? Inner { get; }
    }
    public class Sink { public virtual string Take(Node n) => "taken"; }
    public static class P
    {
        public static string Is(Holder h) => h is { Child: var c } ? new Sink().Take(c) : "none";
        public static string Arm(Holder h) => h switch { { Child: var c } => new Sink().Take(c), _ => "none" };
        public static string Case(Holder h)
        {
            switch (h)
            {
                case { Child: var c }: return new Sink().Take(c);
                default: return "none";
            }
        }
        public static string NestedIs(Holder h) => h is { Inner: { Child: var c } } ? new Sink().Take(c) : "none";
        public static string NestedArm(Holder h) => h switch { { Inner: { Child: var c } } => new Sink().Take(c), _ => "none" };
        public static string TypedArm(Holder h) => h switch { Holder { Child: var c } => new Sink().Take(c) };
        static Holder Make() => new Holder(null!, new Holder(null!, null));
        public static string Run() =>
            Is(Make()) + " " + Arm(Make()) + " " + Case(Make()) + " " + NestedIs(Make()) + " " + NestedArm(Make()) + " " +
            TypedArm(Make());
    }
}`)
        Assert.Contains("prop Child Node {", printed)
        Assert.Contains("case { Inner: { Child: var c } }: Sink().Take(c)\n", printed)
        Assert.DoesNotContain("!!", printed)
        RunsAs(printed, "taken taken taken taken taken taken")
    }

    /// Control: a capture of a `Node?` parameter or member has the type `Node?`, so each form keeps the
    /// bridge into the non-null parameter. The `is var` form bridged nothing before this fix.
    @Fact
    func AVarCaptureOfANullableInput_KeepsTheBridgeInEveryForm() {
        let printed = Translate(`
#nullable enable
namespace Demo
{
    public class Node { }
    public class Holder { public Node? Maybe { get; set; } }
    public class Sink { public virtual string Take(Node n) => "taken"; }
    public static class P
    {
        public static string Is(Node? p) => p is var captured ? new Sink().Take(captured!) : "none";
        public static string Arm(Node? q) => q switch { var c => new Sink().Take(c!) };
        public static string Case(Node? r)
        {
            switch (r)
            {
                case var c: return new Sink().Take(c!);
            }
        }
        public static string MemberIs(Holder h) => h is { Maybe: var m } ? new Sink().Take(m!) : "none";
        public static string MemberArm(Holder h) => h switch { { Maybe: var m } => new Sink().Take(m!) };
        public static string TypedArm(Holder h) => h switch { Holder { Maybe: var m } => new Sink().Take(m!) };
        public static string And(Node? s) => s is (var c and _) ? new Sink().Take(c!) : "none";
        public static string NotNullArm(Node? t) => t switch { not null and var c => new Sink().Take(c), _ => "none" };
        public static string Run() =>
            Is(new Node()) + " " + Arm(new Node()) + " " + Case(new Node()) + " " +
            MemberIs(new Holder { Maybe = new Node() }) + " " + MemberArm(new Holder { Maybe = new Node() }) + " " +
            TypedArm(new Holder { Maybe = new Node() }) + " " + And(new Node()) + " " + NotNullArm(new Node());
    }
}`)
        Assert.Contains("if p is var captured { Sink().Take(captured!!) }", printed)
        Assert.Contains("case var c: Sink().Take(c!!)", printed)
        Assert.Contains("return Sink().Take(c!!)", printed)
        Assert.Contains("if h is { Maybe: var m } { Sink().Take(m!!) }", printed)
        Assert.Contains("case { Maybe: var m }: Sink().Take(m!!)", printed)
        Assert.Contains("case Holder { Maybe: var m }: Sink().Take(m!!)", printed)
        Assert.Contains("if s is (var c and _) { Sink().Take(c!!) }", printed)
        Assert.Contains("case not nil and var c: Sink().Take(c!!)", printed)
        RunsAs(printed, "taken taken taken taken taken taken taken taken")
    }

    /// Control: in a nullable-oblivious file, cs2gs widens a parameter that a null test and a null store
    /// make maybe-null. The capture of the widened `Node?` input keeps its bridge into `List[Node].Add`.
    @Fact
    func AVarCaptureOfAWidenedInput_KeepsTheBridgeInEveryForm() {
        let printed = Translate(`
using System.Collections.Generic;
namespace Demo
{
    public class Node { }
    public static class P
    {
        static Node Field;
        static readonly List<Node> Items = new List<Node>();
        public static int Is(Node p) { if (p == null) { Field = p; } if (p is var captured) { Items.Add(captured); } return Items.Count; }
        public static int Arm(Node q) { if (q == null) { Field = q; } return q switch { var c => Items.IndexOf(c) + 2 }; }
        public static int Case(Node r)
        {
            if (r == null) { Field = r; }
            switch (r)
            {
                case var c: Items.Add(c); return Items.Count;
            }
        }
        public static int Run() => Is(new Node()) + Arm(new Node()) + Case(new Node());
    }
}`)
        Assert.Contains("func Is(p Node?) int32", printed)
        Assert.Contains("Items.Add(captured!!)", printed)
        Assert.Contains("case var c: Items.IndexOf(c!!) + 2", printed)
        Assert.Contains("Items.Add(c!!)", printed)
        RunsAs(printed, "4")
    }

    shared {
        private func Translate(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Snippet.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "Snippet should bind with no C# errors: " + string.Join(Environment.NewLine, project.ErrorDiagnostics)
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            TranslationTestValidation.AssertBinds(printed)
            return printed
        }

        // Compiles `printed` with gsc, runs `P.Run()` and compares what it prints.
        private func RunsAs(printed string, expected string) -> LocalFunctionHoistTranslationTests.CompileAndRun(
            printed,
            "System.Console.WriteLine(P.Run())",
            expected
        )
    }
}
