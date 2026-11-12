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
/// assert and throw `NullReferenceException`. `SlotTypeIsDeclared` limits the new `!!` to a slot whose emitted
/// G# storage is non-null (#5627, #5686, #5701): when it counts a slot typed by an inferred type parameter, an
/// inferred `var` or deconstructed local, a reassigned local or array element whose emitted storage is `T?`, or
/// the result of a lambda stored into an inferred slot, the matching control rows assert and throw; when it
/// drops a field, a property, a method result, an asserted or non-null `var` local, an array element or a
/// member of a receiver with written type arguments, the matching rows do not bind.
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
        public Box(T value) { Value = value; Read = () => value; ReadProp = () => value; }
        public T Value;
        public Func<T> Read;
        public Func<T> ReadProp { get; set; }
        public Box<T> Next => this;
        public Box<T> NextCall() => this;
        public int Use(Func<T> read) => read() == null ? 1 : 2;
        public static T ReadStatic(Func<T> read) => read();
    }
    public class Holder<T>
    {
        public Holder(Box<T> box) { Box = box; }
        public Box<T> Box;
    }
    public class Pair<T, U>
    {
        public Pair(T first, U second) { First = first; Second = second; }
        public T First;
        public U Second;
        public int Use(Func<T> read) => read().ToString() == null ? 0 : 1;
        public int UseSecond(Func<U> read) => read() == null ? 1 : 2;
        public int UseMap(Func<Dictionary<string, T>> read) => read().Count;
    }
    public class Outer<T>
    {
        public class Inner
        {
            public int Use(Func<T> read) => read() == null ? 1 : 2;
        }
        public class InnerGeneric<U>
        {
            public int Tag = 1;
        }
    }
    public class Maker<T>
    {
        public int UseNestedGeneric(Func<Outer<T>.InnerGeneric<int>> read) => read().Tag;
    }
    public class GenericRefBox<T> where T : class
    {
        private T? cache;
        public Func<T> Read;
        public GenericRefBox(T seed)
        {
            cache = seed;
            Read = () => Volatile.Read(ref cache!);
        }
        public T AssignAndRead()
        {
            Read = () => Volatile.Read(ref cache!);
            return Read();
        }
    }
    public struct Token
    {
        public Action? Mutate;
        public Token(Action mutate) { Mutate = mutate; }
        public static implicit operator int(Token t) { t.Mutate?.Invoke(); return 1; }
    }
    public class NullableBox
    {
        public static implicit operator NullableBox(string? value) => new NullableBox();
    }
    public class BaseCallback<T>
    {
        public Func<T> Read;
        public BaseCallback(Func<T> read) { Read = read; }
    }
    public class Closed : Box<Dictionary<string, int>>
    {
        private static Dictionary<string, int>? staticFull = new Dictionary<string, int> { ["a"] = 1 };
        private Dictionary<string, int>? full = new Dictionary<string, int> { ["a"] = 1 };
        public Closed(Dictionary<string, int> value) : base(value) { }
        public int UseInherited() => Use(() => Volatile.Read(ref full!));
        public class DerivedCallback : BaseCallback<Dictionary<string, int>>
        {
            public DerivedCallback() : base(() => Volatile.Read(ref staticFull!)) { }
        }
    }
    public class Bag : System.Collections.IEnumerable
    {
        public bool LastWasNull;
        public void Add<T>(Func<T> read) { LastWasNull = read() == null; }
        public System.Collections.IEnumerator GetEnumerator() { yield break; }
    }
    public static class P
    {
        private static Dictionary<string, int>? cache;
        private static Dictionary<string, int>? full = new Dictionary<string, int> { ["a"] = 1 };
        private static Outer<string>.InnerGeneric<int>? fullInner = new Outer<string>.InnerGeneric<int>();
        private static System.Threading.Tasks.Task<string?>? fullTask = System.Threading.Tasks.Task.FromResult<string?>("ok");
        private static Func<Dictionary<string, int>> fixedRead = () => new Dictionary<string, int>();
        static T Id<T>(T value) => value;
        static T Read<T>(Func<T> f) => f();
        static string? Observe(Func<Dictionary<string, int>> read) => read().Count > 0 ? null : "nonempty";
        static int ConsumeTuple<T>(Func<(Dictionary<string, int>, T)> read) => read().Item1.Count;
        static Dictionary<string, int> ReadWithInput<T>(T x, Func<T, Dictionary<string, int>> f) => f(x);
        static Dictionary<string, int> ReadParams<T>(T x, params Func<T, Dictionary<string, int>>[] fs) => fs[0](x);
        static int UseTuple<T>((Func<Dictionary<string, int>> Read, T Value) pair) => pair.Read().Count + (pair.Value == null ? 0 : 1);
        static Box<T> Wrap<T>(T value) => new Box<T>(value);
        static Pair<Dictionary<string, int>, U> MakePair<U>(U second) => new Pair<Dictionary<string, int>, U>(new Dictionary<string, int> { ["a"] = 1 }, second);
        static Pair<int, U> MakeIntPair<U>(U second) => new Pair<int, U>(1, second);
        static int UseParamPair<U>(Pair<Dictionary<string, int>, U> p) => p.Use(() => Volatile.Read(ref full!));
        static (T, int) MakeTuple<T>(T value) => (value, 0);
        static (T, int) PickSecond<T>((T, T) p) => (p.Item2, 0);
        static Outer<T>.Inner WrapInner<T>(T value) => new Outer<T>.Inner();
        static bool Reassign() { var first = () => Volatile.Read(ref cache!); var read = first; read = () => Volatile.Read(ref cache!); read = () => { return Volatile.Read(ref cache!); }; return read() == null; }
        static int ReassignFixedVar() { var read = () => { Volatile.Read(ref cache!); return new Dictionary<string, int>(); }; read = () => Volatile.Read(ref full!); var readMixed = () => (new Dictionary<string, int>(), Volatile.Read(ref cache!)); readMixed = () => (Volatile.Read(ref full!), Volatile.Read(ref cache!)); var mixedResult = readMixed(); var nestedPairLocal = (Volatile.Read(ref cache!), 0); var readNestedMixed = () => (new Dictionary<string, int>(), (Volatile.Read(ref cache!), 0)); readNestedMixed = () => (Volatile.Read(ref full!), nestedPairLocal); var nestedMixedResult = readNestedMixed(); var a0 = () => new Dictionary<string, int>(); var a1 = true ? a0 : a0; var a2 = true ? a1 : a1; a2 = () => Volatile.Read(ref full!); var readTask = () => System.Threading.Tasks.Task.FromResult<string?>(null); readTask = () => Volatile.Read(ref fullTask!); return read().Count + mixedResult.Item1.Count + (mixedResult.Item2 == null ? 1 : 0) + nestedMixedResult.Item1.Count + (nestedMixedResult.Item2.Item1 == null ? 1 : 0) + a2().Count + (readTask().GetAwaiter().GetResult() != null ? 1 : 0); }
        static System.Threading.Tasks.Task<Box<Dictionary<string, int>>> CreateAsync() => System.Threading.Tasks.Task.FromResult(new Box<Dictionary<string, int>>(new Dictionary<string, int> { ["a"] = 1 }));
        static System.Threading.Tasks.Task<Box<T>> CreateInferredAsync<T>(T value) => System.Threading.Tasks.Task.FromResult(new Box<T>(value));
        static async System.Threading.Tasks.Task<int> UseAwaitedAsync() { var b = await CreateAsync(); var inferredBox = await CreateInferredAsync(Volatile.Read(ref cache!)); var syncFactory = () => Wrap(Volatile.Read(ref cache!)); var asyncFactory = () => CreateInferredAsync(Volatile.Read(ref cache!)); return b.Use(() => Volatile.Read(ref full!)) + inferredBox.Use(() => Volatile.Read(ref cache!)) + syncFactory().Use(() => Volatile.Read(ref cache!)) + (await asyncFactory()).Use(() => Volatile.Read(ref cache!)); }
        static int GenericInputArrayElem<T>(T seed) { List<T>? listCache = null; var inferredListReaders = new[] { () => Volatile.Read(ref listCache!) }; var readers = new Func<T, Dictionary<string, int>>[1]; readers[0] = _ => Volatile.Read(ref full!); return readers[0](seed).Count + (inferredListReaders[0]() == null ? 0 : 1); }
        static int Use() { var b = Wrap(Volatile.Read(ref cache!)); return b.Use(() => Volatile.Read(ref cache!)); }
        static int UseChained() => Wrap(Volatile.Read(ref cache!)).Use(() => Volatile.Read(ref cache!));
        static int UseChainedExplicit() => Wrap<Dictionary<string, int>>(Volatile.Read(ref full!)).Use(() => Volatile.Read(ref full!)) + Wrap(new Dictionary<string, int>()).Use(() => Volatile.Read(ref full!)) - 2;
        static int UsePartiallyFixedPair() => MakePair(Volatile.Read(ref cache!)).Use(() => Volatile.Read(ref full!)) + MakePair(Volatile.Read(ref cache!)).UseSecond(() => Volatile.Read(ref cache!)) + MakeIntPair(0).UseMap(() => Volatile.Read(ref full!)) + UseParamPair(MakePair(Volatile.Read(ref cache!)));
        static int UseNestedInferred() => WrapInner(Volatile.Read(ref cache!)).Use(() => Volatile.Read(ref cache!)) + WrapInner<Dictionary<string, int>>(Volatile.Read(ref full!)).Use(() => Volatile.Read(ref full!)) + new Maker<string>().UseNestedGeneric(() => Volatile.Read(ref fullInner!)) + new GenericRefBox<Dictionary<string, int>>(Volatile.Read(ref full!)).AssignAndRead().Count - 1;
        static int UseBlock() { var b = Wrap(Volatile.Read(ref cache!)); return b.Use(() => { return Volatile.Read(ref cache!); }); }
        static bool ReadInferred() => Read(() => Volatile.Read(ref cache!)) == null;
        static int ReadExplicit() { var observed = Observe(() => Volatile.Read(ref full!)); Dictionary<string, int>? c = Read((Func<Dictionary<string, int>>)(() => Volatile.Read(ref full!))); return Read<Dictionary<string, int>>(() => Volatile.Read(ref full!)).Count + (observed == null ? 0 : 1) + (c == null ? 1 : 0); }
        static int ReadFixedReturnWithInferredInput() => ReadWithInput(1, x => Volatile.Read(ref full!)).Count;
        static int ReadExpandedParamsFixedReturn() => ReadParams(1, x => Volatile.Read(ref full!)).Count;
        static int UseTupleFixedDelegate() => UseTuple((() => Volatile.Read(ref full!), 0));
        private static int propCalls;
        private static (string?, int) NextPair => ("a", ++propCalls);
        static Func<(string, int)?> MakeNullableTuple((string?, int)? maybePair) => () => maybePair;
        static Func<((string, int)?, int)> MakeNestedNullableTuple(((string?, int)?, int) nestedMaybe) => () => nestedMaybe;
        static int UseExplicitNullableTuple((string?, int) explicitPair) { propCalls = 0; Func<(string, int)> readExplicit = () => explicitPair; Func<(string, int)> readProp = () => NextPair; var fromProp = readProp(); var absent = MakeNullableTuple(null)(); var present = MakeNullableTuple(("b", 2))(); var nestedAbsent = MakeNestedNullableTuple((null, 1))(); var nestedPresent = MakeNestedNullableTuple((("c", 3), 1))(); (string?, int) nullBoxPair = (null, 0); Func<(NullableBox, int)> readNullBox = () => nullBoxPair; var nullBoxed = readNullBox(); (Token, string?) mutatingPair = default; mutatingPair = (new Token(() => mutatingPair = (default, null)), "ok"); Func<(int, string)> readMutating = () => mutatingPair; var mutated = readMutating(); return readExplicit().Item1.Length + fromProp.Item1.Length + fromProp.Item2 + propCalls + (absent == null ? 1 : 0) + present.Value.Item1.Length + (nestedAbsent.Item1 == null ? 1 : 0) + nestedPresent.Item1.Value.Item1.Length + (nullBoxed.Item1 != null ? 1 : 0) + mutated.Item1 + mutated.Item2.Length; }
        static int UseTupleLocalResult() { var order = 0; int Tick() => ++order; (Dictionary<string, int>, int) Step((Dictionary<string, int>, int) p) { order = order * 10 + 2; return p; } var pair = (Volatile.Read(ref full!), 0); var nestedPair = ((Volatile.Read(ref full!), 0), 0); var namedPair = (First: (Volatile.Read(ref full!), 0), Second: 0); var both = (new Dictionary<string, int>(), Volatile.Read(ref full!)); var picked = PickSecond(both); Func<(Dictionary<string, int>, int)> read = () => pair; Func<(Dictionary<string, int>, int)> readNested = () => nestedPair.Item1; Func<(Dictionary<string, int>, int)> readNamed = () => namedPair.First; Func<(Dictionary<string, int>, int)> readCall = () => Id(pair); Func<(Dictionary<string, int>, int)> readMakeTuple = () => MakeTuple(Volatile.Read(ref full!)); Func<(Dictionary<string, int>, int)> readPickSecond = () => PickSecond((new Dictionary<string, int>(), Volatile.Read(ref full!))); Func<(Dictionary<string, int>, int)> readPickedLocal = () => picked; Func<(int, (Dictionary<string, int>, int))> readOrder = () => (Tick(), Step(pair)); Func<bool, (Dictionary<string, int>, int)> readBranch = flag => flag ? (new Dictionary<string, int> { ["a"] = 1 }, 0) : Step(pair); Func<(Dictionary<string, int>, int)> readLiteral = () => (Volatile.Read(ref full!), 0); var ordered = readOrder(); var branched = readBranch(true); return read().Item1.Count + readNested().Item1.Count + readNamed().Item1.Count + UseExplicitNullableTuple(("a", 1)) + readCall().Item1.Count + readMakeTuple().Item1.Count + readPickSecond().Item1.Count + readPickedLocal().Item1.Count + readLiteral().Item1.Count + ordered.Item2.Item1.Count + branched.Item1.Count + order; }
        static int UseInheritedOnClosedBase() => new Closed(Volatile.Read(ref full!)).UseInherited() + new Closed.DerivedCallback().Read().Count;
        static bool InferredCollectionAdd() => new Bag { () => Volatile.Read(ref cache!) }.LastWasNull;
        static int DeclaredCollectionAdd() => new List<Func<Dictionary<string, int>>> { () => Volatile.Read(ref full!) }[0]().Count;
        static int ReadCtor() => new Lazy<Dictionary<string, int>>(() => Volatile.Read(ref full!)).Value.Count;
        static int ReadStaticOnConstructedType() => Box<Dictionary<string, int>>.ReadStatic(() => Volatile.Read(ref full!)).Count;
        static int UseVarNew() { var b = new Box<Dictionary<string, int>>(Volatile.Read(ref full!)); return b.Use(() => Volatile.Read(ref full!)); }
        static int UseConditional(Box<Dictionary<string, int>>? b) => b?.Use(() => Volatile.Read(ref full!)) ?? 0;
        static int UseHolderField(Holder<Dictionary<string, int>> h) => h.Box.Use(() => Volatile.Read(ref full!));
        static int UseCastReceiver(object o) => ((Box<Dictionary<string, int>>)o).Use(() => Volatile.Read(ref full!));
        static int UseTernaryReceiver(bool flag, Box<Dictionary<string, int>> a, Box<Dictionary<string, int>> b) { var chosen = flag ? a : b; var chosen2 = flag ? chosen.Next : chosen.Next; var chosen3 = flag ? chosen2.NextCall() : chosen2.NextCall(); var inferredChosen = flag ? Wrap(Volatile.Read(ref cache!)) : Wrap(Volatile.Read(ref cache!)); return (flag ? a : b).Use(() => Volatile.Read(ref full!)) + chosen3.Use(() => Volatile.Read(ref full!)) + inferredChosen.Use(() => Volatile.Read(ref cache!)); }
        static int CastInitializer() { var read = (Func<Dictionary<string, int>>)(() => Volatile.Read(ref full!)); Func<Dictionary<string, int>> checkedRead = () => (checked(Volatile.Read(ref full!))); Func<Dictionary<string, int>> uncheckedRead = () => (unchecked(Volatile.Read(ref full!))); return read().Count + checkedRead().Count + uncheckedRead().Count; }
        static int AssignGenericMember(Box<Dictionary<string, int>> b) { b.Read = () => Volatile.Read(ref full!); b.ReadProp = () => Volatile.Read(ref full!); return b.Read().Count + b.ReadProp().Count; }
        static bool AssignInferredGenericMember() { var b = Wrap(Volatile.Read(ref cache!)); b.Read = () => Volatile.Read(ref cache!); return b.Read() == null; }
        static int ExplicitDelegateArray() { var nestedReaders = new[] { new[] { () => "ok" } }; var asyncTupleReaders = new[] { async () => (Volatile.Read(ref cache!), 0) }; var mixedNullReaders = new[] { () => Volatile.Read(ref cache!), null }; var inferredReaders = new[] { () => Volatile.Read(ref cache!) }; inferredReaders[0] = () => Volatile.Read(ref cache!); var tr0 = new[] { () => (new Dictionary<string, int>(), Volatile.Read(ref cache!)) }; var tr1 = true ? tr0 : tr0; var tr2 = true ? tr1 : tr1; tr2[0] = () => (Volatile.Read(ref full!), Volatile.Read(ref cache!)); var pair = (Volatile.Read(ref full!), 0); var consumed = ConsumeTuple(() => pair); Func<(Dictionary<string, int>, int)> readCallbackTuple = () => Read(() => (Volatile.Read(ref full!), 0)); var readers = new Func<Dictionary<string, int>>[] { () => Volatile.Read(ref full!) }; readers[0] = () => Volatile.Read(ref full!); return readers[0]().Count + (inferredReaders[0]() == null ? 1 : 0) + (mixedNullReaders[0]!() == null ? 1 : 0) + (asyncTupleReaders[0]().GetAwaiter().GetResult().Item1 == null ? 1 : 0) + nestedReaders[0][0]().Length + tr2[0]().Item1.Count + consumed + readCallbackTuple().Item1.Count + GenericInputArrayElem(0) + UseAwaitedAsync().GetAwaiter().GetResult(); }
        static int Deconstruct() { (Dictionary<string, int> d, int n) = (Volatile.Read(ref cache!), 0); d = Volatile.Read(ref cache!); return 1; }
        static int TypedThenGeneric() { Dictionary<string, int> d = Id(Volatile.Read(ref cache!)); d = Volatile.Read(ref cache!); return 1; }
        static int FixedField() { fixedRead = () => { return Volatile.Read(ref full!); }; return fixedRead().Count; }
        static int FixedFieldExpr() { fixedRead = () => Volatile.Read(ref full!); return fixedRead().Count; }
        static int NestedFixedExpr() { Func<Func<Dictionary<string, int>>> outer = () => () => Volatile.Read(ref full!); return outer()().Count; }
        static bool AsDelegate() { Delegate read = () => { return Volatile.Read(ref cache!); }; return read.DynamicInvoke() == null; }
        static bool AsDelegateExpr() { Delegate read = () => Volatile.Read(ref cache!); return read.DynamicInvoke() == null; }
        static int TypedReassign() { Dictionary<string, int> d = Volatile.Read(ref full!); d = Volatile.Read(ref full!); return d.Count; }
        public static string Run() =>
            Reassign() + " " + Use() + " " + UseChained() + " " + UseChainedExplicit() + " " + UseBlock() + " " + ReadInferred() + " " + ReadExplicit() + " " + ReadWithInputCount() + " " + Deconstruct() + " " + TypedThenGeneric() + " " + FixedField() + " " + FixedFieldExpr() + " " + NestedFixedExpr() + " " + TypedReassign() + " " + AsDelegate() + " " + AsDelegateExpr();
        static string ReadWithInputCount() => ReadFixedReturnWithInferredInput() + " " + ReadExpandedParamsFixedReturn() + " " + UseTupleFixedDelegate() + " " + UseTupleLocalResult() + " " + UsePartiallyFixedPair() + " " + UseNestedInferred() + " " + ReassignFixedVar() + " " + UseInheritedOnClosedBase() + " " + InferredCollectionAdd() + " " + DeclaredCollectionAdd() + " " + ReadCtor() + " " + ReadStaticOnConstructedType() + " " + UseVarNew() + " " + UseConditional(new Box<Dictionary<string, int>>(Volatile.Read(ref full!))) + " " + UseHolderField(new Holder<Dictionary<string, int>>(new Box<Dictionary<string, int>>(Volatile.Read(ref full!)))) + " " + UseCastReceiver(new Box<Dictionary<string, int>>(Volatile.Read(ref full!))) + " " + UseTernaryReceiver(true, new Box<Dictionary<string, int>>(Volatile.Read(ref full!)), new Box<Dictionary<string, int>>(Volatile.Read(ref full!))) + " " + CastInitializer() + " " + AssignGenericMember(new Box<Dictionary<string, int>>(Volatile.Read(ref full!))) + " " + AssignInferredGenericMember() + " " + ExplicitDelegateArray();
    }
}`)
        let exprTreePrinted = Translate(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Linq.Expressions;
using System.Threading;
namespace Demo
{
    public static class ExprTreeHolder
    {
        private static Dictionary<string, int>? full = new Dictionary<string, int> { ["a"] = 1 };
        public static Expression<Func<Dictionary<string, int>>> Make(Dictionary<string, int>? d, bool flag)
        {
            Expression<Func<Dictionary<string, int>>> read = () => d;
            Expression<Func<Func<Dictionary<string, int>>>> nested = () => () => Volatile.Read(ref full!);
            return flag ? read : Expression.Lambda<Func<Dictionary<string, int>>>(Expression.Invoke(nested.Body));
        }
    }
}`)
        Assert.Contains("return b.Use(() -> Volatile.Read(&cache))", printed)
        Assert.Contains("Wrap(Volatile.Read(&cache)).Use(() -> Volatile.Read(&cache))", printed)
        Assert.Contains(
            "Wrap[Dictionary[string, int32]](Volatile.Read(&full)!!).Use(() -> Volatile.Read(&full)!!)",
            printed
        )
        Assert.Contains("Wrap(Dictionary[string, int32]()).Use(() -> Volatile.Read(&full)!!)", printed)
        Assert.Contains("Observe(() -> Volatile.Read(&full)!!)", printed)
        Assert.Contains("Read(Func[Dictionary[string, int32]]((() -> Volatile.Read(&full)!!)))", printed)
        Assert.Contains("[]() -> List[T]?{() -> Volatile.Read(&listCache)}", printed)
        Assert.Contains("Read(() -> Volatile.Read(&cache)) == nil", printed)
        Assert.Contains("Read[Dictionary[string, int32]](() -> Volatile.Read(&full)!!).Count", printed)
        Assert.Contains("ReadWithInput(1, (x int32) -> Volatile.Read(&full)!!).Count", printed)
        Assert.Contains("ReadParams(1, (x int32) -> Volatile.Read(&full)!!).Count", printed)
        Assert.Contains("UseTuple((() -> Volatile.Read(&full)!!, 0))", printed)
        Assert.Contains(": base(() -> Volatile.Read(&Closed.staticFull)!!)", printed)
        Assert.Contains("p.Use(() -> Volatile.Read(&full)!!)", printed)
        Assert.Contains("let tupleValue = maybePair", printed)
        Assert.Contains("if tupleValue != nil", printed)
        Assert.Contains("let tupleValue_2 = nestedMaybe", printed)
        Assert.Contains("let tupleValue_3 = tupleValue_2.Item1", printed)
        Assert.Contains("if tupleValue_3 != nil", printed)
        Assert.Contains("let tupleValue_4 = explicitPair", printed)
        Assert.Contains("let tupleValue_5 = NextPair", printed)
        Assert.Contains("let tupleValue_6 = nullBoxPair", printed)
        Assert.Contains("(tupleValue_6.Item1, tupleValue_6.Item2)", printed)
        Assert.Contains("let tupleValue_7 = mutatingPair", printed)
        Assert.Contains("(tupleValue_7.Item1, tupleValue_7.Item2!!)", printed)
        Assert.Contains("MakeTuple(Volatile.Read(&full))", printed)
        Assert.Contains("PickSecond((Dictionary[string, int32](), Volatile.Read(&full)))", printed)
        Assert.Contains("let tupleValue_14 = picked", printed)
        Assert.Contains("(tupleValue.Item1!!, tupleValue.Item2)", printed)
        Assert.Contains("() -> (Volatile.Read(&full)!!, 0)", printed)
        Assert.Contains("MakePair(Volatile.Read(&cache)).Use(() -> Volatile.Read(&full)!!)", printed)
        Assert.Contains("MakePair(Volatile.Read(&cache)).UseSecond(() -> Volatile.Read(&cache))", printed)
        Assert.Contains("MakeIntPair(0).UseMap(() -> Volatile.Read(&full)!!)", printed)
        Assert.Contains("WrapInner(Volatile.Read(&cache)).Use(() -> Volatile.Read(&cache))", printed)
        Assert.Contains(
            "WrapInner[Dictionary[string, int32]](Volatile.Read(&full)!!).Use(() -> Volatile.Read(&full)!!)",
            printed
        )
        Assert.Contains("read = () -> Volatile.Read(&full)!!", printed)
        Assert.Contains("readMixed = () -> (Volatile.Read(&full)!!, Volatile.Read(&cache))", printed)
        Assert.Contains("readNestedMixed = () -> (Volatile.Read(&full)!!, nestedPairLocal)", printed)
        Assert.Contains("syncFactory!!().Use(() -> Volatile.Read(&cache))", printed)
        Assert.Contains("(await asyncFactory!!()).Use(() -> Volatile.Read(&cache))", printed)
        Assert.Contains("a2 = () -> Volatile.Read(&full)!!", printed)
        Assert.Contains("readTask = () -> Volatile.Read(&fullTask)!!", printed)
        Assert.Contains("UseNestedGeneric(() -> Volatile.Read(&fullInner)!!)", printed)
        Assert.Contains("Read = () -> Volatile.Read(&cache)!!", printed)
        Assert.Contains("tr2[0] = () -> (Volatile.Read(&full)!!, Volatile.Read(&cache))", printed)
        Assert.Contains("Read(() -> (Volatile.Read(&full), 0))", printed)
        Assert.Contains("readers[0] = () -> Volatile.Read(&full)!!", printed)
        Assert.Contains("Use(() -> Volatile.Read(&full)!!)", printed)
        Assert.Contains("Bag(){ () -> Volatile.Read(&cache) }", printed)
        Assert.Contains("List[() -> Dictionary[string, int32]]{ () -> Volatile.Read(&full)!! }", printed)
        Assert.Contains("Lazy[Dictionary[string, int32]](() -> Volatile.Read(&full)!!).Value.Count", printed)
        Assert.Contains("Box[Dictionary[string, int32]].ReadStatic(() -> Volatile.Read(&full)!!).Count", printed)
        Assert.Contains("b?.Use(() -> Volatile.Read(&full)!!) ?? 0", printed)
        Assert.Contains("h.Box.Use(() -> Volatile.Read(&full)!!)", printed)
        Assert.Contains("(cast[Box[Dictionary[string, int32]]](o)).Use(() -> Volatile.Read(&full)!!)", printed)
        Assert.Contains("chosen3.Use(() -> Volatile.Read(&full)!!)", printed)
        Assert.Contains("inferredChosen.Use(() -> Volatile.Read(&cache))", printed)
        Assert.Contains("Func[Dictionary[string, int32]]((() -> Volatile.Read(&full)!!))", printed)
        Assert.Contains(
            "let checkedRead () -> Dictionary[string, int32] = () -> (checked(Volatile.Read(&full)))!!",
            printed
        )
        Assert.Contains(
            "let uncheckedRead () -> Dictionary[string, int32] = () -> (unchecked(Volatile.Read(&full)))!!",
            printed
        )
        Assert.Contains("b.Read = () -> Volatile.Read(&full)!!", printed)
        Assert.Contains("b.ReadProp = () -> Volatile.Read(&full)!!", printed)
        Assert.Contains("b.Read = () -> Volatile.Read(&cache)", printed)
        Assert.Contains(
            "[]async () -> (Dictionary[string, int32]?, int32){async () -> (Volatile.Read(&cache), 0)}",
            printed
        )
        Assert.Contains("[]() -> Dictionary[string, int32]?{() -> Volatile.Read(&cache)}", printed)
        Assert.Contains("inferredReaders[0] = () -> Volatile.Read(&cache)", printed)
        Assert.Contains("inferredBox.Use(() -> Volatile.Read(&cache))", printed)
        Assert.Contains("[]() -> Dictionary[string, int32]{() -> Volatile.Read(&full)!!}", printed)
        Assert.Contains("var (d, n) = (Volatile.Read(&cache), 0)\n        d = Volatile.Read(&cache)\n", printed)
        Assert.Contains("var d = Id(Volatile.Read(&cache))\n        d = Volatile.Read(&cache)\n", printed)
        Assert.Contains("return Volatile.Read(&full)!!\n", printed)
        Assert.Contains("fixedRead = () -> Volatile.Read(&full)!!\n", printed)
        Assert.Contains("() -> () -> Volatile.Read(&full)!!\n", printed)
        Assert.Contains("let read Expression[() -> Dictionary[string, int32]] = () -> d\n", exprTreePrinted)
        Assert.Contains(
            "let nested Expression[() -> () -> Dictionary[string, int32]] = () -> () -> Volatile.Read(&full)!!\n",
            exprTreePrinted
        )
        Assert.Contains("var d = Volatile.Read(&full)!!\n        d = Volatile.Read(&full)!!\n", printed)
        Assert.Contains("let read Delegate = () -> {\n            return Volatile.Read(&cache)\n", printed)
        Assert.Contains("let read Delegate = () -> Volatile.Read(&cache)\n", printed)
        RunsAs(printed, "True 1 1 2 1 True 1 1 1 2 34 4 4 7 3 True 1 1 1 2 2 2 2 5 3 2 True 15 1 1 1 1 1 1 True True")
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

    /// Issue #5701: a reassigned `var` local whose declaration emitted non-null storage, an array element whose
    /// emitted element type is non-null and a type-parameter field, property, indexer or parameter of a receiver
    /// whose type arguments are written assert the value (`!!`), while their nullable and inferred counterparts
    /// take a null `cache` unasserted as C# does.
    @Fact
    func AVarLocalAnArrayElementOrATypeParameterMember_FollowsItsEmittedSlot() {
        let printed = Translate(`
#nullable enable
using System;
using System.Collections.Generic;
using System.Threading;
namespace Demo
{
    public class Box<T>
    {
        public Box(T value) { Value = value; Prop = value; Items = new T[] { value }; }
        public T Value;
        public T Prop { get; set; }
        public T[] Items;
        public T this[int index] { get => Value; set => Value = value; }
        public int Accept(T value) => 1;
    }
    public class ConvBox<T>
    {
        public static implicit operator ConvBox<T>(string s) => new ConvBox<T>();
    }
    public class ArrayEnvelope<T>
    {
        public Array Data = Array.Empty<object>();
        public static implicit operator ArrayEnvelope<T>(Array a) => new ArrayEnvelope<T> { Data = a };
    }
    public class StringArrayEnvelope
    {
        public string[] Data = Array.Empty<string>();
        public static implicit operator StringArrayEnvelope(string[] a) => new StringArrayEnvelope { Data = a };
    }
    public class Holder
    {
        public Holder() { }
        public Holder(object? ignored) { }
        public string Text => "ok";
        public string[] Names = Array.Empty<string>();
        public void Take(string[] x) { }
    }
    public class Outer<T>
    {
        public class Inner
        {
            public Inner(T value) { Value = value; }
            public T Value;
        }
    }
    public class Rows<T>
    {
        public IEnumerator<string[]> GetEnumerator() { return new List<string[]> { new[] { "ok" } }.GetEnumerator(); }
    }
    public class Seq<T> : IEnumerable<Box<string>>
    {
        private readonly T item;
        public Seq(T item) { this.item = item; }
        public IEnumerator<Box<T>> GetEnumerator() { return new List<Box<T>> { new Box<T>(item) }.GetEnumerator(); }
        IEnumerator<Box<string>> IEnumerable<Box<string>>.GetEnumerator() { return new List<Box<string>>().GetEnumerator(); }
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
    }
    public class FixedSeq<T>
    {
        public FixedSeq(T value) { Value = value; }
        public T Value;
        public IEnumerator<FixedSeq<string>> GetEnumerator() { return new List<FixedSeq<string>> { new FixedSeq<string>("ok") }.GetEnumerator(); }
    }
    public static class P
    {
        private static Dictionary<string, int>? cache;
        private static Dictionary<string, int>[]? arrayCache;
        private static string? stringCache;
        private static string? fullString = "ok";
        private static Dictionary<string, int>? full = new Dictionary<string, int> { ["a"] = 1 };
        private static string[]? fullNonNullStringRow = new string[] { "ok" };
        private static string?[]? fullNullableRow = new string?[] { "ok" };
        private static System.Threading.Tasks.Task<string?>? fullNullableTask = System.Threading.Tasks.Task.FromResult<string?>("ok");
        private static Func<Dictionary<string, int>?>? fullNullableReader = () => full;
        private static Box<Dictionary<string, int>>? fullBox = new Box<Dictionary<string, int>>(new Dictionary<string, int> { ["a"] = 1 });
        static Box<T> Wrap<T>(T value) => new Box<T>(value);
        static Box<T> WrapArray<T>(T[] xs) => new Box<T>(xs[0]);
        static T[] MakeArray<T>(T value) => new T[] { value };
        static T[][] MakeJaggedRows<T>(T seed) => new T[1][];
        static System.Threading.Tasks.Task<T[][]> MakeJaggedRowsAsync<T>(T seed) => System.Threading.Tasks.Task.FromResult(new T[1][]);
        static List<T[]> MakeArrayList<T>(T seed) => new List<T[]> { new T[] { seed } };
        static List<Box<T>> Boxes<T>(T seed) => new List<Box<T>> { new Box<T>(seed) };
        static Seq<T> MakeSeq<T>(T seed) => new Seq<T>(seed);
        static FixedSeq<T> MakeFixedSeq<T>(T seed) => new FixedSeq<T>(seed);
        static Rows<T> MakeRows<T>(T seed) => new Rows<T>();
        static Func<T>[] SimpleReaders<T>(T seed) => new Func<T>[1];
        static Func<System.Threading.Tasks.Task<T>>[] MakeTaskReaders<T>(T seed) => new Func<System.Threading.Tasks.Task<T>>[1];
        static Func<(Dictionary<string, int>, T)>[] Readers<T>(T seed) => new Func<(Dictionary<string, int>, T)>[] { () => (new Dictionary<string, int>(), seed) };
        static string KeepFixedString(object? ignored) => "ok";
        static System.Threading.Tasks.Task<string> KeepFixedStringAsync(object? ignored) => System.Threading.Tasks.Task.FromResult("ok");
        static T FirstOfTwo<T, U>(T value, U ignored) => value;
        static void TakeStringArray(string[] x) { }
        static void TakeNullableStringArray(string[]? x) { }
        static void TakeStringPairArray((string, string?)[] xs) { }
        static void GetOutBox(out Box<Dictionary<string, int>> value) { value = new Box<Dictionary<string, int>>(new Dictionary<string, int>()); }
        static void GetInferredOutBox<T>(T seed, out Box<T> value) { value = new Box<T>(seed); }
        static void GetRefOutBox<T>(ref T seed, out Box<T> value) { value = new Box<T>(seed); }
        static void GetOutWithOther<T, U>(T seed, U other, out Box<T> value) { value = new Box<T>(seed); }
        static void GetOutFromTuple<T, U>((T, U) seed, out Box<T> value) { value = new Box<T>(seed.Item1); }
        static void GetOutFromParamsTuple<T, U>(out Box<T> value, params (T, U)[] seeds) { value = new Box<T>(seeds[0].Item1); }
        static void GetOutFromArray<T>(T[] seed, out Box<T> value) { value = new Box<T>(seed.Length > 0 ? seed[0] : (T)(object)"ok"); }
        static int VarReassign() { var d = new Dictionary<string, int>(); d = Volatile.Read(ref full!); return d.Count; }
        static int VarReassignArm(bool flag) { var d = new Dictionary<string, int>(); d = flag ? Volatile.Read(ref full!) : new Dictionary<string, int>(); return d.Count; }
        static int VarReassignAlias() { var a = new Dictionary<string, int>(); var d = a; d = Volatile.Read(ref full!); var c0 = "ok"; var c1 = true ? c0 : c0; var c2 = true ? c1 : c1; var c3 = true ? c2 : c2; c3 = Volatile.Read(ref fullString!); return d.Count + (c3 == "ok" ? 0 : 1); }
        static int VarCoalesceReassign() { var d = Volatile.Read(ref cache!) ?? new Dictionary<string, int>(); d = Volatile.Read(ref full!); return d.Count; }
        static int VarCoalesceAliasReassign() { var a = Volatile.Read(ref stringCache!) ?? "ok"; var d = a; d = Volatile.Read(ref fullString!); return d.Length; }
        static int VarCastReassign() { var d = (string)Volatile.Read(ref fullString!); d = Volatile.Read(ref fullString!); var dSuppressed = Volatile.Read(ref fullString!)!; dSuppressed = Volatile.Read(ref fullString!); return (d.Length + dSuppressed.Length) / 2; }
        static int VarConcatAndInterpolationReassign() { var d1 = Volatile.Read(ref fullString!) + ""; d1 = Volatile.Read(ref fullString!); var d2 = $"{Volatile.Read(ref fullString!)}"; d2 = Volatile.Read(ref fullString!); return d1.Length + d2.Length; }
        static int VarFixedReturnHelperReassign() { var d = KeepFixedString(Volatile.Read(ref cache!)); d = Volatile.Read(ref fullString!); var d2 = FirstOfTwo("ok", Volatile.Read(ref cache!)); d2 = Volatile.Read(ref fullString!); var d3 = new Holder(Volatile.Read(ref cache!)).Text; d3 = Volatile.Read(ref fullString!); return (d.Length + d2.Length + d3.Length) / 3; }
        static int ExplicitBridgedAliasReassign() { object a = Volatile.Read(ref fullString!); var d = a; d = Volatile.Read(ref fullString!); return d.ToString()!.Length; }
        static int VarNewBoxReassign() { var b = new Box<Dictionary<string, int>>(Volatile.Read(ref full!)); b = Volatile.Read(ref fullBox!); return b.Value.Count; }
        static int Element(Dictionary<string, int>[] arr) { arr[0] = Volatile.Read(ref full!); return arr[0].Count; }
        static int VarArrayElement() { var arr = new Dictionary<string, int>[1]; arr[0] = Volatile.Read(ref full!); return arr[0].Count; }
        static int ImplicitArrayNonNullElement() { var arr = new[] { new Dictionary<string, int>() }; arr[0] = Volatile.Read(ref full!); return arr[0].Count; }
        static int ReassignedVarArray() { var a = new[] { "ok" }; a = new[] { Volatile.Read(ref fullString!) }; var b = new[] { Volatile.Read(ref stringCache!) }; var bAlias = b; b = Volatile.Read(ref fullNullableRow!); bAlias = Volatile.Read(ref fullNullableRow!); return (a[0].Length + b[0]!.Length + bAlias[0]!.Length) / 3; }
        static int SelfWrappingObjectArray() { var a = new[] { new object() }; a = new[] { a }; return a.Length; }
        static int DistinctNamedTupleArrayPeers() { var a = new[] { ((int Left, int N))(1, 0) }; var b = new[] { ((int Right, int N))(2, 0) }; var rows = new[] { a, b }; return a[0].Left + b[0].Right + rows.Length; }
        static int DistinctContainingTupleArrayPeers() { var a = new[] { new Outer<(int Left, int N)>.Inner((1, 0)) }; var b = new[] { new Outer<(int Right, int N)>.Inner((2, 0)) }; var rows = new object[] { a, b }; return a[0].Value.Left + b[0].Value.Right + rows.Length; }
        static int ArrayInitializers() { var arr = new Dictionary<string, int>[] { Volatile.Read(ref full!) }; Dictionary<string, int>[] typedImplicit = new[] { Volatile.Read(ref full!) }; return arr[0].Count + typedImplicit[0].Count; }
        static int NullableDelegateArrayElement(Func<Dictionary<string, int>>?[] readers) { readers[0] = () => Volatile.Read(ref full!); return readers[0]!().Count; }
        static int PartiallyInferredDelegateArrayElement() { var fs = Readers(Volatile.Read(ref cache!)); fs[0] = () => (Volatile.Read(ref full!), Volatile.Read(ref cache!)); var pair = fs[0](); return pair.Item1.Count + (pair.Item2 == null ? 1 : 0); }
        static int InferredDelegateArrayObjectStore() { var fs = SimpleReaders(Volatile.Read(ref cache!)); fs[0] = Volatile.Read(ref fullNullableReader!); return fs[0]() != null ? 1 : 0; }
        static int InferredTaskReaderSyncLambdaElement() { var fs = MakeTaskReaders(Volatile.Read(ref stringCache!)); fs[0] = () => Volatile.Read(ref fullNullableTask!); Func<System.Threading.Tasks.Task<string?>>[] declaredReaders = new[] { () => Volatile.Read(ref fullNullableTask!) }; return fs[0]().Result == "ok" && declaredReaders[0]().Result == "ok" ? 1 : 0; }
        static int FactoryJaggedArrayRowStore(string[]? nonNullElemRow) { var rows = MakeJaggedRows(Volatile.Read(ref stringCache!)); rows[0] = Volatile.Read(ref fullNullableRow!); rows[..][0] = Volatile.Read(ref fullNullableRow!); rows[0][0] = Volatile.Read(ref stringCache!); var literalRows = new[] { new[] { Volatile.Read(ref stringCache!) } }; literalRows[0] = Volatile.Read(ref fullNullableRow!); literalRows[0][0] = Volatile.Read(ref stringCache!); var wrappedRows = MakeArray(nonNullElemRow); wrappedRows[0]![0] = Volatile.Read(ref fullString!); var deepExplicit = FirstOfTwo(new string[]?[][] { new string[]?[] { new[] { "ok" } } }, 0); deepExplicit[0][0]![0] = Volatile.Read(ref fullString!); var rowLeafRows = new[] { Volatile.Read(ref fullNonNullStringRow!) }; rowLeafRows[0]![0] = Volatile.Read(ref fullString!); return rows[0][0] == null && literalRows[0][0] == null && wrappedRows[0]![0] == "ok" && deepExplicit[0][0]![0] == "ok" && rowLeafRows[0]![0] == "ok" ? 1 : 0; }
        static async System.Threading.Tasks.Task<int> AwaitedFactoryJaggedArrayRowStoreAsync() { var rows = await MakeJaggedRowsAsync(Volatile.Read(ref stringCache!)); rows[0] = Volatile.Read(ref fullNullableRow!); rows[0][0] = Volatile.Read(ref stringCache!); var dAwait = await KeepFixedStringAsync(Volatile.Read(ref cache!)); dAwait = Volatile.Read(ref fullString!); return rows[0][0] == null && dAwait == "ok" ? 1 : 0; }
        static int AwaitedFactoryJaggedArrayRowStore() => AwaitedFactoryJaggedArrayRowStoreAsync().Result;
        static ConvBox<T>[] MakeConvBoxes<T>(T seed) => new ConvBox<T>[1];
        static int InferredBoxArrayConversionElement() { var arr = MakeConvBoxes(Volatile.Read(ref cache!)); arr[0] = Volatile.Read(ref fullString!); return 1; }
        static int ExplicitAndImplicitSiblingNestedArrays() { var rows = new[] { new string[] { "ok" }, new[] { Volatile.Read(ref fullString!) } }; var nullableRows = new[] { new string?[] { null }, new[] { "ok" } }; var consumedRow = new[] { "ok" }; TakeStringArray(consumedRow); Holder? nullHolder = null; nullHolder?.Take(consumedRow); var consumedRows = new[] { consumedRow, new[] { Volatile.Read(ref stringCache!) } }; var guardedRow = new[] { Volatile.Read(ref stringCache!) }; var coalesceRow = new[] { Volatile.Read(ref stringCache!) }; TakeNullableStringArray(guardedRow); if (false) { TakeStringArray(guardedRow); TakeStringArray(guardedRow!); TakeStringArray(coalesceRow ?? coalesceRow); TakeStringArray(guardedRow[..]); StringArrayEnvelope env = guardedRow; var h = new Holder { Names = guardedRow }; var list = new List<string[]> { guardedRow }; var parentRows = new[] { new string[] { "ok" }, guardedRow }; var nullableRowOuter = new string[]?[] { guardedRow }; var extractedRows = new[] { new[] { Volatile.Read(ref stringCache!) } }; TakeStringArray(extractedRows[0]); var extractedRow = extractedRows[0]; TakeStringArray(extractedRow); } return rows[0][0].Length + rows[1][0].Length + (nullableRows[0][0] == null && nullableRows[1][0] == "ok" && consumedRows[0][0] == "ok" && consumedRows[1][0] == null && guardedRow[0] == null && coalesceRow[0] == null ? 0 : 1); }
        static int InlineNestedArrayForEach() { var sum = 0; foreach (var row in new[] { new[] { 1 } }) { sum += row[0]; } return sum; }
        static int DeepBinaryNestedArray() { var cube = new[] { new[] { new[] { new[] { new[] { new[] { 1 }, new[] { 2 } }, new[] { new[] { 3 }, new[] { 4 } } }, new[] { new[] { new[] { 5 }, new[] { 6 } }, new[] { new[] { 7 }, new[] { 8 } } } }, new[] { new[] { new[] { new[] { 9 }, new[] { 10 } }, new[] { new[] { 11 }, new[] { 12 } } }, new[] { new[] { new[] { 13 }, new[] { 14 } }, new[] { new[] { 15 }, new[] { 16 } } } } }, new[] { new[] { new[] { new[] { new[] { 17 }, new[] { 18 } }, new[] { new[] { 19 }, new[] { 20 } } }, new[] { new[] { new[] { 21 }, new[] { 22 } }, new[] { new[] { 23 }, new[] { 24 } } } }, new[] { new[] { new[] { new[] { 25 }, new[] { 26 } }, new[] { new[] { 27 }, new[] { 28 } } }, new[] { new[] { new[] { 29 }, new[] { 30 } }, new[] { new[] { 31 }, new[] { 32 } } } } } }; return cube[0][0][0][0][0][0]; }
        static int HeterogeneousNestedArrays() { var rows = new[] { (object)new[] { "ok" }, new[] { 1 } }; return rows[0].GetType() == typeof(string[]) && rows[1].GetType() == typeof(int[]) ? 1 : 0; }
        static int OutVarTypedBox() { GetOutBox(out var b); b.Value = Volatile.Read(ref full!); return b.Value.Count; }
        static int OutVarPartiallyInferredBox() { GetOutWithOther("ok", Volatile.Read(ref cache!), out var b); b.Value = Volatile.Read(ref fullString!); return b.Value.Length; }
        static int OutVarTuplePartiallyInferredBox() { GetOutFromTuple(("ok", Volatile.Read(ref cache!)), out var b); b.Value = Volatile.Read(ref fullString!); GetOutFromParamsTuple(out var b2, ("ok", Volatile.Read(ref cache!))); b2.Value = Volatile.Read(ref fullString!); return (b.Value.Length + b2.Value.Length) / 2; }
        static int OutVarExplicitTupleSeedBox() { (object, int) seed = (Volatile.Read(ref fullString!), 0); GetOutFromTuple(seed, out var b); b.Value = Volatile.Read(ref fullString!); GetOutFromArray(new string[] { Volatile.Read(ref fullString!) }, out var b2); b2.Value = Volatile.Read(ref fullString!); GetOutFromArray(new string[] { }, out var b3); b3.Value = Volatile.Read(ref fullString!); return (b.Value.ToString()!.Length + b2.Value.Length + b3.Value.Length) / 3; }
        static int PatternTypedBox(object o) { if (o is Box<Dictionary<string, int>> b) { b.Value = Volatile.Read(ref full!); return b.Value.Count; } return 0; }
        static int TypedBox() { Box<Dictionary<string, int>> b = new Box<Dictionary<string, int>>(new Dictionary<string, int>()); b.Value = Volatile.Read(ref full!); return b.Value.Count; }
        static int TypedBoxMembers() { var b = new Box<Dictionary<string, int>>(Volatile.Read(ref full!)) { Value = Volatile.Read(ref full!) }; b.Prop = Volatile.Read(ref full!); b[0] = Volatile.Read(ref full!); b.Items[0] = Volatile.Read(ref full!); var nullableBoxes = new Box<string>?[] { new Box<string>("ok") }; nullableBoxes[0]!.Value = Volatile.Read(ref fullString!); return b.Accept(Volatile.Read(ref full!)) + b.Value.Count + b.Prop.Count + b[0].Count + b.Items[0].Count + (nullableBoxes[0]!.Value == "ok" ? 0 : 1); }
        static int ForEachTypedBox() { var total = 0; foreach (var item in new[] { new Box<Dictionary<string, int>>(new Dictionary<string, int>()) }) { item.Value = Volatile.Read(ref full!); total += item.Value.Count; } return total; }
        static int ForEachTypedBoxList() { var total = 0; foreach (var item in Boxes(new Dictionary<string, int>())) { item.Value = Volatile.Read(ref full!); total += item.Value.Count; } return total; }
        static int ForEachPatternTypedSeq() { var total = 0; foreach (var item in MakeSeq(new Dictionary<string, int>())) { item.Value = Volatile.Read(ref full!); total += item.Value.Count; } return total; }
        static int ForEachSameDefinitionFixedElement() { var total = 0; foreach (var item in MakeFixedSeq(Volatile.Read(ref cache!))) { item.Value = Volatile.Read(ref fullString!); total += item.Value.Length; } return total; }
        static int ForEachFixedArrayElement() { var total = 0; foreach (var row in MakeRows(Volatile.Read(ref cache!))) { row[0] = Volatile.Read(ref fullString!); total += row[0].Length; } return total; }
        static int CollectionInitializers() { var list = new List<Dictionary<string, int>> { Volatile.Read(ref full!) }; var map = new Dictionary<Dictionary<string, int>, Dictionary<string, int>> { [Volatile.Read(ref full!)] = Volatile.Read(ref full!) }; return list[0].Count + map.Count; }
        static bool VarWidenedByNull(bool flag) { var d = new Dictionary<string, int>(); if (flag) d = null; d = Volatile.Read(ref cache!); return d == null; }
        static bool NullableArrayElement() { Dictionary<string, int>?[] arr = new Dictionary<string, int>?[1]; arr[0] = Volatile.Read(ref cache!); return arr[0] == null; }
        static int InferredArrayElement() { var arr = MakeArray(Volatile.Read(ref cache!)); arr[0] = Volatile.Read(ref cache!); return 1; }
        static int ImplicitInferredArrayElement() { var arr = new[] { Volatile.Read(ref cache!) }; arr[0] = Volatile.Read(ref cache!); var xs = new[] { "ok", Volatile.Read(ref stringCache!) }; return xs[0] == "ok" && xs[1] == null ? 1 : 0; }
        static int ConditionalImplicitArrays(bool flag) { var a = flag ? new[] { "ok" } : new[] { Volatile.Read(ref stringCache!) }; var b = flag ? new[] { "ok" }! : new[] { Volatile.Read(ref stringCache!) }; return a[0] == "ok" && b[0] == "ok" ? 1 : 0; }
        static int AliasedConditionalImplicitArrays(bool flag) { var row = new[] { "ok" }; var a = flag ? row : new[] { Volatile.Read(ref stringCache!) }; var sameRow = new[] { "ok" }; var alias = flag ? sameRow : sameRow; var rows = new[] { alias, new[] { Volatile.Read(ref stringCache!) } }; var f = () => "ok"; var g = flag ? f : f; var fnRows = new[] { g, () => Volatile.Read(ref stringCache!) }; return a[0] == "ok" && rows[0][0] == "ok" && rows[1][0] == null && fnRows[0]() == "ok" && fnRows[1]() == null ? 1 : 0; }
        static int CoalescedNestedImplicitArrays() { var rows = new[] { new[] { Volatile.Read(ref stringCache!) } ?? new[] { "ok" } }; var b = WrapArray(new[] { Volatile.Read(ref stringCache!) } ?? new[] { "ok" }); b.Value = Volatile.Read(ref stringCache!); string[]? nullableNonNullRow = null; var bNonNull = WrapArray(nullableNonNullRow ?? new[] { "ok" }); bNonNull.Value = Volatile.Read(ref fullString!); var bNested = WrapArray(new[] { new[] { Volatile.Read(ref stringCache!) } }); bNested.Value[0] = Volatile.Read(ref stringCache!); return rows[0][0] == null && b.Value == null && bNonNull.Value == "ok" && bNested.Value[0] == null ? 1 : 0; }
        static int NullableJaggedConsumer() { var row = new[] { Volatile.Read(ref stringCache!) }; string?[][] rows = new[] { row }; return rows[0][0] == null ? 1 : 0; }
        static int NullableTupleLeafDelegateJaggedConsumer() { var row = new[] { () => (Volatile.Read(ref stringCache!), 0) }; Func<(string?, int)>[][] rows = new[] { row }; var pairs = new[] { (Volatile.Read(ref stringCache!), 0) }; var mixedPairs = new[] { (Volatile.Read(ref fullString!), Volatile.Read(ref stringCache!)) }; TakeStringPairArray(mixedPairs); return rows[0][0]().Item1 == null && pairs[0].Item1 == null && mixedPairs[0].Item1 == "ok" && mixedPairs[0].Item2 == null ? 1 : 0; }
        static int ImplicitInferredJaggedArrayElement() { var rows = new[] { Volatile.Read(ref arrayCache!) }; rows[0] = Volatile.Read(ref arrayCache!); return 1; }
        static int AliasedDelegateArrayRow() { var row = new[] { () => Volatile.Read(ref cache!) }; var rows = new[] { row }; return rows[0][0]() == null ? 1 : 0; }
        static int DelegateArrayConsumedAsObject() { var row = new[] { () => Volatile.Read(ref cache!) }; object[] objects = new[] { row, new object() }; return row[0]() == null && objects.Length == 2 ? 1 : 0; }
        static int ObjectTargetImplicitArray() { object value = new[] { Volatile.Read(ref stringCache!) }; Array arrValue = new[] { Volatile.Read(ref stringCache!) }; ArrayEnvelope<string> envValue = new[] { Volatile.Read(ref stringCache!) }; return ((string?[])value)[0] == null && arrValue.GetValue(0) == null && envValue.Data.GetValue(0) == null ? 1 : 0; }
        static int MixedSiblingNestedArrays() { var rows = new[] { new[] { "ok" }, new[] { Volatile.Read(ref stringCache!) } }; return (rows[0][0] == "ok" ? 1 : 0) + (rows[1][0] == null ? 1 : 0); }
        static int MixedAliasedAndInlineNestedArrays() { var row = new[] { "ok" }; var rows = new[] { row, new[] { Volatile.Read(ref stringCache!) } }; return (row[0].Length / 2) + (rows[1][0] == null ? 1 : 0); }
        static int ReassignedAliasedNestedArray() { var row = new[] { "ok" }; row = new string[] { "next" }; row = MakeArray("final"); var rows = new[] { row, new[] { Volatile.Read(ref stringCache!) } }; return (rows[0][0] == "final" ? 1 : 0) + (rows[1][0] == null ? 1 : 0); }
        static int ReassignedJaggedImplicitArray() { var row = new[] { Volatile.Read(ref stringCache!) }; var rows = new[] { row }; rows = new[] { new[] { "next" } }; var selfRow = new[] { Volatile.Read(ref stringCache!) }; var selfRows = new[] { selfRow }; selfRows[0] = selfRow; var idxRows = new[] { new[] { Volatile.Read(ref stringCache!) } }; idxRows[0] = new[] { "ok" }; idxRows[0] = ["ok"]; idxRows[0] = MakeArray("ok"); var rowFromIdx = idxRows[0]; rowFromIdx = null; var copyFromIdx = idxRows[0][..]; copyFromIdx = null; var afterNull = new[] { Volatile.Read(ref stringCache!) }; afterNull = null; afterNull = new[] { "ok" }; afterNull = ["ok"]; return rows[0][0] == "next" && selfRows[0][0] == null && idxRows[0][0] == "ok" && rowFromIdx == null && copyFromIdx == null && afterNull[0] == "ok" ? 1 : 0; }
        static int SharedAliasedArrayRow() { var row = new[] { "ok" }; var first = new[] { row }; var second = new[] { new[] { Volatile.Read(ref stringCache!) }, row }; return (first[0][0] == "ok" ? 1 : 0) + (second[0][0] == null ? 1 : 0) + (second[1][0] == "ok" ? 1 : 0); }
        static int InferredBoxItemsElement() { var b = Wrap(Volatile.Read(ref cache!)); b.Items[0] = Volatile.Read(ref cache!); return 1; }
        static bool NullableTypedBox() { var b = new Box<Dictionary<string, int>?>(Volatile.Read(ref cache!)); b.Value = Volatile.Read(ref cache!); b.Prop = Volatile.Read(ref cache!); return b.Value == null && b.Prop == null; }
        static int DeconstructedBox() { (Box<Dictionary<string, int>> b, int n) = (Wrap(Volatile.Read(ref cache!)), 0); b.Value = Volatile.Read(ref cache!); return 1; }
#nullable disable
        static int OutVarWidenedTupleSeedBox() { var seed = ("ok", 0); seed = (null!, 0); GetOutFromTuple(seed, out var b2); b2.Value = Volatile.Read(ref stringCache!); return b2.Value == null ? 1 : 0; }
#nullable enable
        static int OutVarInferredBox() { GetInferredOutBox(Volatile.Read(ref cache!), out var b); b.Value = Volatile.Read(ref cache!); GetRefOutBox(ref cache!, out var bRef); bRef.Value = Volatile.Read(ref cache!); return bRef.Value == null ? OutVarWidenedTupleSeedBox() : 0; }
        static int ForEachInferredBox() { foreach (var item in MakeArray(Wrap(Volatile.Read(ref cache!)))) { item.Value = Volatile.Read(ref cache!); return 1; } return 0; }
        static int ForEachInferredBoxList() { foreach (var item in Boxes(Volatile.Read(ref cache!))) { item.Value = Volatile.Read(ref cache!); return 1; } return 0; }
        static int ForEachInferredArrayList() { foreach (var row in MakeArrayList(Volatile.Read(ref stringCache!))) { row[0] = Volatile.Read(ref stringCache!); return row[0] == null ? 1 : 0; } return 0; }
        static int ForEachPatternInferredSeq() { foreach (var item in MakeSeq(Volatile.Read(ref cache!))) { item.Value = Volatile.Read(ref cache!); return 1; } return 0; }
        public static string Run() =>
            VarReassign() + " " + VarReassignArm(true) + " " + VarReassignAlias() + " " + VarCoalesceReassign() + " " + VarCoalesceAliasReassign() + " " + VarCastReassign() + " " + VarConcatAndInterpolationReassign() + " " + VarFixedReturnHelperReassign() + " " + ExplicitBridgedAliasReassign() + " " + VarNewBoxReassign() + " " +
            Element(new Dictionary<string, int>[1]) + " " + VarArrayElement() + " " + ImplicitArrayNonNullElement() + " " + ReassignedVarArray() + " " + SelfWrappingObjectArray() + " " + DistinctNamedTupleArrayPeers() + " " + DistinctContainingTupleArrayPeers() + " " + ArrayInitializers() + " " +
            NullableDelegateArrayElement(new Func<Dictionary<string, int>>?[1]) + " " + PartiallyInferredDelegateArrayElement() + " " + InferredDelegateArrayObjectStore() + " " + InferredTaskReaderSyncLambdaElement() + " " + FactoryJaggedArrayRowStore(new string[] { "ok" }) + " " + AwaitedFactoryJaggedArrayRowStore() + " " + InferredBoxArrayConversionElement() + " " + ExplicitAndImplicitSiblingNestedArrays() + " " + InlineNestedArrayForEach() + " " + DeepBinaryNestedArray() + " " + HeterogeneousNestedArrays() + " " + OutVarTypedBox() + " " + OutVarPartiallyInferredBox() + " " + OutVarTuplePartiallyInferredBox() + " " + OutVarExplicitTupleSeedBox() + " " + PatternTypedBox(new Box<Dictionary<string, int>>(new Dictionary<string, int>())) + " " +
            TypedBox() + " " + TypedBoxMembers() + " " + ForEachTypedBox() + " " + ForEachTypedBoxList() + " " + ForEachPatternTypedSeq() + " " + ForEachSameDefinitionFixedElement() + " " + ForEachFixedArrayElement() + " " + CollectionInitializers() + " " +
            VarWidenedByNull(true) + " " + NullableArrayElement() + " " + InferredArrayElement() + " " + ImplicitInferredArrayElement() + " " + ConditionalImplicitArrays(true) + " " + AliasedConditionalImplicitArrays(true) + " " + CoalescedNestedImplicitArrays() + " " + NullableJaggedConsumer() + " " + NullableTupleLeafDelegateJaggedConsumer() + " " +
            ImplicitInferredJaggedArrayElement() + " " + AliasedDelegateArrayRow() + " " + DelegateArrayConsumedAsObject() + " " + ObjectTargetImplicitArray() + " " + MixedSiblingNestedArrays() + " " + MixedAliasedAndInlineNestedArrays() + " " + ReassignedAliasedNestedArray() + " " + ReassignedJaggedImplicitArray() + " " + SharedAliasedArrayRow() + " " + InferredBoxItemsElement() + " " + NullableTypedBox() + " " + DeconstructedBox() + " " + OutVarInferredBox() + " " + ForEachInferredBox() + " " + ForEachInferredBoxList() + " " + ForEachInferredArrayList() + " " + ForEachPatternInferredSeq();
    }
}`)
        Assert.Contains("var d = Dictionary[string, int32]()\n        d = Volatile.Read(&full)!!\n", printed)
        Assert.Contains("d = if flag { Volatile.Read(&full)!! } else { Dictionary[string, int32]() }\n", printed)
        Assert.Contains(
            "var d = Volatile.Read(&cache) ?? Dictionary[string, int32]()\n        d = Volatile.Read(&full)!!\n",
            printed
        )
        Assert.Contains(
            "let a = Volatile.Read(&stringCache) ?? \"ok\"\n        var d = a\n        d = Volatile.Read(&fullString)!!\n",
            printed
        )
        Assert.Contains(
            "var d = cast[string](Volatile.Read(&fullString))\n        d = Volatile.Read(&fullString)!!\n",
            printed
        )
        Assert.Contains("dSuppressed = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("TakeNullableStringArray(cast[[]string](guardedRow))", printed)
        Assert.Contains("TakeStringArray(cast[[]string]((coalesceRow ?? coalesceRow)!!))", printed)
        Assert.Contains("TakeStringArray(cast[[]string](guardedRow[..]))", printed)
        Assert.Contains("let env StringArrayEnvelope = cast[[]string](guardedRow)", printed)
        Assert.Contains("[][]?string{cast[[]string](guardedRow)}", printed)
        Assert.Contains("TakeStringPairArray(cast[[](string, string?)](mixedPairs))", printed)
        Assert.Contains("var rowFromIdx []?string? = idxRows[0]", printed)
        Assert.Contains("var copyFromIdx []?string? = idxRows[0][..]", printed)
        Assert.Contains("TakeStringArray(cast[[]string](extractedRows[0]))", printed)
        Assert.Contains("TakeStringArray(cast[[]string](extractedRow))", printed)
        Assert.Contains("idxRows[0] = []string?{\"ok\"}", printed)
        Assert.Contains("idxRows[0] = cast[[]string?](MakeArray(\"ok\"))", printed)
        Assert.Contains("afterNull = []string?{\"ok\"}", printed)
        Assert.Contains("(row[0]!!.Length / 2)", printed)
        Assert.Contains("row = cast[[]string?](MakeArray(\"final\"))", printed)
        Assert.Contains("d1 = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("d2 = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains(
            "var d = KeepFixedString(Volatile.Read(&cache))\n        d = Volatile.Read(&fullString)!!\n",
            printed
        )
        Assert.Contains(
            "let a object = Volatile.Read(&fullString)!!\n        var d = a\n        d = Volatile.Read(&fullString)!!\n",
            printed
        )
        Assert.Contains("b = Volatile.Read(&fullBox)!!\n", printed)
        Assert.Contains("arr[0] = Volatile.Read(&full)!!\n", printed)
        Assert.Contains("var a = []string{\"ok\"}\n        a = []string{Volatile.Read(&fullString)!!}\n", printed)
        Assert.Contains("b = Volatile.Read(&fullNullableRow)!!\n", printed)
        Assert.Contains("bAlias = Volatile.Read(&fullNullableRow)!!\n", printed)
        Assert.Contains("wrappedRows[0]!![0] = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("deepExplicit[0][0]!![0] = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("rowLeafRows[0]!![0] = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("c3 = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("let guardedRow = []string?{Volatile.Read(&stringCache)}", printed)
        Assert.Contains("TakeStringArray(cast[[]string](guardedRow))", printed)
        Assert.Contains("[]() -> string?{g!!, () -> Volatile.Read(&stringCache)}", printed)
        Assert.Contains("let selfRow = []string?{Volatile.Read(&stringCache)}", printed)
        Assert.Contains("[]object{object([]string{\"ok\"}), []int32{1}}", printed)
        Assert.Contains("[]Dictionary[string, int32]{Volatile.Read(&full)!!}", printed)
        Assert.Contains("readers[0] = () -> Volatile.Read(&full)!!\n", printed)
        Assert.Contains("fs[0] = () -> (Volatile.Read(&full)!!, Volatile.Read(&cache))\n", printed)
        Assert.Contains("fs[0] = Volatile.Read(&fullNullableReader)!!\n", printed)
        Assert.Contains("fs[0] = () -> Volatile.Read(&fullNullableTask)!!\n", printed)
        Assert.Contains("{() -> Volatile.Read(&fullNullableTask)!!}", printed)
        Assert.Contains(
            "rows[0] = Volatile.Read(&fullNullableRow)!!\n        rows[..][0] = Volatile.Read(&fullNullableRow)!!\n        rows[0][0] = Volatile.Read(&stringCache)\n",
            printed
        )
        Assert.Contains(
            "literalRows[0] = Volatile.Read(&fullNullableRow)!!\n        literalRows[0][0] = Volatile.Read(&stringCache)\n",
            printed
        )
        Assert.Contains("[][]string{[]string{\"ok\"}, []string{Volatile.Read(&fullString)!!}}", printed)
        // Nullable elements do not require assertions on non-null outer storage (#5978).
        Assert.Contains("let consumedRows = [][]string?{consumedRow, []string?{Volatile.Read(&stringCache)}}", printed)
        Assert.Contains("Names: cast[[]string](guardedRow)", printed)
        Assert.Contains("List[[]string]{ cast[[]string](guardedRow) }", printed)
        Assert.Contains("bRef!!.Value = Volatile.Read(&cache)\n", printed)
        Assert.Contains("[](string?, int32){(Volatile.Read(&stringCache), 0)}", printed)
        Assert.Contains("GetOutBox(out var b)\n        b!!.Value = Volatile.Read(&full)!!\n", printed)
        Assert.Contains(
            "GetOutWithOther(\"ok\", Volatile.Read(&cache), out var b)\n        b!!.Value = Volatile.Read(&fullString)!!\n",
            printed
        )
        Assert.Contains(
            "GetOutFromTuple((\"ok\", Volatile.Read(&cache)), out var b)\n        b!!.Value = Volatile.Read(&fullString)!!\n",
            printed
        )
        Assert.Contains("b2!!.Value = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("b3!!.Value = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("bNonNull.Value = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("bNested.Value[0] = Volatile.Read(&stringCache)\n", printed)
        Assert.Contains("nullableBoxes[0]!!.Value = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("dAwait = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("[]string?{\"ok\", Volatile.Read(&stringCache)}", printed)
        Assert.Contains("b2.Value = Volatile.Read(&stringCache)\n", printed)
        Assert.Contains("GetOutFromTuple(seed, out var b)\n        b!!.Value = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("b.Value = Volatile.Read(&full)!!\n", printed)
        Assert.Contains("b.Prop = Volatile.Read(&full)!!\n", printed)
        Assert.Contains("b[0] = Volatile.Read(&full)!!\n", printed)
        Assert.Contains("b.Items[0] = Volatile.Read(&full)!!\n", printed)
        Assert.Contains("b.Accept(Volatile.Read(&full)!!)", printed)
        Assert.Contains("item!!.Value = Volatile.Read(&full)!!\n", printed)
        Assert.Contains("item.Value = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("row[0] = Volatile.Read(&fullString)!!\n", printed)
        Assert.Contains("List[Dictionary[string, int32]]{ Volatile.Read(&full)!! }", printed)
        Assert.Contains("[Volatile.Read(&full)!!] = Volatile.Read(&full)!!", printed)
        Assert.Contains("d = Volatile.Read(&cache)\n", printed)
        Assert.Contains("arr[0] = Volatile.Read(&cache)\n", printed)
        Assert.Contains("[]Dictionary[string, int32]?{Volatile.Read(&cache)}", printed)
        Assert.Contains("if flag { []string?{\"ok\"} } else { []string?{Volatile.Read(&stringCache)} }", printed)
        Assert.Contains(
            "let row = []string?{\"ok\"}\n        let a = if flag { row } else { []string?{Volatile.Read(&stringCache)} }",
            printed
        )
        Assert.Contains("[][]string?{[]string?{Volatile.Read(&stringCache)} ?? []string?{\"ok\"}}", printed)
        Assert.Contains(
            "let row = []string?{Volatile.Read(&stringCache)}\n        let rows = [][]string?{row}",
            printed
        )
        Assert.Contains("[]() -> (string?, int32){() -> (Volatile.Read(&stringCache), 0)}", printed)
        Assert.Contains("[][]?Dictionary[string, int32]{Volatile.Read(&arrayCache)}", printed)
        Assert.Contains("[][]() -> Dictionary[string, int32]?{", printed)
        Assert.Contains("[][]string?{[]string?{\"ok\"}, []string?{Volatile.Read(&stringCache)}}", printed)
        Assert.Contains(
            "let row = []string?{\"ok\"}\n        let rows = [][]string?{row, []string?{Volatile.Read(&stringCache)}}",
            printed
        )
        Assert.Contains(
            "var row = []string?{\"ok\"}\n        row = []string?{\"next\"}\n        row = cast[[]string?](MakeArray(\"final\"))\n        let rows = [][]string?{row, []string?{Volatile.Read(&stringCache)}}",
            printed
        )
        Assert.Contains(
            "let row = []string?{Volatile.Read(&stringCache)}\n        var rows = [][]string?{row}\n        rows = [][]string?{[]string?{\"next\"}}",
            printed
        )
        Assert.Contains(
            "let row = []string?{\"ok\"}\n        let first = [][]string?{row}\n        let second = [][]string?{[]string?{Volatile.Read(&stringCache)}, row}",
            printed
        )
        Assert.Contains("rows[0] = Volatile.Read(&arrayCache)\n", printed)
        Assert.Contains("b.Items[0] = Volatile.Read(&cache)\n", printed)
        Assert.Contains("b.Value = Volatile.Read(&cache)\n", printed)
        Assert.Contains("b.Prop = Volatile.Read(&cache)\n", printed)
        Assert.Contains(
            "GetInferredOutBox(Volatile.Read(&cache), out var b)\n        b!!.Value = Volatile.Read(&cache)\n",
            printed
        )
        Assert.Contains("let value object = []string?{Volatile.Read(&stringCache)}", printed)
        Assert.Contains("item!!.Value = Volatile.Read(&cache)\n", printed)
        RunsAs(
            printed,
            "1 1 1 1 2 2 4 2 2 1 1 1 1 2 1 5 5 2 1 2 1 1 1 1 1 4 1 1 1 1 2 2 2 1 1 5 1 1 1 2 2 2 True True 1 1 1 1 1 1 1 1 1 1 1 2 2 2 1 3 1 True 1 1 1 1 1 1"
        )
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
