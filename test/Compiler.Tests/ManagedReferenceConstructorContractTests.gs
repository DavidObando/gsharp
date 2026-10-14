// <copyright file="ManagedReferenceConstructorContractTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.IO
import System.Reflection
import Xunit

class ManagedReferenceConstructorContractTests {
    @Theory
    @InlineData("class Holder(scoped Value managed[int32]) { }")
    @InlineData("class Holder(scoped Value managed[int32]?) { }")
    @InlineData("class Holder(scoped Value readonly managed[int32]) { }")
    @InlineData("class Holder[T](scoped Value managed[T]) { }")
    func ScopedManagedPrimaryConstructorParametersAreRejected(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package ScopedPrimary\n" + declaration,
            "ScopedPrimary",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Fact
    func ScalarPrimaryParametersAndScopedExplicitPermissionsRemainValid() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ConstructorControls
import System
class Scalar(scoped Value int32) { }
class Reader {
    var Number int32
    init(scoped value readonly managed[int32]) { this.Number = *value }
}
func Read(scoped value managed[int32]) int32 {
    let scalar = Scalar(*value)
    let reader = Reader(value.AsReadOnly())
    return scalar.Value + reader.Number
}
func Main() {
    var value = 21
    Console.WriteLine(Read(managed(value)))
}`, "ConstructorControls", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("42\n", fixture.Run(dll))
    }

    @Fact
    func ExplicitScopedConstructorsAcceptRefinedAliasesAndStoreOnlyScalarCopies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ScopedExplicitConstructors
import System
class Reader {
    var Number int32
    init(scoped value managed[int32]) { this.Number = *value }
}
class ReadOnlyReader {
    var Number int32
    init(scoped value readonly managed[int32]) { this.Number = *value }
}
func Read(scoped value managed[int32]?) int32 {
    let refined = value!!
    let writable = Reader(refined)
    let readonly = ReadOnlyReader(refined.AsReadOnly())
    return writable.Number + readonly.Number
}
func Main() {
    var value = 21
    Console.WriteLine(Read(managed(value)))
}`, "ScopedExplicitConstructors", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("42\n", fixture.Run(dll))
    }

    @Fact
    func ConvenienceChainingHonorsScopedTargetParameters() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ScopedConstructorChaining
import System
class Reader {
    var Number int32
    init(scoped value managed[int32], marker int32) { this.Number = *value + marker }
    convenience init(scoped value managed[int32]?) { init(value!!, 1) }
}
func Read(scoped value managed[int32]?) int32 { return Reader(value).Number }
func Main() {
    var value = 41
    Console.WriteLine(Read(managed(value)))
}`, "ScopedConstructorChaining", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("42\n", fixture.Run(dll))
    }

    @Theory
    @InlineData("managed[int32]", "value")
    @InlineData("managed[int32]?", "value!!")
    func ConvenienceChainingCannotRetainScopedArguments(parameterType string, argument string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = (`package UnsafeConstructorChaining
class Holder {
    var Saved managed[int32]?
    init(value managed[int32]) { this.Saved = value }
    convenience init(scoped value ` + "$parameterType" + `, marker int32) { init(` + "$argument" + `) }
}`)
        let (code, output) = fixture.TryCompile(source, "UnsafeConstructorChaining", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Fact
    func ImportedConstructorsDoNotInventAContractMissingFromMetadata() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ConstructorApi.ref.dll")
        let api = fixture.Compile(`package ConstructorApi
public class Reader {
    public var Number int32
    public init(scoped value managed[int32]) { this.Number = *value }
}`, "ConstructorApi", executable: false, "/refout:" + reference)
        IlVerifier.Verify(api)
        let (code, output) = fixture.TryCompile(`package ConstructorConsumer
import ConstructorApi
func Read(scoped value managed[int32]) int32 { return Reader(value).Number }`, "ConstructorConsumer", executable: false, "/r:" +
                api)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("class Holder { var Location managed[int32] }")
    @InlineData("class Holder[T] { var Location managed[T] }")
    @InlineData("class Holder(Value int32) { var Location managed[int32] }")
    @InlineData("class Holder { var Location managed[int32]\ninit() { } }")
    @InlineData("struct Holder { private var Marker int32 = 1\nvar Location managed[int32] }")
    @InlineData("interface Holder { shared { var Location managed[int32] } }")
    func EveryCompilerOwnedConstructorPathInitializesRequiredFields(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "package RequiredConstructorFields\n" + declaration,
            "RequiredConstructorFields",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0604:", output, StringComparison.Ordinal)
    }

    @Fact
    func InitializedPrimaryExplicitAndForeignDefaultBoundariesRemainValid() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package RequiredConstructorControls
class Initialized {
    var Location managed[int32] = {
        var value = 1
        managed(value)
    }
}
class Primary(Location managed[int32]) { }
class Explicit {
    var Location managed[int32]
    init(value managed[int32]) { this.Location = value }
}
struct ForeignDefaultBoundary { var Location managed[int32] }`, "RequiredConstructorControls", executable: false)
        IlVerifier.Verify(dll)
    }

    @Fact
    func InitializedDefaultConstructorAndFieldRemainObservableAcrossAssemblies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "RequiredFieldApi.ref.dll")
        let api = fixture.Compile(`package RequiredFieldApi
public class Holder {
    public var Location managed[int32] = {
        var value = 42
        managed(value)
    }
}`, "RequiredFieldApi", executable: false, "/refout:" + reference)
        IlVerifier.Verify(api)
        let consumer = fixture.CompileCSharp(`using RequiredFieldApi;
public static class Consumer {
    public static int Run() => new Holder().Location.Borrow();
}`, "RequiredFieldConsumer", api, reference)
        IlVerifier.Verify(consumer, []string{api})
        let assemblies = EmittedFixture.LoadTogether(api, consumer)
        Assert.Equal(42, assemblies[1].GetType("Consumer")!!.GetMethod("Run")!!.Invoke(nil, nil))
    }
}
