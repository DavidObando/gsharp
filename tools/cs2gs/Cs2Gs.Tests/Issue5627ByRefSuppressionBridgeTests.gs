// <copyright file="Issue5627ByRefSuppressionBridgeTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #5627: `Volatile.Read(ref cache!)` drops the by-ref `!`, so G# infers the result from the declared
/// `Dictionary?` storage and the result is `T?` although C# types it non-null (issue #4287). Only a
/// member-access receiver re-stated the suppression as `!!`. An argument (GS0154), a return (GS0155), an
/// assignment or initializer and a receiver composed by a conditional, a switch expression or `??` (GS0582)
/// did not bind. Each of these bridges now asks the one query `YieldsValueNilableBeyondItsCSharpType`, so `!!`
/// is added where the emitted value is `T?` and the C# slot is non-null, and only there.
/// @remarks Mutation witnesses (ADR-0154): on 459ab4012 (before this fix) and with
/// `YieldsValueNilableBeyondItsCSharpType` always `false`, the argument, return, assignment, composed and null
/// rows do not bind. Without its walk into the operands of a conditional, a switch expression or `??`, the
/// composed receivers and the `??` return do not bind. Without the target check, the control row asserts and
/// throws `NullReferenceException`. Without the check for an inferred generic parameter, the control row
/// asserts `Id(…)`. Without the check for a `var` local that such a value initializes, its reassignment
/// throws. Without the check for storage that a tuple element initializes, the tuple control rows throw.
/// Without the check for an inferred lambda result, the lambda control row throws. Without the check
/// for an arm with no sink of its own, a composed receiver asserts an arm instead of its whole value.
open class Issue5627ByRefSuppressionBridgeTests {
    /// The issue's repro: an argument, a return and a conditional receiver of a dropped by-ref suppression.
    @Fact
    func TheIssuePositions_AssertTheResult() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public static class P
    {
        private static Dictionary<string, int>? cache = new Dictionary<string, int> { ["a"] = 1 };
        static int Take(Dictionary<string, int> d) => d.Count;
        static int Arg() => Take(Volatile.Read(ref cache!));
        static Dictionary<string, int> Ret() => Volatile.Read(ref cache!);
        static int Mixed(bool flag) => (flag ? Volatile.Read(ref cache!) : new Dictionary<string, int>()).Count;
        public static string Run() => Arg() + " " + Ret().Count + " " + Mixed(true) + " " + Mixed(false);
    }
}`)
        Assert.Contains("func Arg() int32 -> Take(Volatile.Read(&cache)!!)", printed)
        Assert.Contains("func Ret() Dictionary[string, int32] -> Volatile.Read(&cache)!!", printed)
        Assert.Contains("(if flag { Volatile.Read(&cache) } else { Dictionary[string, int32]() })!!.Count", printed)
        RunsAs(printed, "1 1 1 0")
    }

    /// A `??` right operand or a switch-expression arm, as a receiver, an argument or a return.
    @Fact
    func ACoalesceOrSwitchArm_AssertsTheOperand() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public static class P
    {
        private static Dictionary<string, int>? cache = new Dictionary<string, int> { ["a"] = 1 };
        static int Take(Dictionary<string, int> d) => d.Count;
        static int Coalesce(Dictionary<string, int>? other) => (other ?? Volatile.Read(ref cache!)).Count;
        static int Arm(int k) => (k switch { 0 => new Dictionary<string, int>(), _ => Volatile.Read(ref cache!) }).Count;
        static int ArgConditional(bool flag) => Take(flag ? Volatile.Read(ref cache!) : new Dictionary<string, int>());
        static int ArgArm(int k) => Take(k switch { 0 => new Dictionary<string, int>(), _ => Volatile.Read(ref cache!) });
        static Dictionary<string, int> ReturnCoalesce(Dictionary<string, int>? other) => other ?? Volatile.Read(ref cache!);
        public static string Run() =>
            Coalesce(null) + " " + Arm(1) + " " + Arm(0) + " " + ArgConditional(true) + " " + ArgArm(1) + " " + ReturnCoalesce(null).Count;
    }
}`)
        Assert.Contains("(other ?? Volatile.Read(&cache))!!.Count", printed)
        Assert.Contains("default: Volatile.Read(&cache)\n    })!!.Count", printed)
        Assert.Contains("Take(if flag { Volatile.Read(&cache)!! } else { Dictionary[string, int32]() })", printed)
        Assert.Contains("default: Volatile.Read(&cache)!!\n    })", printed)
        Assert.Contains("Dictionary[string, int32] -> (other ?? Volatile.Read(&cache))!!", printed)
        Assert.DoesNotContain("!!)!!", printed)
        Assert.DoesNotContain("!!\n    })!!", printed)
        RunsAs(printed, "1 1 0 1 1 1")
    }

    /// An initializer of an explicitly typed local, an assignment to a local, a static field, an instance
    /// field and a property, each declared non-null.
    @Fact
    func AnAssignmentToANonNullSlot_AssertsTheResult() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public class Holder
    {
        public Dictionary<string, int> Slot = new Dictionary<string, int>();
        public Dictionary<string, int> Prop { get; set; } = new Dictionary<string, int>();
    }
    public static class P
    {
        private static Dictionary<string, int>? cache = new Dictionary<string, int> { ["a"] = 1 };
        private static Dictionary<string, int> field = new Dictionary<string, int>();
        static int Initializer() { Dictionary<string, int> d = Volatile.Read(ref cache!); return d.Count; }
        static int Assignment() { Dictionary<string, int> d; d = Volatile.Read(ref cache!); return d.Count; }
        static int Field() { field = Volatile.Read(ref cache!); return field.Count; }
        static int Member(Holder h) { h.Slot = Volatile.Read(ref cache!); h.Prop = Volatile.Read(ref cache!); return h.Slot.Count + h.Prop.Count; }
        public static string Run() => Initializer() + " " + Assignment() + " " + Field() + " " + Member(new Holder());
    }
}`)
        Assert.Contains("let d = Volatile.Read(&cache)!!", printed)
        Assert.Contains("d = Volatile.Read(&cache)!!", printed)
        Assert.Contains("field = Volatile.Read(&cache)!!", printed)
        Assert.Contains("h.Slot = Volatile.Read(&cache)!!", printed)
        Assert.Contains("h.Prop = Volatile.Read(&cache)!!", printed)
        RunsAs(printed, "1 1 1 2")
    }

    /// Control: a slot that accepts nil (a `Dictionary?` parameter, return, local, field or conditional arm),
    /// a generic parameter that G# infers from the value and a `var` local that such a value initializes take the
    /// null as C# does, with no `!!`.
    @Fact
    func ANullableSlot_TakesTheNullUnasserted() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public class Holder { public Dictionary<string, int>? Maybe = new Dictionary<string, int>(); }
    public static class P
    {
        private static Dictionary<string, int>? cache;
        static int TakeMaybe(Dictionary<string, int>? d) => d == null ? -1 : d.Count;
        static T Id<T>(T value) => value;
        static int Inferred() => TakeMaybe(Id(Volatile.Read(ref cache!)));
        static int Reassign() { var d = Volatile.Read(ref cache!); d = Volatile.Read(ref cache!); return 1; }
        static int Argument() => TakeMaybe(Volatile.Read(ref cache!));
        static Dictionary<string, int>? Return() => Volatile.Read(ref cache!);
        static bool Local() { Dictionary<string, int>? d = Volatile.Read(ref cache!); return d == null; }
        static bool Member(Holder h) { h.Maybe = Volatile.Read(ref cache!); return h.Maybe == null; }
        static bool Conditional(bool flag) { Dictionary<string, int>? d = flag ? Volatile.Read(ref cache!) : null; return d == null; }
        public static string Run() => Argument() + " " + (Return() == null) + " " + Local() + " " + Member(new Holder()) + " " + Conditional(true) + " " + Inferred() + " " + Reassign();
    }
}`)
        Assert.DoesNotContain("!!", printed)
        RunsAs(printed, "-1 True True True True -1 1")
    }

    /// Control: the result of a lambda whose type G# infers from its body (`var read = () => …`), in block and
    /// expression form, takes the null as C# does. A block lambda whose delegate type fixes a non-null result
    /// keeps the `!!`. The expression form at a fixed delegate binds without it (#5686).
    @Fact
    func AnInferredLambdaResult_TakesTheNullUnasserted() {
        let printed = Translate(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public static class P
    {
        private static Dictionary<string, int>? cache;
        private static Dictionary<string, int>? full = new Dictionary<string, int> { ["a"] = 1 };
        static bool Block() { var read = () => { return Volatile.Read(ref cache!); }; return read() == null; }
        static bool Expression() { var read = () => Volatile.Read(ref cache!); return read() == null; }
        static int Fixed() { Func<Dictionary<string, int>> read = () => Volatile.Read(ref full!); return read().Count; }
        static int FixedBlock() { Func<Dictionary<string, int>> read = () => { return Volatile.Read(ref full!); }; return read().Count; }
        public static string Run() => Block() + " " + Expression() + " " + Fixed() + " " + FixedBlock();
    }
}`)
        Assert.Contains("return Volatile.Read(&cache)\n", printed)
        Assert.Contains("let read = () -> Volatile.Read(&cache)\n", printed)
        Assert.Contains("return Volatile.Read(&full)!!\n", printed)
        RunsAs(printed, "True True 1 1")
    }

    /// Control: a tuple element that initializes a `var` local (also named or nested) or a local that a
    /// deconstruction declares takes the null as C# does: G# types that storage from the element. A tuple stored
    /// into an explicitly typed local, or into a `var` local that a non-null value fixed, keeps the `!!`.
    @Fact
    func ATupleElementOfInferredStorage_TakesTheNullUnasserted() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public static class P
    {
        private static Dictionary<string, int>? cache;
        private static Dictionary<string, int>? full = new Dictionary<string, int> { ["a"] = 1 };
        static bool Inferred() { var t = (Volatile.Read(ref cache!), 0); return t.Item1 == null; }
        static bool Named() { var t = (D: Volatile.Read(ref cache!), N: 0); return t.D == null; }
        static bool Nested() { var t = ((Volatile.Read(ref cache!), 1), 0); return t.Item1.Item1 == null; }
        static bool Deconstruct() { var (d, n) = (Volatile.Read(ref cache!), 0); return d == null; }
        static bool DeconstructEach() { (var d, var n) = (Volatile.Read(ref cache!), 0); return d == null; }
        static int Typed() { (Dictionary<string, int> D, int N) t = (Volatile.Read(ref full!), 0); return t.D.Count; }
        static int Reassigned() { var t = (new Dictionary<string, int>(), 0); t = (Volatile.Read(ref full!), 1); return t.Item1.Count; }
        public static string Run() =>
            Inferred() + " " + Named() + " " + Nested() + " " + Deconstruct() + " " + DeconstructEach() + " " + Typed() + " " + Reassigned();
    }
}`)
        Assert.Contains("let t = (Volatile.Read(&cache), 0)\n", printed)
        Assert.Contains("let t = ((Volatile.Read(&cache), 1), 0)\n", printed)
        Assert.Contains("let (d, n) = (Volatile.Read(&cache), 0)\n", printed)
        Assert.Contains("= (Volatile.Read(&full)!!, 0)\n", printed)
        Assert.Contains("t = (Volatile.Read(&full)!!, 1)\n", printed)
        RunsAs(printed, "True True True True True 1 1")
    }

    /// A null `cache` at a non-null slot. C# passes, returns or stores the null, and the first dereference
    /// throws `NullReferenceException`. G# throws it at the `!!` that re-states the author's suppression, as
    /// at a member-access receiver since issue #4287, so a program that dereferences the value prints what C#
    /// prints. The last row compares the returned value with null and does not dereference it: C# prints
    /// `True`, and G# throws at the `!!` in `Ret`.
    @Fact
    func ANullCacheAtANonNullSlot_ThrowsAtTheAssertion() {
        let printed = Translate(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public static class P
    {
        private static Dictionary<string, int>? cache;
        private static Dictionary<string, int> field = new Dictionary<string, int>();
        static int Take(Dictionary<string, int> d) => d.Count;
        static Dictionary<string, int> Ret() => Volatile.Read(ref cache!);
        static string Try(Func<string> f)
        {
            try { return f(); } catch (NullReferenceException) { return "NRE"; }
        }
        public static string Run() =>
            Try(() => Take(Volatile.Read(ref cache!)).ToString()) + " " +
            Try(() => Ret().Count.ToString()) + " " +
            Try(() => { field = Volatile.Read(ref cache!); return field.Count.ToString(); }) + " " +
            Try(() => (Ret() == null).ToString());
    }
}`)
        Assert.Contains("Take(Volatile.Read(&cache)!!)", printed)
        RunsAs(printed, "NRE NRE NRE NRE")
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
