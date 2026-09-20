// <copyright file="ManagedReferenceOperatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceOperatorTests
{
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
}
