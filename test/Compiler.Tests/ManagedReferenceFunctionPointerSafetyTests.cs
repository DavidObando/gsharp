// <copyright file="ManagedReferenceFunctionPointerSafetyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceFunctionPointerSafetyTests
{
    [Theory]
    [InlineData(
        """
        unsafe func Read(scoped value managed[int32]) int32 { return *value }
        unsafe func Bad(scoped value managed[int32]) int32 {
            let pointer *func(managed[int32]) int32 = &Read
            return pointer(value)
        }
        """)]
    [InlineData(
        """
        unsafe func Bad(scoped value readonly managed[int32], pointer *func(readonly managed[int32]) int32) int32 {
            return pointer(value)
        }
        """)]
    [InlineData(
        """
        unsafe struct Dispatch {
            var Pointer *func(int32, managed[int32], int32) int32
            prop Invoke *func(int32, managed[int32], int32) int32 -> Pointer
        }
        unsafe func Bad(scoped value managed[int32], dispatch Dispatch) int32 {
            return dispatch.Pointer(1, value, 2) + dispatch.Invoke(3, value, 4)
        }
        """)]
    [InlineData(
        """
        unsafe func Bad[T](scoped value readonly managed[T]?, pointers []*func(readonly managed[T]?) int32) int32 {
            return pointers[0](value)
        }
        """)]
    public void ScopedHandlesCannotFlowThroughManagedFunctionPointers(string declaration)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            "package ScopedFunctionPointerReject\n" + declaration,
            "ScopedFunctionPointerReject",
            executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void UnmanagedFunctionPointerSignaturesDoNotCreateAScopedContract()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            """
            package ScopedUnmanagedFunctionPointerReject
            unsafe func Bad(
                scoped value managed[int32],
                pointer unmanaged[Cdecl] (managed[int32]) -> int32) int32 {
                return pointer(value)
            }
            """, "ScopedUnmanagedFunctionPointerReject", executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ScalarArgumentsAndOrdinaryHandleRoundTripsRemainValidAcrossRefout()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "FunctionPointerHandleApi.ref.dll");
        var api = fixture.Compile(
            """
            package FunctionPointerHandleApi
            public unsafe class Api {
                shared {
                    private func Increment(value int32) int32 { return value + 1 }
                    private func Echo(value managed[int32]) managed[int32] { return value }
                    public func Invoke(value readonly managed[int32]) int32 {
                        let pointer *func(int32) int32 = &Api.Increment
                        return pointer(*value)
                    }
                    public func RoundTrip(value managed[int32]) managed[int32] {
                        let pointer *func(managed[int32]) managed[int32] = &Api.Echo
                        return pointer(value)
                    }
                }
            }
            """, "FunctionPointerHandleApi", executable: false, "/refout:" + reference);
        var consumer = fixture.CompileCSharp(
            """
            using Gsharp.Values;
            using FunctionPointerHandleApi;
            public static class Consumer {
                public static int Run() {
                    var values = new[] { 41 };
                    var handle = ManagedRef<int>.FromArray(values, 0);
                    ref var observed = ref Api.RoundTrip(handle).Borrow();
                    return Api.Invoke(handle.AsReadOnly()) + observed;
                }
            }
            """, "FunctionPointerHandleConsumer", api, reference);
        IlVerifier.Verify(consumer, new[] { api });
        var assemblies = EmittedFixture.LoadTogether(api, consumer);
        Assert.Equal(83, assemblies[1].GetType("Consumer")!.GetMethod("Run")!.Invoke(null, null));
    }
}
