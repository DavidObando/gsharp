// <copyright file="Issue4755GenericStructInitializerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

public sealed class Issue4755GenericStructInitializerEmitTests
{
    [Fact]
    public void PublicScalarInitializer_MatchesNativeRoslynRuntime()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "Native4755", """
                namespace Native4755;
                public static class Provider<T>
                {
                    public static int Calls;
                    public static int Next() { Calls++; return 7; }
                }
                public struct Inner<T>
                {
                    public int Value = Provider<T>.Next();
                    public Inner() { }
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var item = new Inner<int>();
                        return item.Value + "/" + Provider<int>.Calls;
                    }
                }
                """);
            var nativeAssembly = EmittedFixture.Load(native);
            Assert.Equal("7/1", Invoke(nativeAssembly, "Native4755.Oracle"));

            var emitted = Compile(directory, """
                package GenericScalar4755
                class Provider[T] {
                    shared {
                        public var Calls int32
                        public func Next() int32 {
                            Calls += 1
                            return 7
                        }
                    }
                }
                struct Inner[T] {
                    public var Value int32 = Provider[T].Next()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let item = Inner[int32]{}
                            return item.Value.ToString() + "/" + Provider[int32].Calls.ToString()
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            AssertNativeConsumer(directory, emitted, "GenericScalar4755.Api", "7/1");
        });
    }

    [Fact]
    public void ImportedGenericInitializer_SubstitutesValueAndReferenceArguments()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "Factory4755", """
                namespace Factory4755;
                public static class Factory<T>
                {
                    public static int Calls;
                    public static T Next()
                    {
                        Calls++;
                        return typeof(T) == typeof(int) ? (T)(object)7 : (T)(object)"text";
                    }
                }
                public struct Inner<T>
                {
                    public T Value = Factory<T>.Next();
                    public Inner() { }
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var number = new Inner<int>();
                        var text = new Inner<string>();
                        return number.Value + "/" + Factory<int>.Calls + ";" +
                            text.Value + "/" + Factory<string>.Calls;
                    }
                }
                """);
            Assert.Equal("7/1;text/1", Invoke(EmittedFixture.Load(native), "Factory4755.Oracle"));
            var emitted = Compile(directory, """
                package GenericImported4755
                import Factory4755
                struct Inner[T] {
                    public var Value T = Factory[T].Next()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let number = Inner[int32]{}
                            let text = Inner[string]()
                            return number.Value.ToString() + "/" + Factory[int32].Calls.ToString() + ";" +
                                text.Value + "/" + Factory[string].Calls.ToString()
                        }
                    }
                }
                """, native);
            IlVerifier.Verify(emitted, new[] { native });
            AssertNativeConsumer(directory, emitted, "GenericImported4755.Api", "7/1;text/1", native);
        });
    }

    [Fact]
    public void ConstructorOwnership_PreservesExplicitOrderPrivateReadonlyAndZeroStorage()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativeControls4755", """
                namespace NativeControls4755;
                public static class Effects
                {
                    public static string Trace = "";
                    public static int Mark(string label, int value) { Trace += label; return value; }
                }
                public struct Box<T>
                {
                    public int First = Effects.Mark("A", 7);
                    public int Second = Effects.Mark("B", 8);
                    public Box() { }
                }
                public struct Hidden<T>
                {
                    private readonly int value = Effects.Mark("H", 9);
                    public Hidden() { }
                    public int Read() => value;
                }
                public struct Open<T>
                {
                    public readonly int Value = Effects.Mark("R", 6);
                    public Open() { }
                }
                public struct Plain
                {
                    public int Value = Effects.Mark("P", 5);
                    public Plain() { }
                }
                public struct User<T>
                {
                    public int Value = Effects.Mark("U", 4);
                    public User() { }
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var item = new Box<int> { Second = Effects.Mark("S", 2), First = Effects.Mark("F", 1) };
                        var hidden = new Hidden<string>();
                        var readOnly = new Open<string>();
                        var plain = new Plain();
                        var user = new User<int>();
                        var zeros = new Open<string>[1];
                        Open<string> zero = default;
                        return item.First + "/" + item.Second + "/" + hidden.Read() + "/" +
                            readOnly.Value + "/" + plain.Value + "/" + user.Value + "/" +
                            zeros[0].Value + "/" + zero.Value + "/" + Effects.Trace;
                    }
                }
                """);
            Assert.Equal("1/2/9/6/5/4/0/0/ABSFHRPU", Invoke(EmittedFixture.Load(native), "NativeControls4755.Oracle"));
            var emitted = Compile(directory, """
                package GenericControls4755
                class Effects {
                    shared {
                        public var Trace string = ""
                        public func Mark(label string, value int32) int32 {
                            Trace += label
                            return value
                        }
                    }
                }
                struct Box[T] {
                    public var First int32 = Effects.Mark("A", 7)
                    public var Second int32 = Effects.Mark("B", 8)
                }
                struct Hidden[T] {
                    private let Hidden int32 = Effects.Mark("H", 9)
                    public func Read() int32 -> Hidden
                }
                struct Open[T] {
                    public let Value int32 = Effects.Mark("R", 6)
                }
                struct Plain {
                    public var Value int32 = Effects.Mark("P", 5)
                }
                struct User[T] {
                    public var Value int32 = Effects.Mark("U", 4)
                    public init() { }
                }
                class Api {
                    shared {
                        public func Run() string {
                            let item = Box[int32]{Second: Effects.Mark("S", 2), First: Effects.Mark("F", 1)}
                            let hidden = Hidden[string]{}
                            let readonly = Open[string]{}
                            let plain = Plain{}
                            let user = User[int32]()
                            let zeros = System.GC.AllocateArray[Open[string]](1)
                            let zero Open[string] = default
                            return item.First.ToString() + "/" + item.Second.ToString() + "/" + hidden.Read().ToString() +
                                "/" + readonly.Value.ToString() + "/" + plain.Value.ToString() + "/" + user.Value.ToString() + "/" +
                                zeros[0].Value.ToString() + "/" + zero.Value.ToString() + "/" + Effects.Trace
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            var assembly = EmittedFixture.Load(emitted);
            var open = assembly.GetType("GenericControls4755.Open`1", throwOnError: true);
            Assert.NotNull(open);
            Assert.True(open.GetField("Value").IsInitOnly);
            Assert.Equal(open, open.GetField("Value").DeclaringType);
            Assert.Single(open.GetConstructors());
            Assert.Empty(assembly.GetType("GenericControls4755.Plain", throwOnError: true).GetConstructors());
            Assert.Single(assembly.GetType("GenericControls4755.User`1", throwOnError: true).GetConstructors());
            var box = assembly.GetType("GenericControls4755.Hidden`1", throwOnError: true);
            var hidden = box.GetField("Hidden", BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.NotNull(hidden);
            Assert.True(hidden.IsPrivate);
            Assert.True(hidden.IsInitOnly);
            Assert.Equal(box, hidden.DeclaringType);
            AssertNativeConsumer(directory, emitted, "GenericControls4755.Api", "1/2/9/6/5/4/0/0/ABSFHRPU");
        });
    }

    [Fact]
    public void NestedAndProjectionLiterals_UseTheSameDefinitionOwnedInitialization()
    {
        InDirectory(directory =>
        {
            var emitted = Compile(directory, """
                package GenericSibling4755
                class Provider[T] {
                    shared {
                        public var Calls int32
                        public func Next() int32 {
                            Calls += 1
                            return 7
                        }
                    }
                }
                class Outer[T] {
                    public struct Inner {
                        public var Value int32 = Provider[T].Next()
                    }
                }
                struct Source {
                    public var Copied int32
                    public var Stamp int32
                }
                struct Target[T] {
                    public var Copied T
                    public var Stamp int32 = Provider[T].Next()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let nested = Outer[string].Inner{}
                            let source = Source{Copied: 42, Stamp: 23}
                            let projected Target[int32] = source
                            return nested.Value.ToString() + "/" + Provider[string].Calls.ToString() + ";" +
                                projected.Copied.ToString() + "/" + projected.Stamp.ToString() + "/" +
                                Provider[int32].Calls.ToString()
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            AssertNativeConsumer(directory, emitted, "GenericSibling4755.Api", "7/1;42/23/1");
        });
    }

    private static void AssertNativeConsumer(string directory, string emitted, string api, string expected, params string[] references)
    {
        var consumer = EmitCSharp(directory, "Consumer4755",
            "public static class Consumer4755 { public static string Run() => " + api + ".Run(); }",
            references.Append(emitted).ToArray());
        IlVerifier.Verify(consumer, references.Append(emitted));
        var assemblies = EmittedFixture.LoadTogether(references.Concat(new[] { emitted, consumer }).ToArray());
        Assert.Equal(expected, Invoke(assemblies.Last(), "Consumer4755"));
    }

    [Fact]
    public void PrimaryGenericInitializer_UsesOwningParameterScopeAndNativeConstructor()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativePrimary4755", """
                namespace NativePrimary4755;
                public static class Factory<T>
                {
                    public static int Calls;
                    public static T Copy(T value) { Calls++; return value; }
                }
                public struct Box<T>(T value)
                {
                    public T Value = value;
                    public T Copy = Factory<T>.Copy(value);
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var number = new Box<int>(7);
                        var text = new Box<string>("text");
                        return number.Value + "/" + number.Copy + "/" + Factory<int>.Calls + ";" +
                            text.Value + "/" + text.Copy + "/" + Factory<string>.Calls;
                    }
                }
                """);
            Assert.Equal("7/7/1;text/text/1", Invoke(EmittedFixture.Load(native), "NativePrimary4755.Oracle"));
            var emitted = Compile(directory, """
                package PrimaryGeneric4755
                import NativePrimary4755
                struct Box[T](Value T) {
                    public var Copy T = Factory[T].Copy(Value)
                }
                struct Simple[T](Value T) {
                    public var Copy T = Value
                }
                class Api {
                    shared {
                        public func Run() string {
                            let number = Box[int32](7)
                            let text = Box[string]{Value: "text"}
                            return number.Value.ToString() + "/" + number.Copy.ToString() + "/" + Factory[int32].Calls.ToString() +
                                ";" + text.Value + "/" + text.Copy + "/" + Factory[string].Calls.ToString()
                        }
                    }
                }
                """, native);
            IlVerifier.Verify(emitted, new[] { native });
            AssertNativeConsumer(directory, emitted, "PrimaryGeneric4755.Api", "7/7/1;text/text/1", native);

            var consumer = EmitCSharp(directory, "DirectPrimary4755", """
                public static class DirectPrimary4755
                {
                    public static string Run()
                    {
                        var number = new PrimaryGeneric4755.Simple<int>(7);
                        var text = new PrimaryGeneric4755.Simple<string>("text");
                        return number.Value + "/" + number.Copy + ";" + text.Value + "/" + text.Copy;
                    }
                }
                """, emitted, native);
            IlVerifier.Verify(consumer, new[] { emitted, native });
            Assert.Equal("7/7;text/text", Invoke(EmittedFixture.LoadTogether(native, emitted, consumer).Last(), "DirectPrimary4755"));
            var box = EmittedFixture.LoadTogether(native, emitted).Last().GetType("PrimaryGeneric4755.Box`1", throwOnError: true);
            var constructor = Assert.Single(box.GetConstructors());
            var parameter = Assert.Single(constructor.GetParameters());
            Assert.Equal("Value", parameter.Name);
            Assert.Equal(box.GetGenericArguments()[0], parameter.ParameterType);
            Assert.Equal(box, box.GetField("Copy").DeclaringType);
        });
    }

    [Fact]
    public void PrimaryPrivateFixedArray_AndEnclosingTypesPreserveClosedStorage()
    {
        InDirectory(directory =>
        {
            var values = typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location;
            var native = EmitCSharp(directory, "NativePrivate4747", """
                #nullable enable
                namespace NativePrivate4747;
                public static class Factory
                {
                    public static Gsharp.Values.ReadOnlyManagedRef<int> Make() =>
                        Gsharp.Values.ReadOnlyManagedRef<int>.FromArray(new[] { 7 }, 0);
                }
                public struct Holder<T>(T value)
                {
                    private T[] handles = [value];
                    private readonly T copy = value;
                    public T Read() => handles[0];
                    public T ReadCopy() => copy;
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var number = new Holder<int>(7);
                        var text = new Holder<string>("text");
                        var location = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>>(Factory.Make());
                        return number.Read() + "/" + number.ReadCopy() + ";" + text.Read() + "/" + text.ReadCopy() +
                            ";" + location.Read().Borrow() + "/" + location.ReadCopy().Borrow();
                    }
                }
                """, values);
            Assert.Equal("7/7;text/text;7/7", Invoke(EmittedFixture.LoadTogether(values, native).Last(), "NativePrivate4747.Oracle"));
            var emitted = Compile(directory, """
                package PrimaryPrivate4747
                import NativePrivate4747
                struct Holder[T](Value T) {
                    private var Handles [1]T = [1]T{Value}
                    private let Copy T = Value
                    public func Read() T -> Handles[0]
                    public func ReadCopy() T -> Copy
                }
                class Outer[T] {
                    public struct Inner(Value T) {
                        public let Copy T = Value
                    }
                }
                struct Plain(Value int32) {
                    public let Copy int32 = Value
                }
                data struct Data[T](Value T) {
                    public let Copy T = Value
                }
                struct Captured[T](Value T) {
                    public var Reader () -> T = func () T { return Value }
                }
                struct Nested[T](Value T) {
                    private var Storage Holder[T] = Holder[T](Value)
                    public func Read() T -> Storage.Read()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let number = Holder[int32]{Value: 7}
                            let text = Holder[string]("text")
                            let nested = Outer[string].Inner{Value: "nested"}
                            let plain = Plain(8)
                            let data = Data[int32](9)
                            let captured = Captured[int32](10)
                            let nestedStorage = Nested[int32](11)
                            let location = Holder[readonly managed[int32]]{Value: Factory.Make()}
                            return number.Read().ToString() + "/" + number.ReadCopy().ToString() + ";" +
                                text.Read() + "/" + text.ReadCopy() + ";" + nested.Copy + ";" +
                                plain.Copy.ToString() + ";" + data.Copy.ToString() + ";" +
                                captured.Reader().ToString() + ";" + nestedStorage.Read().ToString() + ";" +
                                (*location.Read()).ToString() + "/" + (*location.ReadCopy()).ToString()
                        }
                    }
                }
                """, native, values);
            IlVerifier.Verify(emitted, new[] { native, values });
            AssertNativeConsumer(directory, emitted, "PrimaryPrivate4747.Api", "7/7;text/text;nested;8;9;10;11;7/7", native, values);
            var assembly = EmittedFixture.LoadTogether(values, native, emitted).Last();
            var holder = assembly.GetType("PrimaryPrivate4747.Holder`1", throwOnError: true);
            var copy = holder.GetField("Copy", BindingFlags.Instance | BindingFlags.NonPublic);
            Assert.True(copy.IsPrivate);
            Assert.True(copy.IsInitOnly);
            Assert.Equal(holder, copy.DeclaringType);
            Assert.Equal(holder.GetGenericArguments()[0], copy.FieldType);
            Assert.True(holder.GetField("Handles", BindingFlags.Instance | BindingFlags.NonPublic).IsPrivate);
            Assert.Single(holder.GetConstructors());
            Assert.Single(assembly.GetType("PrimaryPrivate4747.Data`1", throwOnError: true).GetConstructors());
        });
    }

    [Fact]
    public void PrimaryConstruction_PreservesArgumentAndInitializerOrderAndRawZero()
    {
        InDirectory(directory =>
        {
            var native = EmitCSharp(directory, "NativeOrder4747", """
                namespace NativeOrder4747;
                public static class Effects
                {
                    public static string Trace = "";
                    public static int Mark(string label, int value) { Trace += label; return value; }
                }
                public struct Pair<T>(T first, T second)
                {
                    public T First = first;
                    public T Second = second;
                    public T Copy = Observe(first);
                    public int Stamp = Effects.Mark("J", 3);
                    private static T Observe(T value) { Effects.Trace += "I"; return value; }
                }
                public struct ZeroInput(int value)
                {
                    public int Value = value;
                    private int seed = Effects.Mark("Z", 5);
                    public int Read() => seed;
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var named = new Pair<int>(second: Effects.Mark("B", 2), first: Effects.Mark("A", 1));
                        var supplied = new Pair<int>(Effects.Mark("C", 7), Effects.Mark("D", 8))
                            { Copy = Effects.Mark("S", 9) };
                        Pair<int> zero = default;
                        var array = new Pair<int>[1];
                        var initialized = new ZeroInput(0);
                        return named.First + "/" + named.Second + "/" + named.Copy + "/" + supplied.Copy +
                            "/" + zero.Stamp + "/" + array[0].Stamp + "/" + initialized.Value + "/" + initialized.Read() + "/" + Effects.Trace;
                    }
                }
                """);
            Assert.Equal("1/2/1/9/0/0/0/5/BAIJCDIJSZ", Invoke(EmittedFixture.Load(native), "NativeOrder4747.Oracle"));
            var emitted = Compile(directory, """
                package PrimaryOrder4747
                class Effects {
                    shared {
                        public var Trace string = ""
                        public func Mark(label string, value int32) int32 {
                            Trace += label
                            return value
                        }
                    }
                }
                struct Pair[T](First T, Second T) {
                    public var Copy T = Observe(First)
                    public var Stamp int32 = Effects.Mark("J", 3)
                    shared {
                        private func Observe(value T) T {
                            Effects.Trace += "I"
                            return value
                        }
                    }
                }
                struct ZeroInput(Value int32) {
                    private var Seed int32 = Effects.Mark("Z", 5)
                    public func Read() int32 -> Seed
                }
                class Api {
                    shared {
                        public func Run() string {
                            let named = Pair[int32](Second: Effects.Mark("B", 2), First: Effects.Mark("A", 1))
                            let supplied = Pair[int32]{First: Effects.Mark("C", 7), Second: Effects.Mark("D", 8), Copy: Effects.Mark("S", 9)}
                            let zero Pair[int32] = default
                            let array = System.GC.AllocateArray[Pair[int32]](1)
                            let initialized = ZeroInput{}
                            return named.First.ToString() + "/" + named.Second.ToString() + "/" + named.Copy.ToString() + "/" +
                                supplied.Copy.ToString() + "/" + zero.Stamp.ToString() + "/" + array[0].Stamp.ToString() + "/" +
                                initialized.Value.ToString() + "/" + initialized.Read().ToString() + "/" + Effects.Trace
                        }
                    }
                }
                """);
            IlVerifier.Verify(emitted);
            AssertNativeConsumer(directory, emitted, "PrimaryOrder4747.Api", "1/2/1/9/0/0/0/5/BAIJCDIJSZ");
        });
    }

    [Theory]
    [InlineData("Holder[readonly managed[int32]]{}", false)]
    [InlineData("Holder[readonly managed[int32]]{}", true)]
    [InlineData("Holder[managed[int32]]{}", false)]
    [InlineData("Holder[managed[int32]]{}", true)]
    [InlineData("Holder[Aggregate[readonly managed[int32]]]{}", false)]
    [InlineData("Holder[Envelope]{}", false)]
    [InlineData("Holder[[1]readonly managed[int32]]{}", false)]
    [InlineData("Holder[(readonly managed[int32], int32)]{}", false)]
    [InlineData("Outer[readonly managed[int32]].Inner{}", false)]
    [InlineData("Container[Holder[readonly managed[int32]]]{Value: Holder[readonly managed[int32]]{}}", false)]
    [InlineData("Pair[readonly managed[int32]]{First: Factory.Make()}", false)]
    [InlineData("Nested[readonly managed[int32]]{Value: Factory.Make()}", false)]
    public void MissingRequiredPrimaryInputs_ReportDefaultDiagnosticAtTheLiteral(string expression, bool declaredInitializer)
    {
        InDirectory(directory =>
        {
            var values = typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location;
            var native = EmitCSharp(directory, "MissingPrimary4755", """
                #nullable enable
                namespace MissingPrimary4755;
                public readonly struct Envelope(Gsharp.Values.ReadOnlyManagedRef<int> handle)
                {
                    public readonly Gsharp.Values.ReadOnlyManagedRef<int> Handle = handle;
                }
                public static class Factory
                {
                    public static Gsharp.Values.ReadOnlyManagedRef<int> Make() =>
                        Gsharp.Values.ReadOnlyManagedRef<int>.FromArray(new[] { 7 }, 0);
                }
                """, values);
            var source = $$"""
                package MissingPrimary4755Controls
                import MissingPrimary4755
                struct Holder[T](Value T) {
                    {{(declaredInitializer ? "private var Handles [1]T = [1]T{Value}" : string.Empty)}}
                    public func Read() T -> {{(declaredInitializer ? "Handles[0]" : "Value")}}
                }
                struct Aggregate[T](Item T) { }
                struct Container[T](Value T) { }
                struct Pair[T](First T, Second T) { }
                class Outer[T] { public struct Inner(Value T) { } }
                struct Nested[T](Value T) {
                    private var Storage Holder[T] = Holder[T]{}
                    public func Read() T -> Storage.Read()
                }
                func Bad() {
                    let item = {{expression}}
                }
                """;
            var result = TryCompile(directory, source, native, values);
            Assert.Equal(1, result.Code);
            Assert.Contains("error GS0604:", result.Output, StringComparison.Ordinal);
            Assert.Contains("default would synthesize a null non-null managed-reference slot", result.Output, StringComparison.Ordinal);
            Assert.DoesNotContain("GS9998", result.Output, StringComparison.Ordinal);
            Assert.False(File.Exists(result.AssemblyPath));
            var rejected = expression.StartsWith("Nested", StringComparison.Ordinal) ? "Holder[T]{}"
                : expression.StartsWith("Container", StringComparison.Ordinal)
                ? "Holder[readonly managed[int32]]{}"
                : expression.StartsWith("Outer", StringComparison.Ordinal) ? "Inner{}" : expression;
            var offset = source.LastIndexOf(rejected, StringComparison.Ordinal);
            Assert.True(offset >= 0);
            var line = source[..offset].Count(character => character == '\n') + 1;
            var column = offset - source.LastIndexOf('\n', offset);
            Assert.Contains($"Fixture.gs({line},{column},{line},{column + rejected.Length}): error GS0604:", result.Output, StringComparison.Ordinal);
            Assert.Single(result.Output.Split('\n'), text => text.Contains("error GS0604:", StringComparison.Ordinal));
        });
    }

    [Fact]
    public void MissingLegalPrimaryInputs_AndExplicitRequiredInputsRetainNativeRuntime()
    {
        InDirectory(directory =>
        {
            var values = typeof(Gsharp.Values.ReadOnlyManagedRef<>).Assembly.Location;
            var native = EmitCSharp(directory, "LegalPrimary4755", """
                #nullable enable
                namespace LegalPrimary4755;
                public static class Factory
                {
                    public static Gsharp.Values.ReadOnlyManagedRef<int> ReadOnly() =>
                        Gsharp.Values.ReadOnlyManagedRef<int>.FromArray(new[] { 7 }, 0);
                    public static Gsharp.Values.ManagedRef<int> Writable() =>
                        Gsharp.Values.ManagedRef<int>.FromArray(new[] { 8 }, 0);
                    public static bool MissingReadOnlyArray(Gsharp.Values.ReadOnlyManagedRef<int>[]? values) => values == null;
                    public static bool MissingNullableArray(Gsharp.Values.ReadOnlyManagedRef<int>?[]? values) => values == null;
                }
                public struct Aggregate<T>(T item) { public T Item = item; }
                public struct Holder<T>(T value)
                {
                    public T Value = value;
                    private readonly T copy = value;
                    public T Read() => copy;
                }
                public struct Nested<T>(T value)
                {
                    private Holder<T> storage = new(default);
                    public T Read() => storage.Read();
                }
                public static class Oracle
                {
                    public static string Run()
                    {
                        var readOnly = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>>(Factory.ReadOnly());
                        var writable = new Holder<Gsharp.Values.ManagedRef<int>>(Factory.Writable());
                        var nullable = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>?>(null);
                        var scalar = new Holder<int>(0);
                        var text = new Holder<string?>(null);
                        var aggregate = new Holder<Aggregate<Gsharp.Values.ReadOnlyManagedRef<int>>>(
                            new Aggregate<Gsharp.Values.ReadOnlyManagedRef<int>>(Factory.ReadOnly()));
                        var array = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>[]>([Factory.ReadOnly()]);
                        var zeroLength = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>[]?>(null);
                        var nullableArray = new Holder<Gsharp.Values.ReadOnlyManagedRef<int>?[]?>(null);
                        var nestedScalar = new Nested<int>(3);
                        var nestedNullable = new Nested<Gsharp.Values.ReadOnlyManagedRef<int>?>(null);
                        return readOnly.Value.Borrow() + "/" + readOnly.Read().Borrow() + ";" +
                            writable.Value.Borrow() + "/" + writable.Read().Borrow() + ";" +
                            (nullable.Read() == null) + ";" + scalar.Read() + ";" + (text.Read() == null) + ";" +
                            aggregate.Read().Item.Borrow() + ";" + array.Read()[0].Borrow() + ";" +
                            Factory.MissingReadOnlyArray(zeroLength.Read()) + ";" + Factory.MissingNullableArray(nullableArray.Read()) +
                            ";" + nestedScalar.Read() + ";" + (nestedNullable.Read() == null);
                    }
                }
                """, values);
            Assert.Equal("7/7;8/8;True;0;True;7;7;True;True;0;True", Invoke(EmittedFixture.LoadTogether(values, native).Last(), "LegalPrimary4755.Oracle"));
            var emitted = Compile(directory, """
                package LegalPrimary4755Controls
                import LegalPrimary4755
                struct Holder[T](Value T) {
                    private let Copy T = Value
                    public func Read() T -> Copy
                }
                struct Aggregate[T](Item T) { }
                struct Nested[T](Value T) {
                    private var Storage Holder[T] = Holder[T]{}
                    public func Read() T -> Storage.Read()
                }
                class Api {
                    shared {
                        public func Run() string {
                            let readonly = Holder[readonly managed[int32]]{Value: Factory.ReadOnly()}
                            let writable = Holder[managed[int32]](Factory.Writable())
                            let nullable = Holder[readonly managed[int32]?]{}
                            let scalar = Holder[int32]{}
                            let text = Holder[string?]{}
                            let nestedScalar = Nested[int32](3)
                            let nestedNullable = Nested[readonly managed[int32]?]{}
                            let aggregate = Holder[Aggregate[readonly managed[int32]]]{Value: Aggregate[readonly managed[int32]](Factory.ReadOnly())}
                            let array = Holder[[1]readonly managed[int32]]{Value: [1]readonly managed[int32]{Factory.ReadOnly()}}
                            let zeroLength = Holder[[0]readonly managed[int32]]{}
                            let nullableArray = Holder[[1]readonly managed[int32]?]{}
                            return (*readonly.Value).ToString() + "/" + (*readonly.Read()).ToString() + ";" +
                                (*writable.Value).ToString() + "/" + (*writable.Read()).ToString() + ";" +
                                (nullable.Read() == nil).ToString() + ";" + scalar.Read().ToString() + ";" +
                                (text.Read() == nil).ToString() + ";" + (*aggregate.Read().Item).ToString() + ";" +
                                (*array.Read()[0]).ToString() + ";" + Factory.MissingReadOnlyArray(zeroLength.Read()).ToString() + ";" +
                                Factory.MissingNullableArray(nullableArray.Read()).ToString() + ";" +
                                nestedScalar.Read().ToString() + ";" + (nestedNullable.Read() == nil).ToString()
                        }
                    }
                }
                """, native, values);
            IlVerifier.Verify(emitted, new[] { native, values });
            AssertNativeConsumer(directory, emitted, "LegalPrimary4755Controls.Api", "7/7;8/8;True;0;True;7;7;True;True;0;True", native, values);
        });
    }

    private static object Invoke(Assembly assembly, string typeName) =>
        assembly.GetType(typeName, throwOnError: true).GetMethod("Run").Invoke(null, null);

    private static string Compile(string directory, string source, params string[] references)
    {
        var result = TryCompile(directory, source, references);
        Assert.True(result.Code == 0, result.Output);
        return result.AssemblyPath;
    }

    private static (int Code, string AssemblyPath, string Output) TryCompile(string directory, string source, params string[] references)
    {
        var sourcePath = Path.Combine(directory, "Fixture.gs");
        var assemblyPath = Path.Combine(directory, "Fixture.dll");
        File.WriteAllText(sourcePath, source);
        var arguments = new[] { "/target:library", "/assemblyname:Fixture", "/out:" + assemblyPath, "/targetframework:net10.0" }
            .Concat(RuntimeReferences().Concat(references).Select(path => "/reference:" + path))
            .Append(sourcePath).ToArray();
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        try
        {
            Console.SetOut(stdout);
            Console.SetError(stderr);
            var code = Program.Main(arguments);
            return (code, assemblyPath, stdout.ToString() + stderr);
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }
    }

    private static string EmitCSharp(string directory, string name, string source, params string[] references)
    {
        var path = Path.Combine(directory, name + ".dll");
        var compilation = CSharpCompilation.Create(
            name,
            new[] { CSharpSyntaxTree.ParseText(source) },
            RuntimeReferences().Concat(references).Select(reference => MetadataReference.CreateFromFile(reference)),
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var result = compilation.Emit(path);
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
        return path;
    }

    private static string[] RuntimeReferences() =>
        Directory.GetFiles(Path.GetDirectoryName(typeof(object).Assembly.Location), "*.dll");

    private static void InDirectory(Action<string> test)
    {
        var directory = Directory.CreateTempSubdirectory("gs_issue4755_").FullName;
        try
        {
            test(directory);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
