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
/// Without the emitted-type check, the by-ref rows do not bind; with it only on the capture's own input, the
/// composed by-ref row does not bind.
/// Without `IsNilableOnlyInEmittedGSharp`, the nullable-return and target rows emit `return c!!` or
/// `pair = (c!!, 0)` and throw.
/// The deconstruction row throws `NullReferenceException` when #5598's bridge also asserts a store into a
/// local with no recorded storage, or records an explicit `Node?` local as non-null.
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

    /// A capture has the type that the translation gives its input. `Volatile.Read(ref cache!)` drops the
    /// by-ref `!`, so G# infers its result from `Dictionary?` (issue #4287) and the receiver of a capture
    /// keeps its `!!` in each form, as the direct receiver does.
    @Fact
    func AVarCaptureOfADroppedByRefSuppression_KeepsItsAssertion() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public static class P
    {
        private static Dictionary<string, int>? cache = new Dictionary<string, int> { ["a"] = 1 };
        static int Arm() => Volatile.Read(ref cache!) switch { var c => c.Count };
        static int Case()
        {
            switch (Volatile.Read(ref cache!))
            {
                case var c: return c.Count;
            }
        }
        static int Is() => Volatile.Read(ref cache!) is var c ? c.Count : -1;
        static int Direct() => Volatile.Read(ref cache!).Count;
        public static string Run() => Arm() + " " + Case() + " " + Is() + " " + Direct();
    }
}`)
        Assert.Contains("case var c: c!!.Count", printed)
        Assert.Contains("return c!!.Count", printed)
        Assert.Contains("is var c { c!!.Count }", printed)
        RunsAs(printed, "1 1 1 1")
    }

    /// The emitted type of each operand decides a composed input: a conditional or a `??` of two
    /// `Volatile.Read(ref cache!)` calls is `Dictionary?` in G#, so the capture keeps its `!!`, and so does a
    /// `var` local initialized from one call (the same shared classification).
    @Fact
    func AVarCaptureOfAComposedDroppedByRefSuppression_KeepsItsAssertion() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public static class P
    {
        private static Dictionary<string, int>? cache = new Dictionary<string, int> { ["a"] = 1 };
        static int Arm(bool flag) => (flag ? Volatile.Read(ref cache!) : Volatile.Read(ref cache!)) switch { var c => c.Count };
        static int Case(bool flag)
        {
            switch (flag ? Volatile.Read(ref cache!) : Volatile.Read(ref cache!))
            {
                case var c: return c.Count;
            }
        }
        static int Is(bool flag) => (flag ? Volatile.Read(ref cache!) : Volatile.Read(ref cache!)) is var c ? c.Count : -1;
        static int Coalesce() => (Volatile.Read(ref cache!) ?? Volatile.Read(ref cache!)) switch { var c => c.Count };
        static int Local() { var d = Volatile.Read(ref cache!); return d.Count; }
        public static string Run() => Arm(true) + " " + Case(false) + " " + Is(true) + " " + Coalesce() + " " + Local();
    }
}`)
        Assert.Contains("case var c: c!!.Count", printed)
        Assert.Contains("return c!!.Count", printed)
        Assert.Contains("is var c { c!!.Count }", printed)
        Assert.Contains("return d!!.Count", printed)
        RunsAs(printed, "1 1 1 1 1")
    }

    /// A nil-accepting declared slot takes the nil as C# does: a capture, a direct call and a local of a
    /// dropped by-ref suppression returned from a method declared `Dictionary?` are not asserted, so a null
    /// `cache` returns null in each form, as C# does.
    @Fact
    func ADroppedByRefSuppressionIntoANullableReturn_ReturnsTheNull() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public static class P
    {
        private static Dictionary<string, int>? cache;
        static Dictionary<string, int>? IsReturn() { if (Volatile.Read(ref cache!) is var c) return c; return null; }
        static Dictionary<string, int>? ArmReturn() => Volatile.Read(ref cache!) switch { var c => c };
        static Dictionary<string, int>? DirectReturn() => Volatile.Read(ref cache!);
        static Dictionary<string, int>? LocalReturn() { var d = Volatile.Read(ref cache!); return d; }
        static Dictionary<string, int>? SwitchLocalReturn(bool flag)
        {
            var d = flag switch { true => Volatile.Read(ref cache!), _ => Volatile.Read(ref cache!) };
            return d;
        }
        public static string Run() =>
            (IsReturn() == null) + " " + (ArmReturn() == null) + " " + (DirectReturn() == null) + " " + (LocalReturn() == null) +
            " " + (SwitchLocalReturn(true) == null);
    }
}`)
        Assert.DoesNotContain("!!", printed)
        RunsAs(printed, "True True True True True")
    }

    /// A capture of a dropped by-ref suppression is `T?` only in G#, so it takes the target-aware bridge: a
    /// tuple element, a field and a local that accept nil store the null as C# does, and a non-null parameter
    /// is asserted in every form.
    @Fact
    func ADroppedByRefSuppressionCapture_IsBridgedByItsTarget() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public class Holder { public Dictionary<string, int>? Slot; }
    public static class P
    {
        private static Dictionary<string, int>? cache;
        private static Dictionary<string, int>? full = new Dictionary<string, int> { ["a"] = 1 };
        static int Take(Dictionary<string, int> d) => d.Count;
        static bool Tuple()
        {
            if (Volatile.Read(ref cache!) is var c) { (Dictionary<string, int>? d, int n) pair; pair = (c, 0); return pair.d == null; }
            return false;
        }
        static bool Field(Holder h) { if (Volatile.Read(ref cache!) is var c) { h.Slot = c; } return h.Slot == null; }
        static bool Local() { if (Volatile.Read(ref cache!) is var c) { Dictionary<string, int>? x; x = c; return x == null; } return false; }
        static int SinkIs() => Volatile.Read(ref full!) is var c ? Take(c) : -1;
        static int SinkArm() => Volatile.Read(ref full!) switch { var c => Take(c) };
        static int SinkCase() { switch (Volatile.Read(ref full!)) { case var c: return Take(c); } }
        static int SinkLocal() { var d = Volatile.Read(ref full!); return Take(d); }
        public static string Run() =>
            Tuple() + " " + Field(new Holder()) + " " + Local() + " " + SinkIs() + " " + SinkArm() + " " + SinkCase() + " " + SinkLocal();
    }
}`)
        Assert.Contains("pair = (c, 0)\n", printed)
        Assert.Contains("h.Slot = c\n", printed)
        Assert.Contains("x = c\n", printed)
        Assert.Contains("is var c { Take(c!!) }", printed)
        Assert.Contains("case var c: Take(c!!)", printed)
        Assert.Contains("return Take(d!!)", printed)
        RunsAs(printed, "True True True 1 1 1 1")
    }

    /// G# infers a generic result from the arguments that supply it. `Id(Volatile.Read(ref cache!))`,
    /// `First(Volatile.Read(ref cache!))` (`params T[]`), `Get(() => Volatile.Read(ref cache!))` (`Func<T>`)
    /// and `cache.Echo()` over a capture are `Dictionary?` in G#, so a capture of each keeps its `!!` in the
    /// switch-arm, `case` and `is` forms.
    @Fact
    func AVarCaptureOfAnInferredGenericResult_KeepsItsAssertion() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public static class Ext { public static T Echo<T>(this T value) => value; }
    public static class P
    {
        private static Dictionary<string, int>? cache = new Dictionary<string, int> { ["a"] = 1 };
        static T Id<T>(T x) => x;
        static T First<T>(params T[] xs) => xs[0];
        static T Get<T>(System.Func<T> f) => f();
        static int Arm() => Id(Volatile.Read(ref cache!)) switch { var c => c.Count };
        static int Case()
        {
            switch (Id(Volatile.Read(ref cache!)))
            {
                case var c: return c.Count;
            }
        }
        static int Is() => Id(Volatile.Read(ref cache!)) is var c ? c.Count : -1;
        static int Receiver() => Volatile.Read(ref cache!) is var c ? c.Echo() switch { var e => e.Count } : -1;
        static int ParamsArm() => First(Volatile.Read(ref cache!)) switch { var p => p.Count };
        static int ParamsCase()
        {
            switch (First(Volatile.Read(ref cache!)))
            {
                case var q: return q.Count;
            }
        }
        static int CallbackArm() => Get(() => Volatile.Read(ref cache!)) switch { var f => f.Count };
        static int CallbackCase()
        {
            switch (Get(() => Volatile.Read(ref cache!)))
            {
                case var g: return g.Count;
            }
        }
        public static string Run() =>
            Arm() + " " + Case() + " " + Is() + " " + Receiver() + " " + ParamsArm() + " " + ParamsCase() + " " +
            CallbackArm() + " " + CallbackCase();
    }
}`)
        Assert.Contains("case var c: c!!.Count", printed)
        Assert.Contains("return c!!.Count", printed)
        Assert.Contains("is var c { c!!.Count }", printed)
        Assert.Contains("case var e: e!!.Count", printed)
        Assert.Contains("case var p: p!!.Count", printed)
        Assert.Contains("return q!!.Count", printed)
        Assert.Contains("case var f: f!!.Count", printed)
        Assert.Contains("return g!!.Count", printed)
        RunsAs(printed, "1 1 1 1 1 1 1 1")
    }

    /// With #5601's slot query: a capture of an `[AllowNull]` field typed by an unconstrained `T` has the
    /// emitted type `Node` (the slot stays `Value T`), so it goes into a non-null parameter without `!!`. With
    /// `where T : class` the slot is `T?`, and the capture keeps its bridge.
    @Fact
    func AVarCaptureOfAnAllowNullTypeParameterSlot_FollowsTheEmittedSlot() {
        let printed = Translate(`
