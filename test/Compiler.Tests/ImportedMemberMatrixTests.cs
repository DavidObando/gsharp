// <copyright file="ImportedMemberMatrixTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Xunit;

namespace GSharp.Compiler.Tests;

public class ImportedMemberMatrixTests
{
    private const string Issue3076CsSource = """
        namespace Issue3076.CSharp
        {
            public static class Issue3076GenericStaticSlot<T>
            {
                public static int Property { get; set; }
                public static int Field;
                public static string? TextProperty { get; set; }
                public static string? TextField;

                public static int ReadProperty() => Property;
                public static int ReadField() => Field;
            }

            public static class Issue3076GenericPairSlot<TFirst, TSecond>
            {
                public static int Property { get; set; }
                public static int Field;
            }

            public sealed class Issue3076GenericBox<T>
            {
            }

            public static class Issue3076PlainStaticSlot
            {
                public static int Property { get; set; }
                public static int Field;
            }

            public static class Issue3076AsyncValues
            {
                public static System.Threading.Tasks.Task<int> Get(int value)
                    => System.Threading.Tasks.Task.FromResult(value);
            }
        }
        """;

    [Theory]
    [InlineData(false, "301\n302\n311\n312\n321\n322\n331\n332\n341\n342\n351\n352\n")]
    [InlineData(true, "201\n202\n211\n212\n121\n122\n221\n222\n231\n232\n241\n242\n")]
    public void Issue3076_GenericStaticClrStores_CompileAndRun(bool throughTypeParameter, string expected)
    {
        var source = Issue3076Source("Issue3076.CSharp", throughTypeParameter);
        Assert.Equal(expected, CompileAndRunWithSiblingCs(Issue3076CsSource, source, "Issue3076.CSharp"));
    }

