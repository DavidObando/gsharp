// <copyright file="ManagedReferenceStorageAndSuspensionReviewTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.IO
import System.Reflection
import Xunit

class ManagedReferenceStorageAndSuspensionReviewTests {
    @Theory
    @InlineData(`class Holder {
    var Saved managed[int32]? = {
        var value = 1
        let scoped leaked managed[int32] = managed(value)
        leaked
    }
}`)
    @InlineData(`class Holder {
    shared {
        var Saved readonly managed[int32]? = {
            var value = 1
            let scoped leaked readonly managed[int32] = readonly managed(value)
            leaked
        }
    }
}`)
    @InlineData(`class Holder[T] {
    var Saved managed[T]? = {
        var value T = default
        let scoped leaked managed[T] = managed(value)
        leaked
    }
}`)
    func FieldInitializerResultsCannotStoreScopedHandles(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package FieldInitializerSinks\n" + declaration,
            "FieldInitializerSinks",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Fact
    func SharedInitializerStatementsCannotStoreScopedHandles() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package SharedInitializerSink
class Holder {
    shared {
        var Saved readonly managed[int32]?
        init {
            var value = 1
            let scoped leaked readonly managed[int32] = readonly managed(value)
            Saved = leaked
        }
    }
}`, "SharedInitializerSink", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData(`var Saved managed[int32]? = {
    var value = 1
    let scoped leaked managed[int32] = managed(value)
    leaked
}`)
    @InlineData(`var Saved readonly managed[int32]? = {
    var value = 1
    let scoped leaked readonly managed[int32] = readonly managed(value)
    {
        leaked
    }
}`)
    func GlobalInitializerResultsCannotStoreScopedHandles(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package GlobalInitializerSink\n" + declaration,
            "GlobalInitializerSink",
            executable: true
        )
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Fact
    func ScalarResultsAndFunctionLocalHandleCopiesRemainSafeStorage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ScalarStorageApi.ref.dll")
        let api = fixture.Compile(`package ScalarStorageApi
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
}`, "ScalarStorageApi", executable: false, "/refout:" + reference)
        IlVerifier.Verify(api)
        let consumer = fixture.CompileCSharp(`using ScalarStorageApi;
public static class Consumer {
    public static int Run() => new Values().Instance + Values.Static + Values.Assigned;
}`, "ScalarStorageConsumer", api, reference)
        IlVerifier.Verify(consumer, []string{api})
        let assemblies = EmittedFixture.LoadTogether(api, consumer)
        Assert.Equal(6, assemblies[1].GetType("Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
    }

    @Theory
    @InlineData("managed[[]Counter]", "(*value)[0].Update(await Next())")
    @InlineData("readonly managed[[]Counter]", "(*value)[0].Update(await Next())")
    func ArrayElementsSelectedThroughHandlesCannotCrossAwait(handleType string, operation string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = (`package ArrayElementSuspension
import System.Threading.Tasks
struct Counter {
    var Value int32
    func Update(value int32) { this.Value = value }
}
async func Next() int32 {
    await Task.Delay(1)
    return 42
}
async func Bad(value ` + "$handleType" + `) { ` + "$operation" + ` }`)
        let (code, output) = fixture.TryCompile(source, "ArrayElementSuspension", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("managed[RefBox]", "(*value)[0].Update(await Next())")
    @InlineData("readonly managed[RefBox]", "(*value)[0].Update(await Next())")
    @InlineData("managed[RefBox]", "(*value).Current.Update(await Next())")
    @InlineData("readonly managed[RefBox]", "(*value).Current.Update(await Next())")
    func ImportedRefLocationsSelectedThroughHandlesCannotCrossAwait(handleType string, operation string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(ImportedLocations, "ImportedLocations")
        let source = (`package ImportedLocationSuspension
import ImportedLocations
import System.Threading.Tasks
async func Next() int32 {
    await Task.Delay(1)
    return 42
}
async func Bad(value ` + "$handleType" + `) { ` + "$operation" + ` }`)
        let (code, output) = fixture.TryCompile(
            source,
            "ImportedLocationSuspension",
            executable: false,
            "/r:" + library
        )
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Fact
    func PreAwaitCopiesAndImportedByValuePropertiesRemainValid() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let library = fixture.CompileCSharp(ImportedLocations, "ImportedLocationControls")
        let reference = Path.Combine(fixture.Directory, "LocationControlApi.ref.dll")
        let api = fixture.Compile(`package LocationControlApi
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
}`, "LocationControlApi", executable: false, "/r:" + library, "/refout:" + reference)
        IlVerifier.Verify(api, []string{library})
        let consumer = fixture.CompileCSharp(`using Gsharp.Values;
using ImportedLocations;
using LocationControlApi;
public static class Consumer {
    public static int Run() {
        var boxes = new[] { new RefBox() };
        var handle = ManagedRef<RefBox>.FromArray(boxes, 0);
        return Api.Writable(handle).GetAwaiter().GetResult()
            + Api.Readonly(handle.AsReadOnly()).GetAwaiter().GetResult();
    }
}`, "LocationControlConsumer", library, reference)
        IlVerifier.Verify(consumer, []string{library, api})
        let assemblies = EmittedFixture.LoadTogether(library, api, consumer)
        Assert.Equal(84, assemblies[2].GetType("Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
    }

    shared {
        private const ImportedLocations string = `namespace ImportedLocations;
public struct Counter {
    public int Value;
    public void Update(int value) => Value = value;
}
public sealed class RefBox {
    private readonly Counter[] values = new Counter[1];
    public ref Counter this[int index] => ref values[index];
    public ref Counter Current => ref values[0];
    public Counter Copy => values[0];
}`
    }
}
