// <copyright file="ManagedReferenceMethodGroupSafetyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceMethodGroupSafetyTests
{
    [Theory]
    [InlineData(
        """
        func (p managed[int32]) Read() int32 { return *p }
        func Bad(scoped p managed[int32]) () -> int32 { return p.Read }
        """)]
    [InlineData(
        """
        func Bad(scoped p managed[int32]) () -> readonly managed[int32] { return p.AsReadOnly }
        """)]
    [InlineData(
        """
        func (p readonly managed[int32]) Read() int32 { return *p }
        delegate Reader() int32;
        func Bad(scoped p readonly managed[int32]) Reader {
            let saved Reader = p.Read
            return saved
        }
        """)]
    [InlineData(
        """
        func (p managed[T]) Read[T]() T { return *p }
        func Keep[T](value () -> T) { }
        func Bad[T](scoped p managed[T]?) { Keep((p!!).Read) }
        """)]
    [InlineData(
        """
        func (p managed[int32]) Read() int32 { return *p }
        func Bad(scoped p managed[int32]) () -> int32 {
            let saved = p.Read
            return saved
        }
        """)]
    public void ScopedHandleReceiversCannotBecomeDelegateTargets(string declaration)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            "package ScopedMethodGroupReject\n" + declaration,
            "ScopedMethodGroupReject",
            executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void LambdaEquivalentScopedCaptureRemainsRejected()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            """
            package ScopedMethodGroupLambdaReject
            func Bad(scoped p readonly managed[int32]) () -> int32 {
                return func () int32 { return *p }
            }
            """, "ScopedMethodGroupLambdaReject", executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void StaticGroupsScalarTargetsAndDirectCallsRemainValid()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var dll = fixture.Compile(
            """
            package ScopedMethodGroupControls
            import System
            func Format(value int32) string { return value.ToString() }
            func Use(scoped p readonly managed[int32]) string {
                let staticGroup (int32) -> string = Format
                let scalar = *p
                let scalarGroup () -> string = scalar.ToString
                return staticGroup(scalar) + ":" + scalarGroup()
            }
            func Main() {
                var value = 42
                Console.WriteLine(Use(readonly managed(value)))
            }
            """, "ScopedMethodGroupControls", executable: true);
        IlVerifier.Verify(dll);
        Assert.Equal("42:42\n", fixture.Run(dll));
    }

    [Fact]
    public void NonScopedSourceAndClrMethodGroupsReimportAndVerify()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "MethodGroupHandleApi.ref.dll");
        var api = fixture.Compile(
            """
            package MethodGroupHandleApi
            public func (p managed[int32]) Read() int32 { return *p }
            public class Api {
                shared {
                    public func Capture(value managed[int32]) () -> int32 { return value.Read }
                    public func Readonly(value managed[int32]) () -> readonly managed[int32] {
                        return value.AsReadOnly
                    }
                }
            }
            """, "MethodGroupHandleApi", executable: false, "/refout:" + reference);
        IlVerifier.Verify(api);
        var consumer = fixture.CompileCSharp(
            """
            using Gsharp.Values;
            using MethodGroupHandleApi;
            public static class Consumer {
                public static int Run() {
                    var values = new[] { 42 };
                    var handle = ManagedRef<int>.FromArray(values, 0);
                    var read = Api.Capture(handle);
                    var asReadonly = Api.Readonly(handle);
                    ref readonly var observed = ref asReadonly().Borrow();
                    return read() + observed;
                }
            }
            """, "MethodGroupHandleConsumer", api, reference);
        IlVerifier.Verify(consumer, new[] { api });
        var assemblies = EmittedFixture.LoadTogether(api, consumer);
        Assert.Equal(84, assemblies[1].GetType("Consumer")!.GetMethod("Run")!.Invoke(null, null));
    }
}