    [Fact]
    public void Issue3076_GenericStaticClrStores_PreserveContainerThroughSideEffectSpilling()
    {
        const string source = """
            import Issue3076.CSharp
            import System

            func PropertyMarker() int32 { return 401 }
            func FieldMarker() int32 { return 402 }

            func Store[T]() {
                Issue3076GenericStaticSlot[T].Property = PropertyMarker()
                Issue3076GenericStaticSlot[T].Field = FieldMarker()
            }

            Issue3076GenericStaticSlot[int32].Property = 101
            Issue3076GenericStaticSlot[int32].Field = 102
            Issue3076GenericStaticSlot[object].Property = 121
            Issue3076GenericStaticSlot[object].Field = 122
            Store[int32]()
            Console.WriteLine(Issue3076GenericStaticSlot[int32].Property)
            Console.WriteLine(Issue3076GenericStaticSlot[int32].Field)
            Console.WriteLine(Issue3076GenericStaticSlot[object].Property)
            Console.WriteLine(Issue3076GenericStaticSlot[object].Field)
            """;

        Assert.Equal(
            $"401{Environment.NewLine}402{Environment.NewLine}121{Environment.NewLine}122{Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue3076CsSource, source, "Issue3076.CSharp"));
    }

    [Fact]
    public void Issue3076_GenericStaticClrStores_PreserveContainerThroughNullCoalescingAssignment()
    {
        const string source = """
            import Issue3076.CSharp
            import System

            func StoreIfMissing[T]() {
                Issue3076GenericStaticSlot[T].TextProperty ??= "property"
                Issue3076GenericStaticSlot[T].TextField ??= "field"
            }

            Issue3076GenericStaticSlot[int32].TextProperty = nil
            Issue3076GenericStaticSlot[int32].TextField = nil
            Issue3076GenericStaticSlot[object].TextProperty = "object-property"
            Issue3076GenericStaticSlot[object].TextField = "object-field"
            StoreIfMissing[int32]()
            Console.WriteLine(Issue3076GenericStaticSlot[int32].TextProperty)
            Console.WriteLine(Issue3076GenericStaticSlot[int32].TextField)
            Console.WriteLine(Issue3076GenericStaticSlot[object].TextProperty)
            Console.WriteLine(Issue3076GenericStaticSlot[object].TextField)
            """;

        Assert.Equal(
            $"property{Environment.NewLine}field{Environment.NewLine}object-property{Environment.NewLine}object-field{Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue3076CsSource, source, "Issue3076.CSharp"));
    }

    [Fact]
    public void Issue3076_GenericStaticClrStores_PreserveContainerThroughAsyncSpilling()
    {
        const string source = """
            import Issue3076.CSharp
            import System

            async func StoreAsync[T]() {
                Issue3076GenericStaticSlot[T].Property = await Issue3076AsyncValues.Get(501)
                Issue3076GenericStaticSlot[T].Field = await Issue3076AsyncValues.Get(502)
            }

            Issue3076GenericStaticSlot[int32].Property = 101
            Issue3076GenericStaticSlot[int32].Field = 102
            Issue3076GenericStaticSlot[object].Property = 121
            Issue3076GenericStaticSlot[object].Field = 122
            StoreAsync[int32]().GetAwaiter().GetResult()
            Console.WriteLine(Issue3076GenericStaticSlot[int32].Property)
            Console.WriteLine(Issue3076GenericStaticSlot[int32].Field)
            Console.WriteLine(Issue3076GenericStaticSlot[object].Property)
            Console.WriteLine(Issue3076GenericStaticSlot[object].Field)
            """;

        Assert.Equal(
            $"501{Environment.NewLine}502{Environment.NewLine}121{Environment.NewLine}122{Environment.NewLine}",
            CompileAndRunWithSiblingCs(Issue3076CsSource, source, "Issue3076.CSharp"));
    }

    [Theory]
    [InlineData(false, "301\n302\n311\n312\n321\n322\n331\n332\n341\n342\n351\n352\n")]
    [InlineData(true, "201\n202\n211\n212\n121\n122\n221\n222\n231\n232\n241\n242\n")]
    public void Issue3076_GenericStaticClrStores_Evaluate(bool throughTypeParameter, string expected)
    {
        var workDir = CreateWorkDir("issue3076_evaluate_");
        try
        {
            var sourcePath = Path.Combine(workDir, "test.gs");
            File.WriteAllText(sourcePath, Issue3076Source("GSharp.Compiler.Tests", throughTypeParameter));

            var (exitCode, output) = RunCompiler(new[] { sourcePath });

            Assert.Equal(0, exitCode);
            Assert.Equal(expected + $"Success.{Environment.NewLine}", output.ReplaceLineEndings(Environment.NewLine));
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    [Fact]
    public void ImportedMemberMatrix_GenericImportedInterfaceMethodAndInterfaceObjectMembers_CompileAndRun()
    {
        const string csSource = """
            namespace ImportedMemberMatrix.CSharp
            {
                public interface IStore
                {
                    void Put<T>(T value);
                }

                public interface IHasDefault
                {
                    int Ping() => 7;
                }

                public sealed class DefaultThing : IHasDefault
                {
                    public override string ToString() => "thing";
                }
            }
            """;

        const string gsSource = """
            package ImportedMemberMatrix.Probe
            import ImportedMemberMatrix.CSharp
            import System

            class Store : IStore {
                func Put[T](value T) { Console.WriteLine(value.ToString()) }
            }

            var store IStore = Store()
            store.Put[int32](42)
            store.Put[string]("ok")

            var thing IHasDefault = DefaultThing()
            Console.WriteLine(thing.Ping())
            Console.WriteLine(thing.ToString())
            Console.WriteLine(thing.GetHashCode() == thing.GetHashCode())
            Console.WriteLine(thing.Equals(thing))
            """;

        Assert.Equal($"42{Environment.NewLine}ok{Environment.NewLine}7{Environment.NewLine}thing{Environment.NewLine}True{Environment.NewLine}True{Environment.NewLine}", CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp"));
    }

    [Fact]
    public void ImportedMemberMatrix_LinqExtensionsOnImportedGenericEnumerableReceivers_CompileAndRun()
    {
        const string csSource = """
            namespace ImportedMemberMatrix.CSharp
            {
                public sealed class Item
                {
                    public string Name { get; set; } = "";
                    public int Rank { get; set; }
                }
            }
            """;

        const string gsSource = """
            package ImportedMemberMatrix.Probe
            import ImportedMemberMatrix.CSharp
            import System
            import System.Collections.Generic
            import System.Linq

            var xs = List[Item]()
            var b = Item()
            b.Name = "b"
            b.Rank = 2
            xs.Add(b)
            var a = Item()
            a.Name = "a"
            a.Rank = 1
            xs.Add(a)

            var collection ICollection[Item] = xs
            var enumerable IEnumerable[Item] = collection
            Console.WriteLine(enumerable.FirstOrDefault() == nil)
            Console.WriteLine(collection.Any())
            Console.WriteLine(enumerable.Count())
            Console.WriteLine(enumerable.Where(func(i Item) bool { return i.Rank > 0 }).Count())
            Console.WriteLine(enumerable.OrderBy(func(i Item) int32 { return i.Rank }).Count())
            """;

        Assert.Equal($"False{Environment.NewLine}True{Environment.NewLine}2{Environment.NewLine}2{Environment.NewLine}2{Environment.NewLine}", CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp"));
    }

    [Fact]
    public void ImportedMemberMatrix_ImportedRecordClassAndRecordStruct_WithCopy_CompileAndRun()
    {
        const string csSource = """
            namespace ImportedMemberMatrix.CSharp
            {
                public record PersonRecord(string Name, int Age);
                public readonly record struct PointRecord(int X, int Y);
            }
            """;

        const string gsSource = """
            package ImportedMemberMatrix.Probe
            import ImportedMemberMatrix.CSharp
            import System

            var p = PersonRecord("ana", 1)
            var p2 = p with { Age = 2 }
            Console.WriteLine(p.Name)
            Console.WriteLine(p.Age)
            Console.WriteLine(p2.Name)
            Console.WriteLine(p2.Age)

            var pt = PointRecord(3, 4)
            var pt2 = pt with { Y = 9 }
            Console.WriteLine(pt.X)
            Console.WriteLine(pt.Y)
            Console.WriteLine(pt2.X)
            Console.WriteLine(pt2.Y)
            """;

        Assert.Equal($"ana{Environment.NewLine}1{Environment.NewLine}ana{Environment.NewLine}2{Environment.NewLine}3{Environment.NewLine}4{Environment.NewLine}3{Environment.NewLine}9{Environment.NewLine}", CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp"));
    }

    [Fact]
    public void ImportedMemberMatrix_SourceOnlyDataAndLinqReceivers_StillBind()
    {
        const string source = """
            package ImportedMemberMatrix.SourceOnly
            import System
            import System.Collections.Generic
            import System.Linq

            data class SourceItem(Name string, Rank int32) {}

            var item = SourceItem("a", 1)
            var updated = item with { Name = "b" }
            Console.WriteLine(item.Name)
            Console.WriteLine(updated.Name)

            var xs = List[SourceItem]()
            xs.Add(item)
            xs.Add(updated)
            Console.WriteLine(xs.FirstOrDefault().Name)
            Console.WriteLine(xs.Where(func(i SourceItem) bool { return i.Rank == 1 }).Count())
            Console.WriteLine(xs.OrderBy(func(i SourceItem) string { return i.Name }).Count())
            """;

        Assert.Equal($"a{Environment.NewLine}b{Environment.NewLine}a{Environment.NewLine}2{Environment.NewLine}2{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void ImportedMemberMatrix_NonDataImportedClass_WithCopy_StillRejected()
    {
        const string csSource = """
            namespace ImportedMemberMatrix.CSharp
            {
                public sealed class PlainClass
                {
                    public string Name { get; set; } = "";
                }
            }
            """;

        const string gsSource = """
            package ImportedMemberMatrix.Probe
            import ImportedMemberMatrix.CSharp

            var value = PlainClass()
            value.Name = "before"
            var copy = value with { Name = "after" }
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(csSource, gsSource, "ImportedMemberMatrix.CSharp");
        Assert.Contains(diagnostics, d => d.Contains("GS0161", StringComparison.Ordinal));
        Assert.Contains(diagnostics, d => d.Contains("data class or data struct", StringComparison.Ordinal));
    }

    [Fact]
    public void ImportedMemberMatrix_OptionalDefaults_AreResolvedAndEmittedAcrossCallableKinds()
    {
        const string csSource = """
            using System;
            using System.Reflection;
            using System.Runtime.CompilerServices;
            using System.Runtime.InteropServices;
            using System.Threading;

            namespace ImportedOptional.CSharp
            {
                public enum Tone { First = 1, Second = 2 }

                public record ProgressMessage(int Count, string Text = "ready");

                public delegate string OptionalDelegate(bool enabled = true);

                public sealed class OptionalApi
                {
                    private readonly int seed;
                    private string? indexed;

                    public OptionalApi(int seed, int add = 5) => this.seed = seed + add;

                    public int Instance(int value = 7) => seed + value;

                    public static string Constants(
                        string text = "ok",
                        Tone tone = Tone.Second,
                        decimal amount = 12.5m,
                        CancellationToken token = default) =>
                        $"{text}:{(int)tone}:{amount}:{token.CanBeCanceled}";

                    public static long Date([Optional, DateTimeConstant(123)] DateTime value) => value.Ticks;

                    public static bool MissingValue([Optional] object value) =>
                        ReferenceEquals(value, Missing.Value);

                    public static int Params(int prefix = 2, params int[] values) =>
                        prefix + values.Length;

                    public string this[int x, int y = 4]
                    {
                        get => indexed ?? $"{x}:{y}";
                        set => indexed = $"{x}:{y}:{value}";
                    }
                }
            }
            """;

        const string gsSource = """
            package ImportedOptional.Probe
            import ImportedOptional.CSharp
            import System

            var message = ProgressMessage(3)
            var api = OptionalApi(10)
            var callback OptionalDelegate = func(enabled bool) string {
                return enabled ? "yes" : "no"
            }

            Console.WriteLine(message.Text)
            Console.WriteLine(api.Instance())
            Console.WriteLine(OptionalApi.Constants())
            Console.WriteLine(OptionalApi.Date())
            Console.WriteLine(OptionalApi.MissingValue())
            Console.WriteLine(OptionalApi.Params())
            Console.WriteLine(callback())
            Console.WriteLine(api[3])
            api[3] = "set"
            Console.WriteLine(api[3])
            """;

        Assert.Equal(
            $"ready{Environment.NewLine}22{Environment.NewLine}ok:2:12.5:False{Environment.NewLine}123{Environment.NewLine}True{Environment.NewLine}2{Environment.NewLine}yes{Environment.NewLine}3:4{Environment.NewLine}3:4:set{Environment.NewLine}",
            CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedOptional.CSharp"));
    }

    [Fact]
    public void ImportedMemberMatrix_OptionalOverloads_PreserveAmbiguityAndRequiredDiagnostics()
    {
        const string csSource = """
            namespace ImportedOptionalDiagnostics.CSharp
            {
                public static class Calls
                {
                    public static int Ambiguous(string? value = null) => 1;
                    public static long Ambiguous(System.Uri? value = null) => 2;
                    public static int Required(int value, int extra = 2) => value + extra;
                }
            }
            """;

        const string ambiguousSource = """
            package ImportedOptionalDiagnostics.Probe
            import ImportedOptionalDiagnostics.CSharp

            var a = Calls.Ambiguous()
            """;

        var ambiguityDiagnostics = CompileExpectingErrorsWithSiblingCs(
            csSource,
            ambiguousSource,
            "ImportedOptionalDiagnostics.CSharp");
        Assert.Contains(ambiguityDiagnostics, d => d.Contains("ambiguous", StringComparison.OrdinalIgnoreCase));

        const string requiredSource = """
            package ImportedOptionalDiagnostics.Probe
            import ImportedOptionalDiagnostics.CSharp

            var b = Calls.Required()
            """;

        var requiredDiagnostics = CompileExpectingErrorsWithSiblingCs(
            csSource,
            requiredSource,
            "ImportedOptionalDiagnostics.CSharp");
        Assert.Contains(requiredDiagnostics, d => d.Contains("Required", StringComparison.Ordinal));
    }

    [Fact]
    public void ImportedMemberMatrix_InParameterDelegate_LambdaCompilesAndRuns()
    {
        const string csSource = """
            namespace ImportedInDelegate.CSharp
            {
                public delegate bool Predicate(in int value);

                public static class Api
                {
                    public static bool Invoke(Predicate predicate)
                    {
                        var value = 100;
                        return predicate(in value);
                    }
                }
            }
            """;

        const string gsSource = """
            package ImportedInDelegate.Probe
            import ImportedInDelegate.CSharp
            import System

            Console.WriteLine(Api.Invoke((in value int32) -> value == 100))
            """;

        Assert.Equal($"True{Environment.NewLine}", CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedInDelegate.CSharp"));
    }

    [Fact]
    public void ImportedMemberMatrix_InParameterDelegate_RejectsMismatchedLambdaRefKind()
    {
        const string csSource = """
            namespace ImportedInDelegateMismatch.CSharp
            {
                public delegate bool Predicate(in int value);

                public static class Api
                {
                    public static bool Invoke(Predicate predicate) => true;
                }
            }
            """;

        const string gsSource = """
            package ImportedInDelegateMismatch.Probe
            import ImportedInDelegateMismatch.CSharp

            var result = Api.Invoke((ref value int32) -> value == 100)
            """;

        var diagnostics = CompileExpectingErrorsWithSiblingCs(
            csSource,
            gsSource,
            "ImportedInDelegateMismatch.CSharp");
        Assert.Contains(diagnostics, d => d.Contains("GS0155", StringComparison.Ordinal));
    }

    [Fact]
    public void ImportedMemberMatrix_RefAndOutParameterDelegates_LambdasCompileAndRun()
    {
        const string csSource = """
            namespace ImportedRefOutDelegates.CSharp
            {
                public delegate void RefAction(ref int value);
                public delegate bool OutPredicate(out int value);
                public delegate void ValueAction(int value);

                public static class Api
                {
                    public static int Apply(RefAction action)
                    {
                        var value = 40;
                        action(ref value);
                        return value;
                    }

                    public static int Read(OutPredicate predicate) =>
                        predicate(out var value) ? value : -1;

                    public static string Kind(RefAction action) => "ref";
                    public static string Kind(ValueAction action) => "value";
                }
            }
            """;

        const string gsSource = """
            package ImportedRefOutDelegates.Probe
            import ImportedRefOutDelegates.CSharp
            import System

            Console.WriteLine(Api.Apply((ref value int32) -> { value = value + 2 }))
            Console.WriteLine(Api.Read((out value int32) -> {
                value = 42
                return true
            }))
            Console.WriteLine(Api.Kind((ref value int32) -> { value = value + 1 }))
            Console.WriteLine(Api.Kind((value int32) -> { }))
            """;

        Assert.Equal($"42{Environment.NewLine}42{Environment.NewLine}ref{Environment.NewLine}value{Environment.NewLine}", CompileAndRunWithSiblingCs(csSource, gsSource, "ImportedRefOutDelegates.CSharp"));
    }

    [Fact]
    public void ImportedMemberMatrix_GenericRefOutInParameterDelegates_LambdasCompileAndRun()
    {
        const string csSource = """
            namespace ImportedGenericRefDelegates.CSharp
            {
                public delegate void RefAction<T>(ref T value);
                public delegate bool OutPredicate<T>(out T value);
                public delegate bool InPredicate<T>(in T value);

                public static class Api
                {
                    public static T Apply<T>(T value, RefAction<T> action)
                    {
                        action(ref value);
                        return value;
                    }

                    public static T Read<T>(OutPredicate<T> predicate)
                    {
                        predicate(out var value);
                        return value;
                    }

                    public static bool Test<T>(T value, InPredicate<T> predicate) =>
                        predicate(in value);
                }
            }
            """;

        const string gsSource = """
            package ImportedGenericRefDelegates.Probe
            import ImportedGenericRefDelegates.CSharp
            import System

            func Apply[T](value T, replacement T) T {
                return Api.Apply[T](value, (ref current T) -> { current = replacement })
            }

            func Read[T](value T) T {
                var predicate OutPredicate[T] = (out result T) -> {
                    result = value
                    return true
                }
                return Api.Read[T](predicate)
            }

            func Test[T](value T) bool {
                var predicate InPredicate[T] = (in current T) -> current.ToString() == value.ToString()
                return Api.Test[T](value, predicate)
            }

            Console.WriteLine(Apply[int32](40, 42))
            Console.WriteLine(Read[int32](42))
            Console.WriteLine(Test[int32](42))
            """;

        Assert.Equal($"42{Environment.NewLine}42{Environment.NewLine}True{Environment.NewLine}", CompileAndRunWithSiblingCs(
            csSource,
            gsSource,
            "ImportedGenericRefDelegates.CSharp"));
    }

    [Fact]
    public void ImportedMemberMatrix_GenericRefOutInParameterDelegates_ReportRefKindMismatches()
    {
        const string csSource = """
            namespace ImportedGenericRefDelegateMismatch.CSharp
            {
                public delegate void RefAction<T>(ref T value);
                public delegate bool OutPredicate<T>(out T value);
                public delegate bool InPredicate<T>(in T value);
            }
            """;

        var sources = new[]
        {
            """
            package ImportedGenericRefDelegateMismatch.RefProbe
            import ImportedGenericRefDelegateMismatch.CSharp

            func Bad[T]() {
                var callback RefAction[T] = (value T) -> { }
            }
            """,
            """
            package ImportedGenericRefDelegateMismatch.OutProbe
            import ImportedGenericRefDelegateMismatch.CSharp

            func Bad[T]() {
                var callback OutPredicate[T] = (ref value T) -> true
            }
            """,
            """
            package ImportedGenericRefDelegateMismatch.InProbe
            import ImportedGenericRefDelegateMismatch.CSharp

            func Bad[T]() {
                var callback InPredicate[T] = (out value T) -> {
                    return true
                }
            }
            """,
        };

        foreach (var source in sources)
        {
            var diagnostics = CompileExpectingErrorsWithSiblingCs(
                csSource,
                source,
                "ImportedGenericRefDelegateMismatch.CSharp");
            Assert.Contains(diagnostics, d => d.Contains("GS0155", StringComparison.Ordinal));
            Assert.DoesNotContain(diagnostics, d => d.Contains("GS0159", StringComparison.Ordinal));
            Assert.DoesNotContain(diagnostics, d => d.Contains("GS9998", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void ImportedMemberMatrix_RefAndOutParameterDelegates_ReportConversionDiagnosticForMismatchedRefKinds()
    {
        const string csSource = """
            namespace ImportedRefOutDelegateMismatch.CSharp
            {
                public delegate void RefAction(ref int value);
                public delegate bool OutPredicate(out int value);

                public static class Api
                {
                    public static void Apply(RefAction action) { }
                    public static bool Read(OutPredicate predicate) => true;
                }
            }
            """;

        var sources = new[]
        {
            """
            package ImportedRefOutDelegateMismatch.RefProbe
            import ImportedRefOutDelegateMismatch.CSharp

            Api.Apply((value int32) -> { })
            """,
            """
            package ImportedRefOutDelegateMismatch.OutProbe
            import ImportedRefOutDelegateMismatch.CSharp

            var result = Api.Read((ref value int32) -> true)
            """,
            """
            package ImportedRefOutDelegateMismatch.ValueProbe
            import ImportedRefOutDelegateMismatch.CSharp

            let callback (int32) -> void = (value int32) -> { }
            Api.Apply(callback)
            """,
        };

        foreach (var source in sources)
        {
            var diagnostics = CompileExpectingErrorsWithSiblingCs(
                csSource,
                source,
                "ImportedRefOutDelegateMismatch.CSharp");
            Assert.Contains(diagnostics, d => d.Contains("GS0155", StringComparison.Ordinal));
            Assert.DoesNotContain(diagnostics, d => d.Contains("GS0159", StringComparison.Ordinal));
        }
    }

    [Fact]
    public void SourceNamedRefOutInParameterDelegates_LambdasCompileAndRun()
    {
        const string source = """
            package SourceRefKindDelegates.Probe
            import System

            delegate RefAction(ref value int32);
            delegate OutAction(out value int32);
            delegate InPredicate(in value int32) bool;
            delegate GenericRefAction[T](ref value T);
            delegate GenericOutAction[T](out value T);
            delegate GenericInPredicate[T](in value T) bool;

            var refAction RefAction = (ref value int32) -> { value = value + 1 }
            var outAction OutAction = (out value int32) -> { value = 42 }
            var inPredicate InPredicate = (in value int32) -> value == 42
            var genericRefAction GenericRefAction[int32] = (ref value int32) -> { value = value + 1 }
            var genericOutAction GenericOutAction[int32] = (out value int32) -> { value = 42 }
            var genericInPredicate GenericInPredicate[int32] = (in value int32) -> value == 42

            var value = 41
            refAction(ref value)
            outAction(out value)
            Console.WriteLine(inPredicate(in value))
            value = 41
            genericRefAction(ref value)
            genericOutAction(out value)
            Console.WriteLine(genericInPredicate(in value))
            """;

        Assert.Equal($"True{Environment.NewLine}True{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void SourceNamedRefOutInParameterDelegates_MethodGroupsCompileAndRun()
    {
        const string source = """
            package SourceRefKindMethodGroups.Probe
            import System

            delegate RefAction(ref value int32);
            delegate OutAction(out value int32);
            delegate InPredicate(in value int32) bool;
            delegate GenericRefAction[T](ref value T);
            delegate GenericOutAction[T](out value T);
            delegate GenericInPredicate[T](in value T) bool;

            func AddOne(ref value int32) { value = value + 1 }
            func Set42(out value int32) { value = 42 }
            func Is42(in value int32) bool { return value == 42 }

            var refAction RefAction = AddOne
            var outAction OutAction = Set42
            var inPredicate InPredicate = Is42
            var genericRefAction GenericRefAction[int32] = AddOne
            var genericOutAction GenericOutAction[int32] = Set42
            var genericInPredicate GenericInPredicate[int32] = Is42

            var value = 41
            refAction(ref value)
            Console.WriteLine(value)
            outAction(out value)
            Console.WriteLine(value)
            Console.WriteLine(inPredicate(in value))
            value = 41
            genericRefAction(ref value)
            Console.WriteLine(value)
            genericOutAction(out value)
            Console.WriteLine(value)
            Console.WriteLine(genericInPredicate(in value))
            """;

        Assert.Equal($"42{Environment.NewLine}42{Environment.NewLine}True{Environment.NewLine}42{Environment.NewLine}42{Environment.NewLine}True{Environment.NewLine}", CompileAndRun(source));
    }

    [Fact]
    public void ImportedRefOutInParameterDelegates_SourceMethodGroupsCompileAndRun()
    {
        const string csSource = """
            using System;

            namespace ImportedDelegateSourceMethodGroups.CSharp
            {
                public delegate void RefAction(ref int value);
                public delegate void OutAction(out int value);
                public delegate bool InPredicate(in int value);
                public delegate void GenericRefAction<T>(ref T value);

                public static class Api
                {
                    public static void Apply(RefAction action, ref int value) => action(ref value);
                    public static void Fill(OutAction action, out int value) => action(out value);
                    public static bool Test(InPredicate predicate, in int value) => predicate(in value);
                    public static string Pick(RefAction action) => "ref";
                    public static string Pick(Action<int> action) => "value";
                }
            }
            """;

        const string source = """
            package ImportedDelegateSourceMethodGroups.Probe
            import System
            import ImportedDelegateSourceMethodGroups.CSharp

            func AddOne(ref value int32) { value = value + 1 }
            func Set42(out value int32) { value = 42 }
            func Is42(in value int32) bool { return value == 42 }

            var genericRefAction GenericRefAction[int32] = AddOne
            var value = 41
            Api.Apply(AddOne, ref value)
            Console.WriteLine(value)
            Api.Fill(Set42, out value)
            Console.WriteLine(value)
            Console.WriteLine(Api.Test(Is42, in value))
            value = 41
            genericRefAction(ref value)
            Console.WriteLine(value)
            Console.WriteLine(Api.Pick(AddOne))
            """;

        Assert.Equal(
            $"42{Environment.NewLine}42{Environment.NewLine}True{Environment.NewLine}42{Environment.NewLine}ref{Environment.NewLine}",
            CompileAndRunWithSiblingCs(
                csSource,
                source,
                "ImportedDelegateSourceMethodGroups.CSharp"));
    }

    [Fact]
    public void ImportedRefOutInParameterDelegates_ClrMethodGroupsCompileAndRun()
    {
        const string csSource = """
            namespace ImportedClrMethodGroups.CSharp
            {
                public delegate void RefAction(ref int value);
                public delegate void OutAction(out int value);
                public delegate bool InPredicate(in int value);
                public delegate void GenericRefAction<T>(ref T value);

                public static class Methods
                {
                    public static void AddOne(ref int value) => value++;
                    public static void Set42(out int value) => value = 42;
                    public static bool Is42(in int value) => value == 42;
                }

                public static class Api
                {
                    public static void Apply(RefAction action, ref int value) => action(ref value);
                    public static void Fill(OutAction action, out int value) => action(out value);
                    public static bool Test(InPredicate predicate, in int value) => predicate(in value);
                }
            }
            """;

        const string source = """
            package ImportedClrMethodGroups.Probe
            import System
            import ImportedClrMethodGroups.CSharp

            var refAction RefAction = Methods.AddOne
            var outAction OutAction = Methods.Set42
            var inPredicate InPredicate = Methods.Is42
            var genericRefAction GenericRefAction[int32] = Methods.AddOne

            var value = 41
            refAction(ref value)
            Console.WriteLine(value)
            outAction(out value)
            Console.WriteLine(value)
            Console.WriteLine(Api.Test(inPredicate, in value))
            value = 41
            Api.Apply(Methods.AddOne, ref value)
            Console.WriteLine(value)
            Api.Fill(Methods.Set42, out value)
            Console.WriteLine(value)
            Console.WriteLine(Api.Test(Methods.Is42, in value))
            value = 41
            genericRefAction(ref value)
            Console.WriteLine(value)
            """;

        Assert.Equal(
            $"42{Environment.NewLine}42{Environment.NewLine}True{Environment.NewLine}42{Environment.NewLine}42{Environment.NewLine}True{Environment.NewLine}42{Environment.NewLine}",
            CompileAndRunWithSiblingCs(
                csSource,
                source,
                "ImportedClrMethodGroups.CSharp"));
    }

    [Fact]
    public void ImportedGenericFunction_InfersTypeFromSingleCandidateMethodGroupParameters()
    {
        const string csSource = """
            using System;

            namespace ImportedSingleMethodGroupInference.CSharp
            {
                public static class Api
                {
                    public static void RunOnly<T>(Action<T> action) => action(default!);
                    public static void Accept<TIn, TOut>(Func<TIn, TOut> function) { }
                    public static void Emit(int value) => Console.WriteLine("emit" + value);
                }
            }
            """;

        const string source = """
            package ImportedSingleMethodGroupInference.Probe
            import System
            import ImportedSingleMethodGroupInference.CSharp

            func EmitSource(value int32) { Console.WriteLine("source" + value.ToString()) }
            async func AsyncText(value int32) string { return value.ToString() }

            Api.RunOnly(Api.Emit)
            Api.RunOnly(EmitSource)
            Api.Accept(AsyncText)
            """;

        Assert.Equal(
            $"emit0{Environment.NewLine}source0{Environment.NewLine}",
            CompileAndRunWithSiblingCs(
                csSource,
                source,
                "ImportedSingleMethodGroupInference.CSharp"));
    }

    [Fact]
    public void SourceAndImportedMethodGroups_RefKindMismatchesStayDiagnosed()
    {
        const string sourceDefined = """
            package SourceMethodGroupRefKindMismatch.Probe

            delegate RefAction(ref value int32);
            delegate OutAction(out value int32);
            delegate InPredicate(in value int32) bool;

            func AddOne(ref value int32) { value = value + 1 }
            func Set42(out value int32) { value = 42 }
            func Is42Ref(ref value int32) bool { return value == 42 }

            var refCallback RefAction = Set42
            var outCallback OutAction = AddOne
            var inCallback InPredicate = Is42Ref
            """;

        const string csSource = """
            namespace ImportedMethodGroupRefKindMismatch.CSharp
            {
                public delegate void RefAction(ref int value);
                public delegate void OutAction(out int value);
                public delegate bool InPredicate(in int value);

                public static class Methods
                {
                    public static void AddOne(ref int value) => value++;
                    public static void Set42(out int value) => value = 42;
                    public static bool Is42Ref(ref int value) => value == 42;
                }

                public static class Api
                {
                    public static void Apply(RefAction action) { }
                }
            }
            """;

        const string imported = """
            package ImportedMethodGroupRefKindMismatch.Probe
            import ImportedMethodGroupRefKindMismatch.CSharp

            func SetSource42(out value int32) { value = 42 }

            var refCallback RefAction = Methods.Set42
            var outCallback OutAction = Methods.AddOne
            var inCallback InPredicate = Methods.Is42Ref
            Api.Apply(SetSource42)
            Api.Apply(Methods.Set42)
            """;

        var workDir = CreateWorkDir("method_group_ref_kind_mismatch_");
        try
        {
            var siblingDll = BuildCsLibrary(
                workDir,
                csSource,
                "ImportedMethodGroupRefKindMismatch.CSharp");
            var sourceDiagnostics = CompileExpectingErrors(
                sourceDefined,
                Array.Empty<string>(),
                workDir);
            var importedDiagnostics = CompileExpectingErrors(
                imported,
                new[] { siblingDll },
                workDir);
            Assert.Equal(Enumerable.Repeat("GS0155", 3), GetDiagnosticIds(sourceDiagnostics));
            Assert.Equal(
                new[] { "GS0218", "GS0218", "GS0218", "GS0155", "GS0218" },
                GetDiagnosticIds(importedDiagnostics));
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    [Fact]
    public void SourceNamedRefOutInParameterDelegates_MatchImportedMismatchDiagnostics()
    {
        const string csSource = """
            namespace RefKindDelegateParity.CSharp
            {
                public delegate void RefAction(ref int value);
                public delegate void OutAction(out int value);
                public delegate bool InPredicate(in int value);
                public delegate void GenericRefAction<T>(ref T value);
                public delegate void GenericOutAction<T>(out T value);
                public delegate bool GenericInPredicate<T>(in T value);
            }
            """;

        const string sourceDefined = """
            package SourceRefKindDelegateMismatch.Probe

            delegate RefAction(ref value int32);
            delegate OutAction(out value int32);
            delegate InPredicate(in value int32) bool;
            delegate GenericRefAction[T](ref value T);
            delegate GenericOutAction[T](out value T);
            delegate GenericInPredicate[T](in value T) bool;

            var refCallback RefAction = (value int32) -> { }
            var outCallback OutAction = (ref value int32) -> { }
            var inCallback InPredicate = (value int32) -> true
            var genericRefCallback GenericRefAction[int32] = (value int32) -> { }
            var genericOutCallback GenericOutAction[int32] = (ref value int32) -> { }
            var genericInCallback GenericInPredicate[int32] = (value int32) -> true
            """;

        const string imported = """
            package ImportedRefKindDelegateMismatch.Probe
            import RefKindDelegateParity.CSharp

            var refCallback RefAction = (value int32) -> { }
            var outCallback OutAction = (ref value int32) -> { }
            var inCallback InPredicate = (value int32) -> true
            var genericRefCallback GenericRefAction[int32] = (value int32) -> { }
            var genericOutCallback GenericOutAction[int32] = (ref value int32) -> { }
            var genericInCallback GenericInPredicate[int32] = (value int32) -> true
            """;

        var workDir = CreateWorkDir("ref_kind_delegate_parity_");
        try
        {
            var siblingDll = BuildCsLibrary(workDir, csSource, "RefKindDelegateParity.CSharp");
            var sourceDiagnostics = CompileExpectingErrors(sourceDefined, Array.Empty<string>(), workDir);
            var importedDiagnostics = CompileExpectingErrors(imported, new[] { siblingDll }, workDir);
            Assert.Equal(Enumerable.Repeat("GS0155", 6), GetDiagnosticIds(sourceDiagnostics));
            Assert.Equal(GetDiagnosticIds(importedDiagnostics), GetDiagnosticIds(sourceDiagnostics));
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    [Fact]
    public void NamedDelegate_OmittedOptionalArgument_UsesDeclaredDefault()
    {
        const string source = """
            package OptionalDelegate.Probe
            import System

            delegate Toggle(enabled bool = true) string;

            var callback Toggle = func(enabled bool) string {
                return enabled ? "yes" : "no"
            }

            Console.WriteLine(callback())
            """;

        Assert.Equal($"yes{Environment.NewLine}", CompileAndRun(source));
    }

    private static string CompileAndRunWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var workDir = CreateWorkDir("imported_member_matrix_");
        try
        {
            var siblingDll = BuildCsLibrary(workDir, csSource, siblingName);
            File.Copy(siblingDll, Path.Combine(workDir, Path.GetFileName(siblingDll)), overwrite: true);
            return CompileAndRun(gSource, new[] { siblingDll }, workDir);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static string Issue3076Source(string fixtureNamespace, bool throughTypeParameter)
    {
        if (!throughTypeParameter)
        {
            return $$"""
                    import {{fixtureNamespace}}
                    import System

                    Issue3076GenericStaticSlot[int32].Property = 301
                    Issue3076GenericStaticSlot[int32].Field = 302
                    Issue3076GenericStaticSlot[string].Property = 311
                    Issue3076GenericStaticSlot[string].Field = 312
                    Issue3076GenericStaticSlot[object].Property = 321
                    Issue3076GenericStaticSlot[object].Field = 322
                    Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Property = 331
                    Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Field = 332
                    Issue3076GenericPairSlot[int32, string].Property = 341
                    Issue3076GenericPairSlot[int32, string].Field = 342
                    Issue3076PlainStaticSlot.Property = 351
                    Issue3076PlainStaticSlot.Field = 352

                    Console.WriteLine(Issue3076GenericStaticSlot[int32].Property)
                    Console.WriteLine(Issue3076GenericStaticSlot[int32].Field)
                    Console.WriteLine(Issue3076GenericStaticSlot[string].Property)
                    Console.WriteLine(Issue3076GenericStaticSlot[string].Field)
                    Console.WriteLine(Issue3076GenericStaticSlot[object].Property)
                    Console.WriteLine(Issue3076GenericStaticSlot[object].Field)
                    Console.WriteLine(Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Property)
                    Console.WriteLine(Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Field)
                    Console.WriteLine(Issue3076GenericPairSlot[int32, string].Property)
                    Console.WriteLine(Issue3076GenericPairSlot[int32, string].Field)
                    Console.WriteLine(Issue3076PlainStaticSlot.Property)
                    Console.WriteLine(Issue3076PlainStaticSlot.Field)
                """;
        }

        return $$"""
                import {{fixtureNamespace}}
                import System

                func Store[T](propertyValue int32, fieldValue int32) {
                    Issue3076GenericStaticSlot[T].Property = propertyValue
                    Issue3076GenericStaticSlot[T].Field = fieldValue
                }

                func StorePropertyAndRead[T](value int32) int32 {
                    Issue3076GenericStaticSlot[T].Property = value
                    return Issue3076GenericStaticSlot[T].Property
                }

                func StoreFieldAndRead[T](value int32) int32 {
                    Issue3076GenericStaticSlot[T].Field = value
                    return Issue3076GenericStaticSlot[T].Field
                }

                func ReadProperty[T]() int32 {
                    return Issue3076GenericStaticSlot[T].Property
                }

                func ReadField[T]() int32 {
                    return Issue3076GenericStaticSlot[T].Field
                }

                func StoreNested[T](propertyValue int32, fieldValue int32) {
                    Issue3076GenericStaticSlot[Issue3076GenericBox[T]].Property = propertyValue
                    Issue3076GenericStaticSlot[Issue3076GenericBox[T]].Field = fieldValue
                }

                func StorePair[TFirst, TSecond](propertyValue int32, fieldValue int32) {
                    Issue3076GenericPairSlot[TFirst, TSecond].Property = propertyValue
                    Issue3076GenericPairSlot[TFirst, TSecond].Field = fieldValue
                }

                Issue3076GenericStaticSlot[int32].Property = 101
                Issue3076GenericStaticSlot[int32].Field = 102
                Issue3076GenericStaticSlot[string].Property = 111
                Issue3076GenericStaticSlot[string].Field = 112
                Issue3076GenericStaticSlot[object].Property = 121
                Issue3076GenericStaticSlot[object].Field = 122
                Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Property = 131
                Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].Field = 132
                Issue3076GenericPairSlot[int32, string].Property = 141
                Issue3076GenericPairSlot[int32, string].Field = 142

                var intProperty = StorePropertyAndRead[int32](201)
                var intField = StoreFieldAndRead[int32](202)
                Store[string](211, 212)
                StoreNested[int32](221, 222)
                StorePair[int32, string](231, 232)
                Issue3076PlainStaticSlot.Property = 241
                Issue3076PlainStaticSlot.Field = 242

                Console.WriteLine(intProperty)
                Console.WriteLine(intField)
                Console.WriteLine(ReadProperty[string]())
                Console.WriteLine(ReadField[string]())
                Console.WriteLine(Issue3076GenericStaticSlot[object].Property)
                Console.WriteLine(Issue3076GenericStaticSlot[object].Field)
                Console.WriteLine(Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].ReadProperty())
                Console.WriteLine(Issue3076GenericStaticSlot[Issue3076GenericBox[int32]].ReadField())
                Console.WriteLine(Issue3076GenericPairSlot[int32, string].Property)
                Console.WriteLine(Issue3076GenericPairSlot[int32, string].Field)
                Console.WriteLine(Issue3076PlainStaticSlot.Property)
                Console.WriteLine(Issue3076PlainStaticSlot.Field)
            """;
    }

    private static List<string> CompileExpectingErrorsWithSiblingCs(string csSource, string gSource, string siblingName)
    {
        var workDir = CreateWorkDir("imported_member_matrix_err_");
        try
        {
            var siblingDll = BuildCsLibrary(workDir, csSource, siblingName);
            return CompileExpectingErrors(gSource, new[] { siblingDll }, workDir);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static string CompileAndRun(string source)
    {
        var workDir = CreateWorkDir("imported_member_matrix_source_");
        try
        {
            return CompileAndRun(source, Array.Empty<string>(), workDir);
        }
        finally
        {
            TryDelete(workDir);
        }
    }

    private static string CompileAndRun(string source, IReadOnlyCollection<string> references, string workDir)
    {
        var srcPath = Path.Combine(workDir, "test.gs");
        var outPath = Path.Combine(workDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var args = GscArgs(outPath, "exe", references, srcPath);
        var (exitCode, diagnostics) = RunCompiler(args);
        Assert.True(exitCode == 0, diagnostics);

        IlVerifier.Verify(outPath, additionalReferences: references);

        var runtimeConfig = Path.ChangeExtension(outPath, ".runtimeconfig.json");
        if (!File.Exists(runtimeConfig))
        {
            File.WriteAllText(runtimeConfig, """
                {
                  "runtimeOptions": {
                    "tfm": "net10.0",
                    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
                  }
                }
                """);
        }

        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workDir,
        };
        psi.ArgumentList.Add("exec");
        psi.ArgumentList.Add("--runtimeconfig");
        psi.ArgumentList.Add(runtimeConfig);
        psi.ArgumentList.Add(outPath);

        using var proc = Process.Start(psi) ?? throw new InvalidOperationException("failed to start dotnet exec");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(30_000), "dotnet exec timed out");
        Assert.True(proc.ExitCode == 0, $"exited {proc.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout.ReplaceLineEndings(Environment.NewLine);
    }

    private static List<string> CompileExpectingErrors(string source, IReadOnlyCollection<string> references, string workDir)
    {
        var srcPath = Path.Combine(workDir, "test.gs");
        var outPath = Path.Combine(workDir, "test.dll");
        File.WriteAllText(srcPath, source);

        var (exitCode, diagnostics) = RunCompiler(GscArgs(outPath, "exe", references, srcPath));
        Assert.True(exitCode != 0, "expected gsc to report errors but it succeeded");
        return diagnostics.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries).ToList();
    }

    private static List<string> GetDiagnosticIds(IEnumerable<string> diagnostics)
    {
        var ids = new List<string>();
        foreach (var diagnostic in diagnostics)
        {
            var index = diagnostic.IndexOf("GS", StringComparison.Ordinal);
            if (index >= 0 && diagnostic.Length >= index + 6)
            {
                ids.Add(diagnostic.Substring(index, 6));
            }
        }

        return ids;
    }

    private static string[] GscArgs(string outPath, string target, IReadOnlyCollection<string> references, string srcPath)
    {
        var args = new List<string>
        {
            "/out:" + outPath,
            "/target:" + target,
            "/targetframework:net10.0",
            "/nowarn:GS9100",
        };
        foreach (var reference in references.Concat(TrustedPlatformAssemblies()))
        {
            args.Add("/reference:" + reference);
        }

        args.Add(srcPath);
        return args.ToArray();
    }

    private static (int ExitCode, string Diagnostics) RunCompiler(string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousErr = Console.Error;
        Console.SetOut(stdout);
        Console.SetError(stderr);
        try
        {
            return (Program.Main(args), stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousErr);
        }
    }

    private static string BuildCsLibrary(string workDir, string source, string assemblyName)
    {
        var csDir = Path.Combine(workDir, "csref");
        Directory.CreateDirectory(csDir);
        File.WriteAllText(Path.Combine(csDir, "Lib.cs"), source);
        File.WriteAllText(Path.Combine(csDir, "Lib.csproj"), $"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <OutputType>Library</OutputType>
                <TargetFramework>net10.0</TargetFramework>
                <Nullable>enable</Nullable>
                <LangVersion>latest</LangVersion>
                <NoWarn>1591;SA1649;SA1518;SA1516;SA1122;SA1201</NoWarn>
                <RunAnalyzers>false</RunAnalyzers>
                <AssemblyName>{assemblyName}</AssemblyName>
                <RootNamespace>{assemblyName}</RootNamespace>
              </PropertyGroup>
            </Project>
            """);

        RunDotnet(csDir, "restore");
        var outDir = Path.Combine(csDir, "out");
        RunDotnet(csDir, "build", "-c", "Release", "--nologo", "--no-restore", "-o", outDir);

        var dll = Path.Combine(outDir, assemblyName + ".dll");
        Assert.True(File.Exists(dll), $"sibling assembly not found at {dll}");
        return dll;
    }

    private static void RunDotnet(string workingDir, params string[] args)
    {
        var psi = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            WorkingDirectory = workingDir,
        };
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }

        using var proc = Process.Start(psi) ?? throw new InvalidOperationException($"failed to start dotnet {string.Join(" ", args)}");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        Assert.True(proc.WaitForExit(120_000), $"dotnet {args[0]} timed out");
        Assert.True(proc.ExitCode == 0, $"dotnet {string.Join(" ", args)} failed ({proc.ExitCode})\nstdout:\n{stdout}\nstderr:\n{stderr}");
    }

    private static string CreateWorkDir(string prefix)
    {
        var root = Path.Combine(Environment.CurrentDirectory, "TestArtifacts");
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, prefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static IEnumerable<string> TrustedPlatformAssemblies()
    {
        var tpa = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrEmpty(tpa))
        {
            yield break;
        }

        foreach (var path in tpa.Split(Path.PathSeparator))
        {
            if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
            {
                yield return path;
            }
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch
        {
        }
    }
}