#nullable enable
using System.Diagnostics.CodeAnalysis;
namespace Demo
{
    public class Node { public string Name => "node"; }
    public class Box<T>
    {
        public Box(T value) { Value = value; }
        [AllowNull] public T Value;
    }
    public class RefBox<T> where T : class
    {
        public RefBox(T value) { Value = value; }
        [AllowNull] public T Value;
    }
    public static class P
    {
        static string Take(Node n) => n.Name;
        static string Is(Box<Node> b) => b.Value is var c ? Take(c) : "none";
        static string Arm(Box<Node> b) => b switch { { Value: var c } => Take(c), _ => "none" };
        static string RefIs(RefBox<Node> b) => b.Value is var c ? Take(c) : "none";
        static string RefArm(RefBox<Node> b) => b switch { { Value: var c } => Take(c), _ => "none" };
        public static string Run() =>
            Is(new Box<Node>(new Node())) + " " + Arm(new Box<Node>(new Node())) + " " +
            RefIs(new RefBox<Node>(new Node())) + " " + RefArm(new RefBox<Node>(new Node()));
    }
}`)
        Assert.Contains("var Value T\n", printed)
        Assert.Contains("var Value T?", printed)
        Assert.Contains("func Is(b Box[Node]) string -> if b.Value is var c { Take(c) }", printed)
        Assert.Contains("case { Value: var c }: Take(c)\n", printed)
        Assert.Contains("func RefIs(b RefBox[Node]) string -> if b.Value is var c { Take(c!!) }", printed)
        Assert.Contains("case { Value: var c }: Take(c!!)", printed)
        RunsAs(printed, "node node node node")
    }

    /// With #5598's store bridge: a deconstruction stores a widened element into a `var` capture or into a
    /// local initialized from one. A capture has no recorded storage, so its store is not bridged (#5605).
    /// The taint widens a local that receives the element, so its store is not bridged either. Each form
    /// stores the null, as C# does, also when the capture's input is non-null.
    @Fact
    func ADeconstructionIntoACaptureOrItsLocal_StoresTheNull() {
        let printed = Translate(`
