// <copyright file="ManagedReferenceOperatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceOperatorTests
{
    private const string RetainingOperators = """
        using Gsharp.Values;
        namespace ForeignOperators;
        public sealed class Probe {
            public static ManagedRef<int>? Retained;
            public static bool operator ==(Probe left, ManagedRef<int> right) { Retained = right; return true; }
            public static bool operator !=(Probe left, ManagedRef<int> right) => !(left == right);
            public static bool operator ==(ManagedRef<int> left, Probe right) { Retained = left; return true; }
            public static bool operator !=(ManagedRef<int> left, Probe right) => !(left == right);
            public override bool Equals(object? other) => other is Probe;
            public override int GetHashCode() => 0;
        }
        public sealed class ImplicitBox {
            public static ManagedRef<int>? Retained;
            public static implicit operator ImplicitBox(ManagedRef<int> value) {
                Retained = value;
                return new ImplicitBox();
            }
        }
        public sealed class ExplicitBox {
            public static ManagedRef<int>? Retained;
            public static explicit operator ExplicitBox(ManagedRef<int> value) {
                Retained = value;
                return new ExplicitBox();
            }
        }
        public sealed class ScalarProbe {
            public int Value;
            public static bool operator ==(ScalarProbe left, int right) => left.Value == right;
            public static bool operator !=(ScalarProbe left, int right) => !(left == right);
            public override bool Equals(object? other) => other is ScalarProbe probe && probe.Value == Value;
            public override int GetHashCode() => Value;
        }
        """;

    [Fact]
    public void ResolvedOperatorOwnerSurvivesBothOperandOrdersAndRefout()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var probe = fixture.CompileCSharp(
            """
            using Gsharp.Values;
            using System.Collections.Generic;
            namespace ForeignOperators;
            public sealed class Probe<T> {
                public T Value;
                public static bool operator ==(Probe<T> left, ManagedRef<T> right) => EqualityComparer<T>.Default.Equals(left.Value, right.Borrow());
                public static bool operator !=(Probe<T> left, ManagedRef<T> right) => !(left == right);
                public static bool operator ==(ManagedRef<T> left, Probe<T> right) => EqualityComparer<T>.Default.Equals(left.Borrow(), right.Value);
                public static bool operator !=(ManagedRef<T> left, Probe<T> right) => !(left == right);
                public static bool operator ==(Probe<T> left, Probe<T> right) => EqualityComparer<T>.Default.Equals(left.Value, right.Value);
                public static bool operator !=(Probe<T> left, Probe<T> right) => !(left == right);
                public override bool Equals(object? other) => other is Probe<T> probe && EqualityComparer<T>.Default.Equals(Value, probe.Value);
                public override int GetHashCode() => 0;
            }
            """, "ForeignOperators");
        var reference = Path.Combine(fixture.Directory, "OperatorApi.ref.dll");
        var api = fixture.Compile(
            """
            package OperatorApi
            import ForeignOperators
            class Api {
                shared {
                    func Left(p Probe[int32], h managed[int32]) bool { return p == h }
                    func Right(h managed[int32], p Probe[int32]) bool { return h == p }
                    func Ordinary(p Probe[int32], q Probe[int32]) bool { return p == q }
                    func Handles[T](p managed[T], q managed[T]) bool { return p == q }
                }
            }
            """, "OperatorApi", false, "/r:" + probe, "/refout:" + reference);
        IlVerifier.Verify(api, new[] { probe });
        var consumer = fixture.CompileCSharp(
            """
            using ForeignOperators;
            using Gsharp.Values;
            using OperatorApi;
            public static class Consumer {
                public static bool Run() {
                    var p = new Probe<int> { Value = 42 };
                    var values = new[] { 42 };
                    var h = ManagedRef<int>.FromArray(values, 0);
                    return Api.Left(p, h) && Api.Right(h, p) && Api.Ordinary(p, p)
                        && Api.Handles(h, ManagedRef<int>.FromArray(values, 0));
                }
            }
            """, "Consumer", probe, reference);
        var assemblies = EmittedFixture.LoadTogether(api, consumer);
        Assert.Equal(true, assemblies[1].GetType("Consumer").GetMethod("Run").Invoke(null, null));
        var il = LanguageConformance.NormalizedIlDump.Create(api);
        Assert.Contains("ForeignOperators.Probe", il);
        Assert.Contains("Gsharp.Values.ManagedRef", il);
    }

    [Theory]
    [InlineData("return p == h")]
    [InlineData("return h == p")]
    public void ImportedBinaryOperatorsCannotRetainScopedHandles(string operation)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var library = fixture.CompileCSharp(RetainingOperators, "RetainingOperators");
        var (code, output) = fixture.TryCompile(
            $$"""
            package ImportedOperatorEscape
            import ForeignOperators
            func Escape(scoped h managed[int32], p Probe) bool { {{operation}} }
            """, "ImportedOperatorEscape", executable: false, "/r:" + library);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedConversionOperatorsCannotRetainScopedHandles()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var library = fixture.CompileCSharp(RetainingOperators, "RetainingConversions");
        var (code, output) = fixture.TryCompile(
            """
            package ImportedConversionEscape
            import ForeignOperators
            func Implicit(scoped h managed[int32]) ImplicitBox { return h }
            func Explicit(scoped h managed[int32]) ExplicitBox { return ExplicitBox(h) }
            """, "ImportedConversionEscape", executable: false, "/r:" + library);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ImportedOperatorsAcceptValuesCopiedFromScopedHandles()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var library = fixture.CompileCSharp(RetainingOperators, "ScalarOperators");
        var dll = fixture.Compile(
            """
            package ScalarOperatorCopies
            import ForeignOperators
            import System
            func Compare(scoped h managed[int32], p ScalarProbe) bool { return p == *h }
            func Main() {
                var value = 42
                Console.WriteLine(Compare(managed(value), ScalarProbe{Value: 42}))
            }
            """, "ScalarOperatorCopies", executable: true, "/r:" + library);
        IlVerifier.Verify(dll, new[] { library });
        Assert.Equal("True\n", fixture.Run(dll));
    }

    [Fact]
    public void SameCompilationScopedOperatorsAndManagedEqualityRemainValid()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "ScopedOperatorApi.ref.dll");
        var dll = fixture.Compile(
            """
            package ScopedOperatorApi
            import System
            public class Probe { public var Number int32 }
            public func (left Probe) operator ==(scoped right managed[int32]) bool -> left.Number == *right
            public func (left Probe) operator !=(scoped right managed[int32]) bool -> !(left == right)
            public class Box { public var Number int32 }
            public func operator implicit(scoped value managed[int32]) Box -> Box{Number: *value}
            public func Use(scoped value managed[int32], scoped other managed[int32]) int32 {
                let probe = Probe{Number: *value}
                let box Box = value
                if !(probe == value) { return -1 }
                if value != other { return -2 }
                return box.Number
            }
            func Main() {
                var value = 42
                let handle = managed(value)
                Console.WriteLine(Use(handle, handle))
            }
            """, "ScopedOperatorApi", executable: true, "/refout:" + reference);
        IlVerifier.Verify(dll);
        Assert.True(File.Exists(reference));
        Assert.Equal("42\n", fixture.Run(dll));
    }

    [Fact]
    public void SameCompilationNonScopedConversionStillRejectsScopedHandles()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            """
            package UnsafeLocalConversion
            class Box { var Saved managed[int32]? }
            func operator implicit(value managed[int32]) Box -> Box{Saved: value}
            func Escape(scoped value managed[int32]) Box { return value }
            """, "UnsafeLocalConversion", executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ReimportedOperatorsDoNotInventTheLostScopedContract()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "OperatorProducer.ref.dll");
        var producer = fixture.Compile(
            """
            package OperatorProducer
            public class Probe { public var Number int32 }
            public func (left Probe) operator ==(scoped right managed[int32]) bool -> left.Number == *right
            public func (left Probe) operator !=(scoped right managed[int32]) bool -> !(left == right)
            """, "OperatorProducer", executable: false, "/refout:" + reference);
        IlVerifier.Verify(producer);

        var (code, output) = fixture.TryCompile(
            """
            package OperatorConsumer
            import OperatorProducer
            func Escape(scoped value managed[int32], probe Probe) bool { return probe == value }
            """, "OperatorConsumer", executable: false, "/r:" + producer);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }
}
