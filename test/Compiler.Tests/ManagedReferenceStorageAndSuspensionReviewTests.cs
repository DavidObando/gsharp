// <copyright file="ManagedReferenceStorageAndSuspensionReviewTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests;

public sealed class ManagedReferenceStorageAndSuspensionReviewTests
{
    private const string ImportedLocations = """
        namespace ImportedLocations;
        public struct Counter {
            public int Value;
            public void Update(int value) => Value = value;
        }
        public sealed class RefBox {
            private readonly Counter[] values = new Counter[1];
            public ref Counter this[int index] => ref values[index];
            public ref Counter Current => ref values[0];
            public Counter Copy => values[0];
        }
        """;

    [Theory]
    [InlineData(
        """
        class Holder {
            var Saved managed[int32]? = {
                var value = 1
                let scoped leaked managed[int32] = managed(value)
                leaked
            }
        }
        """)]
    [InlineData(
        """
        class Holder {
            shared {
                var Saved readonly managed[int32]? = {
                    var value = 1
                    let scoped leaked readonly managed[int32] = readonly managed(value)
                    leaked
                }
            }
        }
        """)]
    [InlineData(
        """
        class Holder[T] {
            var Saved managed[T]? = {
                var value T = default
                let scoped leaked managed[T] = managed(value)
                leaked
            }
        }
        """)]
    public void FieldInitializerResultsCannotStoreScopedHandles(string declaration)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            "package FieldInitializerSinks\n" + declaration,
            "FieldInitializerSinks",
            executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void SharedInitializerStatementsCannotStoreScopedHandles()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            """
            package SharedInitializerSink
            class Holder {
                shared {
                    var Saved readonly managed[int32]?
                    init {
                        var value = 1
                        let scoped leaked readonly managed[int32] = readonly managed(value)
                        Saved = leaked
                    }
                }
            }
            """, "SharedInitializerSink", executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(
        """
        var Saved managed[int32]? = {
            var value = 1
            let scoped leaked managed[int32] = managed(value)
            leaked
        }
        """)]
    [InlineData(
        """
        var Saved readonly managed[int32]? = {
            var value = 1
            let scoped leaked readonly managed[int32] = readonly managed(value)
            {
                leaked
            }
        }
        """)]
    public void GlobalInitializerResultsCannotStoreScopedHandles(string declaration)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var (code, output) = fixture.TryCompile(
            "package GlobalInitializerSink\n" + declaration,
            "GlobalInitializerSink",
            executable: true);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void ScalarResultsAndFunctionLocalHandleCopiesRemainSafeStorage()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var reference = Path.Combine(fixture.Directory, "ScalarStorageApi.ref.dll");
        var api = fixture.Compile(
            """
            package ScalarStorageApi
            public class Values {
                public var Instance int32 = {
                    var value = 1
                    let scoped handle managed[int32] = managed(value)
                    *handle
                }
                shared {
                    public var Static int32 = {
                        var value = 2
                        let scoped handle readonly managed[int32] = readonly managed(value)
                        *handle
                    }
                    public var Assigned int32
                    init {
                        var value = 3
                        let scoped handle managed[int32] = managed(value)
                        Assigned = *handle
                    }
                }
            }
            public func Copy(scoped value managed[int32]) int32 {
                let local managed[int32] = value
                return *local
            }
            """, "ScalarStorageApi", executable: false, "/refout:" + reference);
        IlVerifier.Verify(api);
        var consumer = fixture.CompileCSharp(
            """
            using ScalarStorageApi;
            public static class Consumer {
                public static int Run() => new Values().Instance + Values.Static + Values.Assigned;
            }
            """, "ScalarStorageConsumer", api, reference);
        IlVerifier.Verify(consumer, new[] { api });
        var assemblies = EmittedFixture.LoadTogether(api, consumer);
        Assert.Equal(6, assemblies[1].GetType("Consumer")!.GetMethod("Run")!.Invoke(null, null));
    }

    [Theory]
    [InlineData("managed[[]Counter]", "(*value)[0].Update(await Next())")]
    [InlineData("readonly managed[[]Counter]", "(*value)[0].Update(await Next())")]
    public void ArrayElementsSelectedThroughHandlesCannotCrossAwait(string handleType, string operation)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var source = $$"""
            package ArrayElementSuspension
            import System.Threading.Tasks
            struct Counter {
                var Value int32
                func Update(value int32) { this.Value = value }
            }
            async func Next() int32 {
                await Task.Delay(1)
                return 42
            }
            async func Bad(value {{handleType}}) { {{operation}} }
            """;
        var (code, output) = fixture.TryCompile(source, "ArrayElementSuspension", executable: false);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("managed[RefBox]", "(*value)[0].Update(await Next())")]
    [InlineData("readonly managed[RefBox]", "(*value)[0].Update(await Next())")]
    [InlineData("managed[RefBox]", "(*value).Current.Update(await Next())")]
    [InlineData("readonly managed[RefBox]", "(*value).Current.Update(await Next())")]
    public void ImportedRefLocationsSelectedThroughHandlesCannotCrossAwait(string handleType, string operation)
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var library = fixture.CompileCSharp(ImportedLocations, "ImportedLocations");
        var source = $$"""
            package ImportedLocationSuspension
            import ImportedLocations
            import System.Threading.Tasks
            async func Next() int32 {
                await Task.Delay(1)
                return 42
            }
            async func Bad(value {{handleType}}) { {{operation}} }
            """;
        var (code, output) = fixture.TryCompile(
            source,
            "ImportedLocationSuspension",
            executable: false,
            "/r:" + library);
        Assert.NotEqual(0, code);
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal);
    }

    [Fact]
    public void PreAwaitCopiesAndImportedByValuePropertiesRemainValid()
    {
        using var fixture = new NativeSliceLanguageTests.Fixture();
        var library = fixture.CompileCSharp(ImportedLocations, "ImportedLocationControls");
        var reference = Path.Combine(fixture.Directory, "LocationControlApi.ref.dll");
        var api = fixture.Compile(
            """
            package LocationControlApi
            import ImportedLocations
            import System.Threading.Tasks
            public class Api {
                shared {
                    private async func Next() int32 {
                        await Task.Delay(1)
                        return 42
                    }
                    public async func Writable(value managed[RefBox]) int32 {
                        var copy = (*value).Current
                        let result = await Next()
                        copy.Update(result)
                        (*value).Copy.Update(await Next())
                        return result
                    }
                    public async func Readonly(value readonly managed[RefBox]) int32 {
                        let result = await Next()
                        (*value).Copy.Update(await Next())
                        return result
                    }
                }
            }
            """, "LocationControlApi", executable: false, "/r:" + library, "/refout:" + reference);
        IlVerifier.Verify(api, new[] { library });
        var consumer = fixture.CompileCSharp(
            """
            using Gsharp.Values;
            using ImportedLocations;
            using LocationControlApi;
            public static class Consumer {
                public static int Run() {
                    var boxes = new[] { new RefBox() };
                    var handle = ManagedRef<RefBox>.FromArray(boxes, 0);
                    return Api.Writable(handle).GetAwaiter().GetResult()
                        + Api.Readonly(handle.AsReadOnly()).GetAwaiter().GetResult();
                }
            }
            """, "LocationControlConsumer", library, reference);
        IlVerifier.Verify(consumer, new[] { library, api });
        var assemblies = EmittedFixture.LoadTogether(library, api, consumer);
        Assert.Equal(84, assemblies[2].GetType("Consumer")!.GetMethod("Run")!.Invoke(null, null));
    }
}
