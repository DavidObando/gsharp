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
/// is added where the emitted value is `T?` and the slot that the program text declares is non-null.
/// @remarks Mutation witnesses (ADR-0154): on 459ab4012 (before this fix) and with
/// `YieldsValueNilableBeyondItsCSharpType` always `false`, the argument, return, assignment, composed and null
/// rows do not bind. Without its walk into the operands of a conditional, a switch expression or `??`, the
/// composed receivers and the `??` return do not bind. Without the target check, the nullable control rows
/// assert and throw `NullReferenceException`. `SlotTypeIsDeclared` limits the new `!!` to a slot whose type the
/// program text writes: when it counts a slot typed by a type parameter, a `var` or deconstructed local, a
/// reassigned local whose emitted storage is `T?`, the result of a lambda stored into an inferred slot or a
/// value with no slot symbol, the matching control rows assert and throw; when it drops a field, a property,
/// a method result or the storage of an asserted initializer, the matching rows do not bind.
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
    /// expression form and through a conditional arm, takes the null as C# does. An expression lambda, a block
    /// lambda and an arm of an expression lambda whose delegate type fixes a non-null result keep the `!!` (#5686).
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
        static int FixedChecked() { Func<Dictionary<string, int>> read = () => checked(Volatile.Read(ref full!)); return read().Count; }
        static int FixedUnchecked() { Func<Dictionary<string, int>> read = () => unchecked(Volatile.Read(ref full!)); return read().Count; }
        static int FixedBlock() { Func<Dictionary<string, int>> read = () => { return Volatile.Read(ref full!); }; return read().Count; }
        static bool Arm(bool flag) { var read = () => flag ? Volatile.Read(ref cache!) : new Dictionary<string, int>(); return read() == null; }
        static int FixedArm(bool flag) { Func<Dictionary<string, int>> read = () => flag ? Volatile.Read(ref full!) : new Dictionary<string, int>(); return read().Count; }
        public static string Run() => Block() + " " + Expression() + " " + Fixed() + " " + FixedChecked() + " " + FixedUnchecked() + " " + FixedBlock() + " " + Arm(true) + " " + FixedArm(true);
    }
}`)
        Assert.Contains("return Volatile.Read(&cache)\n", printed)
        Assert.Contains("let read = () -> Volatile.Read(&cache)\n", printed)
        Assert.Contains("let read () -> Dictionary[string, int32] = () -> Volatile.Read(&full)!!\n", printed)
        Assert.Contains("let read () -> Dictionary[string, int32] = () -> checked(Volatile.Read(&full))!!\n", printed)
        Assert.Contains("let read () -> Dictionary[string, int32] = () -> unchecked(Volatile.Read(&full))!!\n", printed)
        Assert.Contains("return Volatile.Read(&full)!!\n", printed)
        Assert.Contains("let read = () -> if flag { Volatile.Read(&cache) } else", printed)
        Assert.Contains("() -> if flag { Volatile.Read(&full)!! } else", printed)
        RunsAs(printed, "True True 1 1 1 1 True 1")
    }

    /// Control: a tuple element that initializes a `var` local (also named or nested) or a local that a
    /// deconstruction declares takes the null as C# does: G# types that storage from the element. A tuple stored
    /// into an explicitly typed local keeps the `!!`. A `var` local is not a declared slot, also when a later
    /// tuple is assigned to it.
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
        Assert.Contains("t = (Volatile.Read(&full), 1)\n", printed)
        RunsAs(printed, "True True True True True 1 1")
    }

    /// A conversion operator's parameter is a declared slot, also for an arm of a `var` initializer: the arm is
    /// asserted. A `var` local that a tuple, an alias or an inferred generic result initializes, a reassignment
    /// of such a local and a tuple result of an inferred lambda are typed by G# from the value: a null cache
    /// passes through as in C#. A tuple result of a lambda whose delegate type is fixed keeps the `!!`.
    @Fact
    func AnOperatorInputOrValueTypedStorage_FollowsItsSlot() {
        let printed = Translate(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public class Box { public static implicit operator Box(Dictionary<string, int> d) => new Box(); }
    public static class P
    {
        private static Dictionary<string, int>? cache;
        private static Dictionary<string, int>? full = new Dictionary<string, int> { ["a"] = 1 };
        static T Id<T>(T value) => value;
        static string Operator(bool flag) { var b = flag ? Volatile.Read(ref full!) : new Box(); return b == null ? "null" : "box"; }
        static int TupleReassign() { var t = (Volatile.Read(ref cache!), 0); t = (Volatile.Read(ref cache!), 1); return 1; }
        static bool LambdaTuple() { var read = () => { return (Volatile.Read(ref cache!), 0); }; return read().Item1 == null; }
        static bool LambdaTupleExpr() { var read = () => (Volatile.Read(ref cache!), 0); return read().Item1 == null; }
        static int Alias() { var a = Volatile.Read(ref cache!); var b = a; b = Volatile.Read(ref cache!); return 1; }
        static int Generic() { var b = Id(Volatile.Read(ref cache!)); b = Volatile.Read(ref cache!); return 1; }
        static int FixedLambdaTuple() { Func<(Dictionary<string, int>, int)> read = () => { return (Volatile.Read(ref full!), 0); }; return read().Item1.Count; }
        static int FixedLambdaTupleExpr() { Func<(Dictionary<string, int>, int)> read = () => (Volatile.Read(ref full!), 0); return read().Item1.Count; }
        static int FixedAsyncLambdaTupleExpr() { Func<System.Threading.Tasks.Task<(Dictionary<string, int>, int)>> read = async () => (Volatile.Read(ref full!), 0); return read().Result.Item1.Count; }
        static int FixedCheckedLambdaTupleExpr() { Func<(Dictionary<string, int>, int)> read = () => checked((Volatile.Read(ref full!), 0)); return read().Item1.Count; }
        static int FixedUncheckedLambdaTupleExpr() { Func<(Dictionary<string, int>, int)> read = () => unchecked((Volatile.Read(ref full!), 0)); return read().Item1.Count; }
        public static string Run() =>
            Operator(true) + " " + TupleReassign() + " " + LambdaTuple() + " " + LambdaTupleExpr() + " " + Alias() + " " + Generic() + " " + FixedLambdaTuple() + " " + FixedLambdaTupleExpr() + " " + FixedAsyncLambdaTupleExpr() + " " + FixedCheckedLambdaTupleExpr() + " " + FixedUncheckedLambdaTupleExpr();
    }
}`)
        Assert.Contains("Box(Volatile.Read(&full)!!)", printed)
        Assert.Contains("t = (Volatile.Read(&cache), 1)\n", printed)
        Assert.Contains("return (Volatile.Read(&cache), 0)\n", printed)
        Assert.Contains("let read = () -> (Volatile.Read(&cache), 0)\n", printed)
        Assert.Contains("b = Volatile.Read(&cache)\n", printed)
        Assert.Contains("return (Volatile.Read(&full)!!, 0)\n", printed)
        Assert.Contains("() -> (Volatile.Read(&full)!!, 0)\n", printed)
        Assert.Contains("async () -> (Volatile.Read(&full)!!, 0)\n", printed)
        Assert.Contains("() -> checked((Volatile.Read(&full)!!, 0))\n", printed)
        Assert.Contains("() -> unchecked((Volatile.Read(&full)!!, 0))\n", printed)
        RunsAs(printed, "box 1 True True 1 1 1 1 1 1 1")
    }

    /// Control: a field, a property or a parameter whose declared type mentions a type parameter is typed by
    /// the type arguments that G# infers, here from the `T?`-only value itself (`var b = Wrap(…)`,
    /// `Take<T>((T, int))`). A null cache passes through as in C#.
    @Fact
    func ASlotTypedByATypeParameter_TakesTheNullUnasserted() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public class Box<T>
    {
        public Box(T value) { Value = value; Prop = value; }
        public T Value;
        public T Prop { get; set; }
    }
    public static class P
    {
        private static Dictionary<string, int>? cache;
        static Box<T> Wrap<T>(T value) => new Box<T>(value);
        static int Take<T>((T, int) pair) => 1;
        static int Field() { var b = Wrap(Volatile.Read(ref cache!)); b.Value = Volatile.Read(ref cache!); return 1; }
        static int Property() { var b = Wrap(Volatile.Read(ref cache!)); b.Prop = Volatile.Read(ref cache!); return 1; }
        static int TupleArgument() => Take((Volatile.Read(ref cache!), 0));
        public static string Run() => Field() + " " + Property() + " " + TupleArgument();
    }
}`)
        Assert.Contains("b.Value = Volatile.Read(&cache)\n", printed)
        Assert.Contains("b.Prop = Volatile.Read(&cache)\n", printed)
        Assert.Contains("Take((Volatile.Read(&cache), 0))", printed)
        RunsAs(printed, "1 1 1")
    }

    /// A lambda result is declared exactly when the slot that receives the lambda is: a `var` local that an
    /// earlier lambda typed, a `Func<T>` parameter of a receiver whose `T` G# infers and a `Delegate` local
    /// take the null, and a `Func<Dictionary<…>>` field keeps the `!!`. A reassigned local follows the storage that its declaration
    /// emitted: a deconstruction and an initializer that is `T?` through generic inference leave it `T?`, and an
    /// initializer that the bridge asserted leaves it non-null.
    @Fact
    func ALambdaOrLocalReassignment_FollowsTheEmittedSlot() {
        let printed = Translate(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public class Box<T>
    {
        public Box(T value) { Value = value; }
        public T Value;
        public int Use(Func<T> read) => read() == null ? 1 : 2;
    }
    public static class P
    {
        private static Dictionary<string, int>? cache;
        private static Dictionary<string, int>? full = new Dictionary<string, int> { ["a"] = 1 };
        private static Func<Dictionary<string, int>> fixedRead = () => new Dictionary<string, int>();
        static T Id<T>(T value) => value;
        static T Read<T>(Func<T> f) => f();
        static Box<T> Wrap<T>(T value) => new Box<T>(value);
        static bool Reassign() { var read = () => Volatile.Read(ref cache!); read = () => { return Volatile.Read(ref cache!); }; return read() == null; }
        static int Use() { var b = Wrap(Volatile.Read(ref cache!)); return b.Use(() => Volatile.Read(ref cache!)); }
        static int UseBlock() { var b = Wrap(Volatile.Read(ref cache!)); return b.Use(() => { return Volatile.Read(ref cache!); }); }
        static bool ReadInferred() => Read(() => Volatile.Read(ref cache!)) == null;
        static int ReadExplicit() => Read<Dictionary<string, int>>(() => Volatile.Read(ref full!)).Count;
        static int Deconstruct() { (Dictionary<string, int> d, int n) = (Volatile.Read(ref cache!), 0); d = Volatile.Read(ref cache!); return 1; }
        static int TypedThenGeneric() { Dictionary<string, int> d = Id(Volatile.Read(ref cache!)); d = Volatile.Read(ref cache!); return 1; }
        static int FixedField() { fixedRead = () => { return Volatile.Read(ref full!); }; return fixedRead().Count; }
        static int FixedFieldExpr() { fixedRead = () => Volatile.Read(ref full!); return fixedRead().Count; }
        static int NestedFixedExpr() { Func<Func<Dictionary<string, int>>> outer = () => () => Volatile.Read(ref full!); return outer()().Count; }
        static bool AsDelegate() { Delegate read = () => { return Volatile.Read(ref cache!); }; return read.DynamicInvoke() == null; }
        static bool AsDelegateExpr() { Delegate read = () => Volatile.Read(ref cache!); return read.DynamicInvoke() == null; }
        static int TypedReassign() { Dictionary<string, int> d = Volatile.Read(ref full!); d = Volatile.Read(ref full!); return d.Count; }
        public static string Run() =>
            Reassign() + " " + Use() + " " + UseBlock() + " " + ReadInferred() + " " + ReadExplicit() + " " + Deconstruct() + " " + TypedThenGeneric() + " " + FixedField() + " " + FixedFieldExpr() + " " + NestedFixedExpr() + " " + TypedReassign() + " " + AsDelegate() + " " + AsDelegateExpr();
    }
}`)
        let exprTreePrinted = Translate(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq.Expressions;
namespace Demo
{
    public static class ExprTreeHolder
    {
        public static Expression<Func<Dictionary<string, int>>> Make(Dictionary<string, int>? d)
        {
            Expression<Func<Dictionary<string, int>>> read = () => d;
            return read;
        }
    }
}`)
        Assert.Contains("return b.Use(() -> Volatile.Read(&cache))", printed)
        Assert.Contains("Read(() -> Volatile.Read(&cache)) == nil", printed)
        Assert.Contains("Read[Dictionary[string, int32]](() -> Volatile.Read(&full)!!).Count", printed)
        Assert.Contains("var (d, n) = (Volatile.Read(&cache), 0)\n        d = Volatile.Read(&cache)\n", printed)
        Assert.Contains("var d = Id(Volatile.Read(&cache))\n        d = Volatile.Read(&cache)\n", printed)
        Assert.Contains("return Volatile.Read(&full)!!\n", printed)
        Assert.Contains("fixedRead = () -> Volatile.Read(&full)!!\n", printed)
        Assert.Contains("() -> () -> Volatile.Read(&full)!!\n", printed)
        Assert.Contains("let read Expression[() -> Dictionary[string, int32]] = () -> d\n", exprTreePrinted)
        Assert.Contains("var d = Volatile.Read(&full)!!\n        d = Volatile.Read(&full)!!\n", printed)
        Assert.Contains("let read Delegate = () -> {\n            return Volatile.Read(&cache)\n", printed)
        Assert.Contains("let read Delegate = () -> Volatile.Read(&cache)\n", printed)
        RunsAs(printed, "True 1 1 True 1 1 1 1 1 1 1 True True")
    }

    /// An indexer key is a parameter slot: a key that is `T?` only in G# is asserted at a non-null indexer
    /// parameter, and passes a null cache through as C# does at a nullable one and at one typed by a type
    /// parameter that G# infers for the receiver.
    @Fact
    func AnIndexerKey_FollowsItsParameter() {
        let printed = Translate(`
#nullable enable
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public class Sink
    {
        public int this[Dictionary<string, int> d] => d.Count;
        public int this[Dictionary<string, int>? d, int k] => d == null ? -1 : d.Count + k;
    }
    public class Table<T> { public int this[T key] => 1; }
    public static class P
    {
        private static Dictionary<string, int>? cache;
        private static Dictionary<string, int>? full = new Dictionary<string, int> { ["a"] = 1 };
        static int NonNull() => new Sink()[Volatile.Read(ref full!)];
        static int Nullable() => new Sink()[Volatile.Read(ref cache!), 0];
        static Table<T> Make<T>(T seed) => new Table<T>();
        static int Generic() { var t = Make(Volatile.Read(ref cache!)); return t[Volatile.Read(ref cache!)]; }
        public static string Run() => NonNull() + " " + Nullable() + " " + Generic();
    }
}`)
        Assert.Contains("Sink()[Volatile.Read(&full)!!]", printed)
        Assert.Contains("Sink()[Volatile.Read(&cache), 0]", printed)
        Assert.Contains("return t[Volatile.Read(&cache)]", printed)
        RunsAs(printed, "1 -1 1")
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
