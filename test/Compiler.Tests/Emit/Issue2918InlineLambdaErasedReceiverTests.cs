// <copyright file="Issue2918InlineLambdaErasedReceiverTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using GSharp.Compiler;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;
using Xunit.Sdk;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2918: inline lambdas passed through imported generic receivers keep
/// the receiver's symbolic delegate type instead of binding against its erased
/// CLR projection.
/// </summary>
public class Issue2918InlineLambdaErasedReceiverTests
{
    private const string Contracts = """
        using System;

        namespace Issue2918Contracts;

        public sealed class Slot<T>
        {
            private T value;

            public Slot(T value) => this.value = value;

            public void Put(int tag, T value) => this.value = value;

            public T this[int index]
            {
                get => this.value;
                set => this.value = value;
            }

            public T Get() => this.value;

            public void Apply(Action<T> apply) => apply(this.value);
        }

        public static class GenericSink
        {
            private static Delegate? last;

            public static void M<T>(T value) => last = (Delegate)(object)value!;

            public static void InvokeLast(object argument) => last!.DynamicInvoke(argument);
        }

        public sealed class Holder<T>
        {
            public Holder(Action<T> callback) => Kind = "symbolic";

            public Holder(Action<int> callback) => Kind = "closed";

            public string Kind { get; }
        }

        public delegate bool CustomPredicate<T>(T value);

        public sealed class PredHolder<T>
        {
            public PredHolder(Predicate<T> callback) => Kind = "pred";

            public string Kind { get; }
        }

        public sealed class MethodDelegateOverloads<T>
        {
            public string Add(Predicate<T> callback) =>
                "pred";

            public string Add(Func<T, bool> callback) =>
                "func";
        }

        public sealed class ConstructorDelegateOverloads<T>
        {
            public ConstructorDelegateOverloads(Predicate<T> callback) =>
                Kind = "pred";

            public ConstructorDelegateOverloads(Func<T, bool> callback) =>
                Kind = "func";

            public string Kind { get; }
        }

        public sealed class DelegateBox<T>
        {
            public DelegateBox(T value) => Value = value;

            public T Value { get; }

            public string RuntimeTypeName =>
                Value!.GetType().GetGenericTypeDefinition().FullName!;
        }
        """;

    private const string AssemblyCollisionContracts = """
        using System.Collections.Generic;

        namespace System
        {
            public delegate TResult Func<T, TResult>(T left, T right);
        }

        namespace Issue2948Collision
        {
            public static class Factory
            {
                public static List<global::System.Func<T, int>> Create<T>() =>
                    new();

                public static string DelegateAssemblyName<T>(
                    List<global::System.Func<T, int>> values) =>
                    values[0].GetType()
                        .Assembly.GetName().Name!;

                public static int InvokeFirst<T>(
                    List<global::System.Func<T, int>> values,
                    T left,
                    T right) =>
                    values[0](left, right);
            }
        }
        """;

    [Fact]
    public void ImportedGenericReceiverMethods_TargetInlineLambdas_VerifyLoadAndRun()
    {
        const string source = """
            package Issue2918Receivers
            import System
            import System.Collections.Generic
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            struct Pt { var N int32 }

            enum Mode { First, Second }

            interface IValue {
                func Value() int32;
            }

            class ValueImpl : IValue {
                let N int32
                init(n int32) { N = n }
                func Value() int32 -> N
            }

            class Wrapper[T any] {
                let Value T
                init(value T) { Value = value }
            }

            func PrintSrc(item Src) { Console.WriteLine(item.N) }

            func Main() {
                let callbacks = List[System.Action[Src]]()
                callbacks.Add((item Src) -> Console.WriteLine(item.N))
                callbacks[0](Src(1))

                let nestedCallbacks = List[System.Action[List[Src]]]()
                nestedCallbacks.Add((items List[Src]) -> Console.WriteLine(items[0].N))
                nestedCallbacks[0](List[Src]{ Src(2) })

                let transforms = List[System.Func[Src, int32]]()
                transforms.Add((item Src) -> item.N)
                Console.WriteLine(transforms[0](Src(3)))

                let byName = Dictionary[string, System.Action[Src]]()
                byName.Add("x", (item Src) -> Console.WriteLine(item.N))
                byName["x"](Src(4))

                let seed System.Action[Src] = PrintSrc
                let secondArg = Slot[System.Action[Src]](seed)
                secondArg.Put(1, (item Src) -> Console.WriteLine(item.N))
                let secondHandler System.Action[Src] = secondArg.Get()
                secondHandler(Src(8))

                let nestedLambda = List[System.Func[Src, System.Action[Src]]]()
                nestedLambda.Add(
                    (outer Src) -> (inner Src) -> Console.WriteLine(outer.N + inner.N))
                nestedLambda[0](Src(5))(Src(7))

                let inferred = List[System.Action[Src]]()
                inferred.Add((item) -> Console.WriteLine(item.N))
                inferred[0](Src(13))

                let structCallbacks = List[System.Action[Pt]]()
                structCallbacks.Add((item Pt) -> Console.WriteLine(item.N))
                structCallbacks[0](Pt{N: 16})

                let enumCallbacks = List[System.Action[Mode]]()
                enumCallbacks.Add((item Mode) -> Console.WriteLine(17))
                enumCallbacks[0](Mode.Second)

                let interfaceCallbacks = List[System.Action[IValue]]()
                interfaceCallbacks.Add((item IValue) -> Console.WriteLine(item.Value()))
                interfaceCallbacks[0](ValueImpl(18))

                let wrappedCallbacks = List[System.Action[Wrapper[Src]]]()
                wrappedCallbacks.Add(
                    (item Wrapper[Src]) -> Console.WriteLine(item.Value.N))
                wrappedCallbacks[0](Wrapper[Src](Src(19)))

                let unqualified = List[Action[Src]]()
                unqualified.Add((item Src) -> Console.WriteLine(item.N))
                unqualified[0](Src(20))
            }
            """;

        Assert.Equal(
            $"1{Environment.NewLine}2{Environment.NewLine}3{Environment.NewLine}4{Environment.NewLine}8{Environment.NewLine}12{Environment.NewLine}13{Environment.NewLine}16{Environment.NewLine}17{Environment.NewLine}18{Environment.NewLine}19{Environment.NewLine}20{Environment.NewLine}",
            CompileVerifyLoadAndRun(source, "Issue2918Receivers.Src"));
    }