namespace Demo
{
    public class Node { }
    public record Entry(Node Item, int Id);
    public static class P
    {
        static Entry Empty() => new Entry(null, 0);
        static string IsLocal(Node q)
        {
            if (q is var c) { var x = c; int i; (x, i) = Empty(); object o = x; return (o == null) + ":" + i; }
            return "none";
        }
        static string CaseLocal(Node q)
        {
            switch (q)
            {
                case var c: var x = c; int i; (x, i) = Empty(); object o = x; return (o == null) + ":" + i;
            }
        }
        static string NewInputCaseLocal()
        {
            switch (new Node())
            {
                case var c: var x = c; int i; (x, i) = Empty(); object o = x; return (o == null) + ":" + i;
            }
        }
        static string MemberLocal(Entry e)
        {
            switch (e)
            {
                case { Item: var c }: var x = c; int i; (x, i) = Empty(); object o = x; return (o == null) + ":" + i;
                default: return "none";
            }
        }
        static string IsCapture(Node q)
        {
            if (q is var c) { int i; (c, i) = Empty(); object o = c; return (o == null) + ":" + i; }
            return "none";
        }
        static string CaseCapture(Node q)
        {
            switch (q)
            {
                case var c: int i; (c, i) = Empty(); object o = c; return (o == null) + ":" + i;
            }
        }
        public static string Run()
        {
            var n = new Node();
            return IsLocal(n) + " " + CaseLocal(n) + " " + NewInputCaseLocal() + " " + MemberLocal(new Entry(n, 1)) + " " +
                IsCapture(n) + " " + CaseCapture(n);
        }
    }
}`)
        Assert.DoesNotContain("Value!!", printed)
        RunsAs(printed, "True:0 True:0 True:0 True:0 True:0 True:0")
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