    [Fact]
    public void MismatchedInlineLambdaArityThroughErasedSlot_IsRejected()
    {
        const string source = """
            package LambdaArityErasure
            import System
            import System.Collections.Generic

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let callbacks = List[System.Action[Src]]()
                callbacks.Add((left Src, right Src) -> Console.WriteLine(left.N + right.N))
            }
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains(
            "GS0144: Function 'lambda' requires 1 arguments but was given 2.",
            diagnostics,
            StringComparison.Ordinal);
    }

    [Fact]
    public void MatchingInlineLambdaArityThroughErasedSlot_VerifyLoadAndRun()
    {
        const string source = """
            package LambdaArityMatch
            import System
            import System.Collections.Generic

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let callbacks = List[System.Action[Src]]()
                callbacks.Add((item Src) -> Console.WriteLine(item.N))
                callbacks[0](Src(7))
            }
            """;

        Assert.Equal(
            $"7{Environment.NewLine}",
            CompileVerifyLoadAndRun(source, "LambdaArityMatch.Src"));
    }

    [Fact]
    public void ImportedGenericConstructor_TargetsInlineLambda_VerifyLoadAndRun()
    {
        const string source = """
            package Issue2918Constructor
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let slot = Slot[System.Action[Src]](
                    (item Src) -> Console.WriteLine(item.N))
                let handler System.Action[Src] = slot.Get()
                handler(Src(10))
            }
            """;

        Assert.Equal(
            $"10{Environment.NewLine}",
            CompileVerifyLoadAndRun(source, "Issue2918Constructor.Src"));
    }

    [Fact]
    public void ImportedConstructedPredicateConstructor_TargetsInlineLambda_LoadsAndRuns()
    {
        const string source = """
            package Issue2918PredicateHolder
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let holder = PredHolder[Src]((item Src) -> item.N > 2)
                Console.WriteLine(holder.Kind)
            }
            """;

        // Direct named-delegate construction retains the pre-existing #313/#939
        // IL mismatch on main; real execution is the compatibility pin here.
        Assert.Equal(
            $"pred{Environment.NewLine}",
            CompileVerifyLoadAndRun(
                source,
                "Issue2918PredicateHolder.Src",
                verifyIl: false));
    }

    [Fact]
    public void ImportedGenericConstructorOverloads_DisagreeWithoutForcingSymbolicTarget_VerifyLoadAndRun()
    {
        const string source = """
            package Issue2918ConstructorOverloads
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let symbolic = Holder[Src](
                    (item Src) -> Console.WriteLine(item.N))
                Console.WriteLine(symbolic.Kind)

                let closed = Holder[Src](
                    (item int32) -> Console.WriteLine(item))
                Console.WriteLine(closed.Kind)
            }
            """;

        Assert.Equal(
            $"symbolic{Environment.NewLine}closed{Environment.NewLine}",
            CompileVerifyLoadAndRun(source, "Issue2918ConstructorOverloads.Src"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NominalDelegateDisagreement_KeepsMethodOverloadAmbiguous(bool topLevel)
    {
        const string declarations = """
            package Issue2948MethodNominalDisagreement
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }
            """;

        const string statements = """
            let methods = MethodDelegateOverloads[Src]()
            Console.WriteLine(methods.Add((item) -> true))
            """;

        _ = CompileExpectingFailureOrReportingRuntimeOutput(
            WithExecutionScope(declarations, statements, topLevel));
    }

    [Fact]
    public void Issue3874_ReceiverSubstitution_PreservesImportedDelegateIdentity_VerifyLoadAndRun()
    {
        const string source = """
            package Issue3874ImportedDelegates
            import System

            class GenericPredicateFirst[T] {
                func Add(cb Predicate[T]) string { return "generic-pred-first:pred" }
                func Add(cb Func[T, bool]) string { return "generic-pred-first:func" }
                func Call(cb Predicate[T]) string { return Add(cb) }
                func Call(cb Func[T, bool]) string { return Add(cb) }
            }

            class GenericFuncFirst[T] {
                func Add(cb Func[T, bool]) string { return "generic-func-first:func" }
                func Add(cb Predicate[T]) string { return "generic-func-first:pred" }
            }

            class NonGeneric {
                func Add(cb Predicate[int32]) string { return "non-generic:pred" }
                func Add(cb Func[int32, bool]) string { return "non-generic:func" }
            }

            class GenericClosed[T] {
                func Add(cb Predicate[int32]) string { return "generic-closed:pred" }
                func Add(cb Func[int32, bool]) string { return "generic-closed:func" }
            }

            class ReceiverAndMethodGeneric[T] {
                func Add[U](tag U, cb Predicate[T]) string { return "method:pred:" + tag.ToString() }
                func Add[U](tag U, cb Func[T, bool]) string { return "method:func:" + tag.ToString() }
            }

            class ReceiverInferenceConflict[T] {
                func Pick[U](cb Predicate[T], tag U) string { return "receiver" }
                func Pick[U](cb Predicate[U], tag U) string { return "method" }
            }

            open class GenericBase[T] {
                func Add(cb Predicate[T]) string { return "base:pred" }
                func Add(cb Func[T, bool]) string { return "base:func" }
                func Pick[U](tag U, cb Predicate[T]) string { return "base-method:pred:" + tag.ToString() }
                func Pick[U](tag U, cb Func[T, bool]) string { return "base-method:func:" + tag.ToString() }
            }

            open class Derived : GenericBase[int32] {
                func CallBase(cb Predicate[int32]) string { return base.Add(cb) }
                func CallBase(cb Func[int32, bool]) string { return base.Add(cb) }
            }

            open class GenericDerived[T] : GenericBase[int32] {
            }

            func Always(value int32) bool { return true }
            func AlwaysString(value string) bool { return true }
            func ThroughConstraint[X GenericBase[int32]](
                value X,
                predicate Predicate[int32],
                function Func[int32, bool]) string {
                return value.Add(predicate) + "|" + value.Add(function)
            }
            func ThroughGenericConstraint[X GenericBase[int32]](
                value X,
                predicate Predicate[int32],
                function Func[int32, bool]) string {
                return value.Pick[string]("explicit", predicate)
                    + "|" + value.Pick("inferred", function)
            }
            func ThroughDerivedConstraint[X Derived](
                value X,
                predicate Predicate[int32],
                function Func[int32, bool]) string {
                return value.Add(predicate) + "|" + value.Add(function)
            }
            func ThroughGenericDerivedConstraint[X GenericDerived[string]](
                value X,
                predicate Predicate[int32],
                function Func[int32, bool]) string {
                return value.Add(predicate) + "|" + value.Add(function)
                    + "|" + value.Pick[string]("explicit", predicate)
                    + "|" + value.Pick("inferred", function)
            }

            func Main() {
                let keepAlive Action = () -> { }
                let predicate Predicate[int32] = Always
                let function Func[int32, bool] = Always

                let genericPredicateFirst = GenericPredicateFirst[int32]()
                Console.WriteLine(genericPredicateFirst.Add(predicate))
                Console.WriteLine(genericPredicateFirst.Add(function))
                Console.WriteLine(genericPredicateFirst.Call(predicate))
                Console.WriteLine(genericPredicateFirst.Call(function))

                let genericFuncFirst = GenericFuncFirst[int32]()
                Console.WriteLine(genericFuncFirst.Add(predicate))
                Console.WriteLine(genericFuncFirst.Add(function))

                let nonGeneric = NonGeneric()
                Console.WriteLine(nonGeneric.Add(predicate))
                Console.WriteLine(nonGeneric.Add(function))

                let genericClosed = GenericClosed[string]()
                Console.WriteLine(genericClosed.Add(predicate))
                Console.WriteLine(genericClosed.Add(function))

                let methodGeneric = ReceiverAndMethodGeneric[int32]()
                Console.WriteLine(methodGeneric.Add[string]("explicit", predicate))
                Console.WriteLine(methodGeneric.Add("inferred", function))

                let stringPredicate Predicate[string] = AlwaysString
                Console.WriteLine(ReceiverInferenceConflict[int32]().Pick(stringPredicate, "method"))

                let derived = Derived()
                Console.WriteLine(derived.Add(predicate))
                Console.WriteLine(derived.Add(function))
                Console.WriteLine(derived.CallBase(predicate))
                Console.WriteLine(derived.CallBase(function))
                Console.WriteLine(ThroughConstraint[Derived](derived, predicate, function))
                Console.WriteLine(ThroughGenericConstraint[Derived](derived, predicate, function))
                Console.WriteLine(ThroughDerivedConstraint[Derived](derived, predicate, function))
                let genericDerived = GenericDerived[string]()
                Console.WriteLine(ThroughGenericDerivedConstraint[GenericDerived[string]](
                    genericDerived,
                    predicate,
                    function))
                keepAlive()
            }
            """;

        Assert.Equal(
            string.Join(
                Environment.NewLine,
                "generic-pred-first:pred",
                "generic-pred-first:func",
                "generic-pred-first:pred",
                "generic-pred-first:func",
                "generic-func-first:pred",
                "generic-func-first:func",
                "non-generic:pred",
                "non-generic:func",
                "generic-closed:pred",
                "generic-closed:func",
                "method:pred:explicit",
                "method:func:inferred",
                "method",
                "base:pred",
                "base:func",
                "base:pred",
                "base:func",
                "base:pred|base:func",
                "base-method:pred:explicit|base-method:func:inferred",
                "base:pred|base:func",
                "base:pred|base:func|base-method:pred:explicit|base-method:func:inferred",
                string.Empty),
            CompileVerifyLoadAndRun(source, expectedSourceTypeName: string.Empty));
    }

    [Fact]
    public void Issue3874_ReceiverSubstitution_PreservesSourceNamedDelegateIdentity_VerifyLoadAndRun()
    {
        const string source = """
            package Issue3874NamedDelegates
            import System

            delegate First[T](value T) bool;
            delegate Second[T](value T) bool;

            class NamedOverloads[T] {
                func Add(cb First[T]) string { return "first" }
                func Add(cb Second[T]) string { return "second" }
            }

            func Always(value int32) bool { return true }

            func Main() {
                let keepAlive Action = () -> { }
                let first First[int32] = Always
                let second Second[int32] = Always
                let overloads = NamedOverloads[int32]()
                Console.WriteLine(overloads.Add(first))
                Console.WriteLine(overloads.Add(second))
                keepAlive()
            }
            """;

        Assert.Equal(
            $"first{Environment.NewLine}second{Environment.NewLine}",
            CompileVerifyLoadAndRun(source, expectedSourceTypeName: string.Empty));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public void Issue3874_StructuralArguments_RemainAmbiguous(bool funcFirst, bool methodGroup)
    {
        var overloads = funcFirst
            ? """
                func Add(cb Func[T, bool]) string { return "func" }
                func Add(cb Predicate[T]) string { return "pred" }
                """
            : """
                func Add(cb Predicate[T]) string { return "pred" }
                func Add(cb Func[T, bool]) string { return "func" }
                """;
        var argument = methodGroup ? "Always" : "(value int32) -> true";
        var source = $$"""
            package Issue3874StructuralAmbiguity
            import System

            class Overloads[T] {
            {{overloads}}
            }

            func Always(value int32) bool { return true }

            Console.WriteLine(Overloads[int32]().Add({{argument}}))
            """;

        var diagnostics = CompileExpectingFailure(source);
        Assert.Contains("GS0266", diagnostics, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void NominalDelegateDisagreement_PreservesConstructorOverloadResolution(bool topLevel)
    {
        const string declarations = """
            package Issue2948ConstructorNominalDisagreement
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }
            """;

        const string statements = """
            let constructed = ConstructorDelegateOverloads[Src](
                (item) -> true)
            Console.WriteLine(constructed.Kind)
            """;

        Assert.Equal(
            $"func{Environment.NewLine}",
            CompileVerifyLoadAndRun(
                WithExecutionScope(declarations, statements, topLevel),
                expectedSourceTypeName: null,
                allowDirectObjectParameter: true));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CorpusJoinLetConstruct_ResolvesDelegateAndExpressionTargets(bool topLevel)
    {
        const string declarations = """
            package Issue2948CorpusJoinLet
            import System
            import System.Linq

            data class Owner(Id int32, Name string) {
            }

            data class Pet(Name string, OwnerId int32) {
            }
            """;

        const string statements = """
            let owners []Owner = []Owner{Owner(1, "ada"), Owner(2, "bea")}
            let pets []Pet = []Pet{Pet("rex", 2), Pet("tom", 1)}
            let matched = owners.Join(
                pets,
                (o Owner) -> o.Id,
                (p Pet) -> p.OwnerId,
                (o Owner, p Pet) -> { return (o, p) })
            Console.WriteLine(matched.Count())
            """;

        Assert.Equal(
            $"2{Environment.NewLine}",
            CompileVerifyLoadAndRun(
                WithExecutionScope(declarations, statements, topLevel),
                "Issue2948CorpusJoinLet.Owner"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CorpusJoinResultSelectorLetConstruct_VerifyLoadAndRun(bool topLevel)
    {
        const string declarations = """
            package Issue2948CorpusJoinResult
            import System
            import System.Linq

            data class Owner(Id int32, Name string) {
            }

            data class Pet(Name string, OwnerId int32) {
            }
            """;

        const string statements = """
            let owners []Owner = []Owner{Owner(1, "ada"), Owner(2, "bea")}
            let pets []Pet = []Pet{Pet("rex", 2), Pet("tom", 1)}
            let matched = owners.Join(
                pets,
                (o Owner) -> o.Id,
                (p Pet) -> p.OwnerId,
                (o Owner, p Pet) -> o.Name + "+" + p.Name)
            Console.WriteLine(String.Join(",", matched!!))
            """;

        Assert.Equal(
            $"ada+tom,bea+rex{Environment.NewLine}",
            CompileVerifyLoadAndRun(
                WithExecutionScope(declarations, statements, topLevel),
                "Issue2948CorpusJoinResult.Owner"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CorpusJoinChainedSelectAndWriteLine_VerifyLoadAndRun(bool topLevel)
    {
        const string declarations = """
            package Issue2948CorpusJoinChain
            import System
            import System.Linq

            data class Owner(Id int32, Name string) {
            }

            data class Pet(Name string, OwnerId int32) {
            }
            """;

        const string statements = """
            let owners []Owner = []Owner{Owner(1, "ada"), Owner(2, "bea"), Owner(3, "cid")}
            let pets []Pet = []Pet{Pet("rex", 2), Pet("tom", 1), Pet("ziggy", 2)}
            let matched = owners.Join(pets, (o Owner) -> o.Id, (p Pet) -> p.OwnerId, (o Owner, p Pet) -> {
                return (o, p)
            }).Select((pair (Owner, Pet)) -> {
                let (o, p) = pair
                return "${o.Name}+${p.Name}"
            })
            Console.WriteLine("JoinClause: matched=${String.Join(",", matched!!)}")
            """;

        Assert.Equal(
            $"JoinClause: matched=ada+tom,bea+rex,bea+ziggy{Environment.NewLine}",
            CompileVerifyLoadAndRun(
                WithExecutionScope(declarations, statements, topLevel),
                "Issue2948CorpusJoinChain.Owner"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CanonicalLinqSelectorsOverErasedUserTypes_VerifyLoadAndRun(bool topLevel)
    {
        const string declarations = """
            package Issue2948CanonicalLinqSelectors
            import System
            import System.Collections.Generic
            import System.Linq

            interface IEntry {
                prop Size int64 {
                    get;
                }
            }

            class Entry : IEntry {
                prop Size int64 {
                    get;
                    init;
                }

                init(size int64) { Size = size }
            }

            func Total(entries List[IEntry]) int64 ->
                int64(8) + entries.Sum(
                    (entry IEntry) -> entry.Size)
            """;

        const string statements = """
            let entries = List[IEntry]{
                Entry(11),
                Entry(22),
                Entry(33)
            }
            Console.WriteLine(Total(entries))
            """;

        Assert.Equal(
            $"74{Environment.NewLine}",
            CompileVerifyLoadAndRun(
                WithExecutionScope(declarations, statements, topLevel),
                "Issue2948CanonicalLinqSelectors.IEntry",
                useRefPackReferences: true));
    }

    [Fact]
    public void ImportedNamedDelegatesThroughErasedListSlots_VerifyLoadAndRun()
    {
        const string source = """
            package Issue2948NamedDelegateLists
            import System
            import System.Collections.Generic
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            class Args : EventArgs {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let predicates = List[Predicate[Src]]()
                predicates.Add((item) -> item.N > 2)
                Console.WriteLine(predicates[0](Src(3)))

                let comparisons = List[Comparison[Src]]()
                comparisons.Add((left Src, right Src) -> left.N - right.N)
                Console.WriteLine(comparisons[0](Src(5), Src(2)))

                let converters = List[Converter[Src, int32]]()
                converters.Add((item Src) -> item.N + 10)
                Console.WriteLine(converters[0](Src(4)))

                let events = List[EventHandler[Args]]()
                events.Add((sender object?, args Args) -> Console.WriteLine(args.N))
                events[0](nil, Args(4))

                let custom = List[CustomPredicate[Src]]()
                custom.Add((item Src) -> item.N == 6)
                Console.WriteLine(custom[0](Src(6)))
            }
            """;

        Assert.Equal(
            $"True{Environment.NewLine}3{Environment.NewLine}14{Environment.NewLine}4{Environment.NewLine}True{Environment.NewLine}",
            CompileVerifyLoadAndRun(
                source,
                "Issue2948NamedDelegateLists.Src",
                allowDirectObjectParameter: true));
    }

    [Fact]
    public void ImportedNamedDelegatesThroughErasedConstructorSlots_VerifyLoadAndRun()
    {
        const string source = """
            package Issue2948NamedDelegateConstructors
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let predicate = DelegateBox[Predicate[Src]](
                    (item) -> item.N > 2)
                Console.WriteLine(predicate.RuntimeTypeName)
                Console.WriteLine(predicate.Value!!(Src(3)))

                let comparison = DelegateBox[Comparison[Src]](
                    (left Src, right Src) -> left.N - right.N)
                Console.WriteLine(comparison.RuntimeTypeName)
                Console.WriteLine(comparison.Value!!(Src(5), Src(2)))

                let converter = DelegateBox[Converter[Src, int32]](
                    (item Src) -> item.N + 10)
                Console.WriteLine(converter.RuntimeTypeName)
                Console.WriteLine(converter.Value!!(Src(4)))

                let custom = DelegateBox[CustomPredicate[Src]](
                    (item Src) -> item.N == 6)
                Console.WriteLine(custom.RuntimeTypeName)
                Console.WriteLine(custom.Value!!(Src(6)))
            }
            """;

        Assert.Equal(
            """
            System.Predicate`1
            True
            System.Comparison`1
            3
            System.Converter`2
            14
            Issue2918Contracts.CustomPredicate`1
            True

            """.ReplaceLineEndings(Environment.NewLine),
            CompileVerifyLoadAndRun(source, "Issue2948NamedDelegateConstructors.Src"));
    }

    [Fact]
    public void SameFullNameDelegateFromUserAssembly_RetainsAssemblyIdentity()
    {
        const string source = """
            package Issue2948AssemblyIdentity
            import System
            import Issue2948Collision

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let callbacks = Factory.Create[Src]()
                callbacks.Add((left Src, right Src) -> left.N + right.N)
                Console.WriteLine(Factory.DelegateAssemblyName(callbacks))
                Console.WriteLine(
                    Factory.InvokeFirst(callbacks, Src(20), Src(22)))
            }
            """;

        Assert.Equal(
            $"Issue2948CollisionContracts{Environment.NewLine}42{Environment.NewLine}",
            CompileVerifyLoadAndRun(
                source,
                "Issue2948AssemblyIdentity.Src",
                contractsSource: AssemblyCollisionContracts,
                contractsAssemblyName: "Issue2948CollisionContracts"));
    }

    [Fact]
    public void HoistedImportedPredicateThroughGenericConstructor_RetainsDelegateIdentity()
    {
        const string source = """
            package Issue2918PredicateHoisted
            import System
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            func Main() {
                let predicate Predicate[Src] = (item Src) -> item.N > 2
                let box = DelegateBox[Predicate[Src]](predicate)
                Console.WriteLine(box.RuntimeTypeName)
                Console.WriteLine(box.Value!!(Src(3)))
            }
            """;

        Assert.Equal(
            $"System.Predicate`1{Environment.NewLine}True{Environment.NewLine}",
            CompileVerifyLoadAndRun(
                source,
                "Issue2918PredicateHoisted.Src",
                verifyIl: false));
    }

    [Fact]
    public void PublicLibraryDelegateSignatures_RoundTripThroughCSharp()
    {
        var directory = CreateDirectory("Issue2918_PublicApi_");
        try
        {
            var librarySourcePath = Path.Combine(directory, "library.gs");
            var libraryPath = Path.Combine(directory, "Issue2918PublicApi.dll");
            File.WriteAllText(librarySourcePath, """
                package Issue2918PublicApi
                import System
                import System.Collections.Generic

                class Src {
                    let N int32
                    init(n int32) { N = n }
                }

                class Api {
                    shared {
                        func Callbacks() List[System.Action[Src]] {
                            let callbacks = List[System.Action[Src]]()
                            callbacks.Add((item Src) -> Console.WriteLine(item.N))
                            return callbacks
                        }

                        func Transforms() Dictionary[string, System.Func[Src, int32]] {
                            let transforms =
                                Dictionary[string, System.Func[Src, int32]]()
                            transforms.Add("value", (item Src) -> item.N)
                            return transforms
                        }
                    }
                }
                """);
            Compile(
            [
                "/out:" + libraryPath,
                "/target:library",
                "/targetframework:net10.0",
                librarySourcePath,
            ]);
            IlVerifier.Verify(libraryPath);

            var consumerPath = Path.Combine(directory, "consumer.dll");
            CompileCSharp(
                """
                using System;
                using System.Collections.Generic;
                using Issue2918PublicApi;

                namespace Consumer;

                public static class Runner
                {
                    public static int Run()
                    {
                        List<Action<Src>> callbacks = Api.Callbacks();
                        Dictionary<string, Func<Src, int>> transforms = Api.Transforms();
                        return callbacks.Count + transforms["value"](new Src(41));
                    }
                }
                """,
                consumerPath,
                "Issue2918CSharpConsumer",
                libraryPath);
            IlVerifier.Verify(consumerPath, additionalReferences: new[] { libraryPath });

            var loadContext = new AssemblyLoadContext(
                "Issue2918_PublicApi_" + Guid.NewGuid().ToString("N"),
                isCollectible: true);
            try
            {
                var library = loadContext.LoadFromAssemblyPath(libraryPath);
                loadContext.Resolving += (_, name) =>
                    name.Name == library.GetName().Name ? library : null;
                Assert.NotEmpty(library.GetTypes());

                var consumer = loadContext.LoadFromAssemblyPath(consumerPath);
                Assert.NotEmpty(consumer.GetTypes());
                var run = consumer.GetType("Consumer.Runner")!.GetMethod("Run")!;
                Assert.Equal(42, run.Invoke(null, null));
            }
            finally
            {
                loadContext.Unload();
            }
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Fact]
    public void ExistingDelegateTargetingControls_RemainValid_VerifyLoadAndRun()
    {
        const string source = """
            package Issue2918Guards
            import System
            import System.Collections.Generic
            import System.Linq
            import Issue2918Contracts

            class Src {
                let N int32
                init(n int32) { N = n }
            }

            class Box[T any] {
                var Value T
                init(value T) { Value = value }
                func Put(value T) { Value = value }
            }

            func PrintSrc(item Src) { Console.WriteLine(item.N) }
            func Identity[T](value T) T -> value

            func Main() {
                let arrayCallbacks []System.Action[Src] = []System.Action[Src]{
                    (item Src) -> Console.WriteLine(item.N)
                }
                arrayCallbacks[0](Src(5))

                let pair (System.Action[Src], int32) = (
                    (item Src) -> Console.WriteLine(item.N),
                    0)
                let (pairCallback, _) = pair
                pairCallback(Src(6))

                let sourceBox = Box[System.Action[Src]](
                    (item Src) -> Console.WriteLine(item.N))
                sourceBox.Put((item Src) -> Console.WriteLine(item.N))
                sourceBox.Value(Src(7))

                let items = List[Src]{ Src(9) }
                items.ForEach((item Src) -> Console.WriteLine(item.N))

                let seed System.Action[Src] = PrintSrc
                let indexed = Slot[System.Action[Src]](seed)
                indexed[0] = (item Src) -> Console.WriteLine(item.N)
                let indexedHandler System.Action[Src] = indexed.Get()
                indexedHandler(Src(11))

                Identity[System.Action[Src]](
                    (item Src) -> Console.WriteLine(item.N))(Src(14))

                GenericSink.M[System.Action[Src]](
                    (item Src) -> Console.WriteLine(item.N))
                GenericSink.InvokeLast(Src(15))

                let groups = List[System.Action[Src]]()
                groups.Add(PrintSrc)
                groups[0](Src(21))

                let hoisted System.Action[Src] =
                    (item Src) -> Console.WriteLine(item.N)
                let hoistedList = List[System.Action[Src]]()
                hoistedList.Add(hoisted)
                hoistedList[0](Src(22))

                Console.WriteLine(
                    List[Src]{ Src(23) }
                        .Where((item Src) -> item.N > 0)
                        .Single()
                        .N)

                let values = List[Src]{ Src(24) }
                var enumerator List[Src].Enumerator = values.GetEnumerator()
                if enumerator.MoveNext() {
                    Console.WriteLine(enumerator.Current.N)
                }

                let applied = Slot[System.Action[Src]](seed)
                applied.Apply(
                    (callback System.Action[Src]) -> callback(Src(25)))
            }
            """;

        Assert.Equal(
            $"5{Environment.NewLine}6{Environment.NewLine}7{Environment.NewLine}9{Environment.NewLine}11{Environment.NewLine}14{Environment.NewLine}15{Environment.NewLine}21{Environment.NewLine}22{Environment.NewLine}23{Environment.NewLine}24{Environment.NewLine}25{Environment.NewLine}",
            CompileVerifyLoadAndRun(source, "Issue2918Guards.Src"));
    }

    [Fact]
    public void IlVerifier_RejectsDeliberatelyBrokenAssembly()
    {
        var directory = CreateDirectory("Issue2918_BrokenIl_");
        try
        {
            var validPath = Path.Combine(directory, "valid.dll");
            CompileCSharp(
                """
                public static class BrokenProbe
                {
                    public static int Broken() => 1;
                }
                """,
                validPath,
                "Issue2918BrokenProbe");

            var brokenPath = Path.Combine(directory, "broken.dll");
            var bytes = File.ReadAllBytes(validPath);
            using (var peReader = new PEReader(new MemoryStream(bytes, writable: false)))
            {
                var metadata = peReader.GetMetadataReader();
                var method = metadata.MethodDefinitions
                    .Select(metadata.GetMethodDefinition)
                    .Single(definition => metadata.GetString(definition.Name) == "Broken");
                var section = peReader.PEHeaders.SectionHeaders.Single(header =>
                    method.RelativeVirtualAddress >= header.VirtualAddress
                    && method.RelativeVirtualAddress < header.VirtualAddress + header.VirtualSize);
                var bodyOffset = method.RelativeVirtualAddress
                    - section.VirtualAddress
                    + section.PointerToRawData;
                var header = bytes[bodyOffset];
                var codeOffset = (header & 0x3) == 0x2
                    ? bodyOffset + 1
                    : bodyOffset
                        + ((BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(bodyOffset, 2)) >> 12) * 4);
                bytes[codeOffset] = 0x2A;
            }

            File.WriteAllBytes(brokenPath, bytes);
            var error = Assert.Throws<XunitException>(() => IlVerifier.Verify(brokenPath));
            Assert.Contains("invalid IL", error.Message, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static string WithExecutionScope(
        string declarations,
        string statements,
        bool topLevel) =>
        topLevel
            ? declarations + "\n" + statements
            : declarations + "\nfunc Main() {\n" + statements + "\n}";

    private static string CompileVerifyLoadAndRun(
        string source,
        string expectedSourceTypeName,
        bool verifyIl = true,
        string contractsSource = Contracts,
        string contractsAssemblyName = "Issue2918Contracts",
        bool allowDirectObjectParameter = false,
        bool useRefPackReferences = false)
    {
        var directory = CreateDirectory("Issue2918_");
        try
        {
            var contractsPath = Path.Combine(directory, contractsAssemblyName + ".dll");
            CompileCSharp(contractsSource, contractsPath, contractsAssemblyName);
            IlVerifier.Verify(contractsPath);

            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            var args = new List<string>
            {
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
            };
            if (useRefPackReferences)
            {
                args.AddRange(RefPackReferences().Select(reference => "/r:" + reference));
            }

            args.Add("/r:" + contractsPath);
            args.Add(sourcePath);
            Compile(args.ToArray());

            if (verifyIl)
            {
                IlVerifier.Verify(assemblyPath, additionalReferences: new[] { contractsPath });
            }

            AssertLoadsWithReifiedLambdaSignatures(
                assemblyPath,
                contractsPath,
                expectedSourceTypeName,
                allowDirectObjectParameter);
            return Run(assemblyPath, directory);
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static void AssertLoadsWithReifiedLambdaSignatures(
        string assemblyPath,
        string contractsPath,
        string expectedSourceTypeName,
        bool allowDirectObjectParameter = false)
    {
        Assert.NotEmpty(EmittedFixture.Load(contractsPath).GetTypes());
        Assert.NotEmpty(EmittedFixture.Load(assemblyPath).GetTypes());

        var loadContext = new AssemblyLoadContext(
            "Issue2918_" + Guid.NewGuid().ToString("N"),
            isCollectible: true);
        try
        {
            var contracts = loadContext.LoadFromAssemblyPath(contractsPath);
            loadContext.Resolving += (_, name) =>
                name.Name == contracts.GetName().Name ? contracts : null;
            Assert.NotEmpty(contracts.GetTypes());

            var assembly = loadContext.LoadFromAssemblyPath(assemblyPath);
            var types = assembly.GetTypes();
            Assert.NotEmpty(types);
            var lambdas = types
                .SelectMany(type => type.GetMethods(
                    BindingFlags.Public
                    | BindingFlags.NonPublic
                    | BindingFlags.Static
                    | BindingFlags.Instance))
                .Where(method =>
                    method.Name.Contains("<lambda", StringComparison.Ordinal)
                    || method.DeclaringType?.FullName?.Contains("<closure", StringComparison.Ordinal) == true)
                .ToArray();
            Assert.NotEmpty(lambdas);

            var signatures = string.Join(
                "\n",
                lambdas.Select(method =>
                    method.ReturnType + "("
                    + string.Join(",", method.GetParameters().Select(parameter => parameter.ParameterType))
                    + ")"));
            if (!string.IsNullOrEmpty(expectedSourceTypeName))
            {
                Assert.Contains(expectedSourceTypeName, signatures, StringComparison.Ordinal);
            }
            Assert.DoesNotContain(
                lambdas,
                method =>
                    ContainsObjectGenericArgument(method.ReturnType)
                    || method.GetParameters().Any(parameter =>
                        ContainsObjectGenericArgument(parameter.ParameterType)
                        && !(allowDirectObjectParameter
                            && parameter.ParameterType == typeof(object))));
        }
        finally
        {
            loadContext.Unload();
        }
    }

    private static bool ContainsObjectGenericArgument(Type type)
    {
        if (type == typeof(object))
        {
            return true;
        }

        return type.IsArray
            ? ContainsObjectGenericArgument(type.GetElementType())
            : type.IsGenericType
                && type.GetGenericArguments().Any(ContainsObjectGenericArgument);
    }

    private static string Run(string assemblyPath, string directory)
    {
        var runtimeConfigPath = Path.ChangeExtension(assemblyPath, ".runtimeconfig.json");
        if (!File.Exists(runtimeConfigPath))
        {
            File.WriteAllText(runtimeConfigPath, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);
        }

        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = directory,
        };
        startInfo.ArgumentList.Add("exec");
        startInfo.ArgumentList.Add("--runtimeconfig");
        startInfo.ArgumentList.Add(runtimeConfigPath);
        startInfo.ArgumentList.Add(assemblyPath);

        var (exitCode, stdout, stderr) = IlVerifier.RunProcess(startInfo, assemblyPath, 30_000);
        Assert.True(
            exitCode == 0,
            $"dotnet exec exited {exitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }

    private static void Compile(string[] args)
    {
        var (exitCode, output) = RunCompiler(args);
        Assert.True(exitCode == 0, $"gsc failed:\n{output}");
    }

    private static string CompileExpectingFailure(string source)
    {
        var directory = CreateDirectory("Issue2918_Rejected_");
        try
        {
            var contractsPath = Path.Combine(directory, "Issue2918Contracts.dll");
            CompileCSharp(Contracts, contractsPath, "Issue2918Contracts");

            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            var (exitCode, output) = RunCompiler(
            [
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                "/r:" + contractsPath,
                sourcePath,
            ]);

            Assert.NotEqual(0, exitCode);
            return output;
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static string CompileExpectingFailureOrReportingRuntimeOutput(string source)
    {
        var directory = CreateDirectory("Issue2948_Ambiguous_");
        try
        {
            var contractsPath = Path.Combine(directory, "Issue2918Contracts.dll");
            CompileCSharp(Contracts, contractsPath, "Issue2918Contracts");

            var sourcePath = Path.Combine(directory, "test.gs");
            var assemblyPath = Path.Combine(directory, "test.dll");
            File.WriteAllText(sourcePath, source);
            var (exitCode, output) = RunCompiler(
            [
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                "/nowarn:GS9100",
                "/r:" + contractsPath,
                sourcePath,
            ]);

            if (exitCode == 0)
            {
                IlVerifier.Verify(assemblyPath, additionalReferences: new[] { contractsPath });
                Assert.NotEmpty(EmittedFixture.Load(contractsPath).GetTypes());
                Assert.NotEmpty(EmittedFixture.Load(assemblyPath).GetTypes());
                var runtimeOutput = Run(assemblyPath, directory);
                throw new XunitException(
                    "Expected ambiguous delegate overloads to be rejected, "
                    + $"but the program ran with output:\n{runtimeOutput}");
            }

            return output;
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static (int ExitCode, string Output) RunCompiler(string[] args)
    {
        using var stdoutWriter = new StringWriter();
        using var stderrWriter = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(stdoutWriter);
        Console.SetError(stderrWriter);
        int exitCode;
        try
        {
            exitCode = Program.Main(args);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return (exitCode, stdoutWriter.ToString() + stderrWriter.ToString());
    }

    private static void CompileCSharp(
        string source,
        string outputPath,
        string assemblyName,
        params string[] additionalReferences)
    {
        var syntaxTree = CSharpSyntaxTree.ParseText(source);
        var references = ((AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)
                ?.Split(Path.PathSeparator)
                ?? Array.Empty<string>())
            .Where(File.Exists)
            .Select(path => (MetadataReference)MetadataReference.CreateFromFile(path))
            .Concat(additionalReferences.Select(path =>
                (MetadataReference)MetadataReference.CreateFromFile(path)));
        var compilation = CSharpCompilation.Create(
            assemblyName,
            new[] { syntaxTree },
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var stream = File.Create(outputPath);
        var result = compilation.Emit(stream);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static string CreateDirectory(string prefix)
    {
        var directory = Path.Combine(
            AppContext.BaseDirectory,
            prefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static IEnumerable<string> RefPackReferences()
    {
        var runtimeDirectory = Path.GetDirectoryName(typeof(object).Assembly.Location);
        var dotnetRoot = Directory.GetParent(runtimeDirectory)?.Parent?.Parent?.FullName;
        var tfm = $"net{Environment.Version.Major}.0";
        var packsRoot = Path.Combine(dotnetRoot!, "packs", "Microsoft.NETCore.App.Ref");
        var version = Environment.Version.ToString(3);
        var referenceDirectory = Path.Combine(packsRoot, version, "ref", tfm);
        if (!Directory.Exists(referenceDirectory))
        {
            referenceDirectory = Directory.EnumerateDirectories(
                    packsRoot,
                    Environment.Version.Major + ".*")
                .OrderByDescending(directory => directory, StringComparer.Ordinal)
                .Select(directory => Path.Combine(directory, "ref", tfm))
                .FirstOrDefault(Directory.Exists);
        }

        Assert.False(
            string.IsNullOrEmpty(referenceDirectory),
            $"No {tfm} reference pack found under '{packsRoot}'.");
        return Directory.EnumerateFiles(referenceDirectory!, "*.dll");
    }

    private static void DeleteDirectory(string directory)
    {
        for (var attempt = 0; attempt < 3 && Directory.Exists(directory); attempt++)
        {
            try
            {
                Directory.Delete(directory, recursive: true);
            }
            catch (IOException) when (attempt < 2)
            {
                System.Threading.Thread.Sleep(50);
            }
            catch (UnauthorizedAccessException) when (attempt < 2)
            {
                System.Threading.Thread.Sleep(50);
            }
        }

        Assert.False(Directory.Exists(directory), $"Failed to delete '{directory}'.");
    }
}
