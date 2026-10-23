// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Text.Json
import Xunit

class NativeProtocolLanguageTests {
    @Fact
    func RoundFourIncidentalUnexportableCapabilitiesDoNotDiscardInternalEntries() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "InternalCapabilities.ref.dll")
        let implementation = fixture.Compile(`package InternalCapabilities
internal protocol P { func Read() int32; }
public protocol Unused { func Read() int32; }
public struct Value : P {}
internal shared class HiddenWitnesses {}
@ExtensionOwner(typeof(HiddenWitnesses))
public func (value Value) Read() int32 -> 17
public func ReadHidden() int32 {
let value P = Value{}
return value.Read()
}
`, "InternalCapabilities", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let caller = fixture.Compile(`import System
import InternalCapabilities
Console.WriteLine(ReadHidden())
`, "incidental-hidden-witness", executable: true, "/r:" + image)
            IlVerifier.Verify(caller, []string{implementation})
            Assert.Equal("17\n", fixture.Run(caller))
        }
    }

    @Theory
    @InlineData("internal func Probe(value P) bool -> value is Unused")
    @InlineData("internal func Probe() bool -> Value{} is Unused")
    func RoundFourUnexportableIncidentalCapabilitiesRemainUnknown(probe string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`internal protocol P { func Read() int32; }
public protocol Unused { func Read() int32; }
public struct Value : P {}
internal shared class HiddenWitnesses {}
@ExtensionOwner(typeof(HiddenWitnesses))
public func (value Value) Read() int32 -> 17
internal func Make() P -> Value{}
` + probe, "unknown-incidental-capability", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629"), output)
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RoundFourImportedOverloadsUseExactNativeConformance(instance bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "NativeOverloads.ref.dll")
        let methods = `public func Pick(value Readable) int32 -> value.Read()
public func Pick(value Writable) int32 -> value.Write()`
        let source = `package NativeOverloads
public protocol Readable { func Read() int32; }
public protocol Writable { func Write() int32; }
public struct Reader { public func Read() int32 -> 17 }
public func Make() Readable -> Reader{}
` + if instance {
            "public class API {\n" + methods + "\n}"
        } else {
            "public class API { shared {\n" + methods + "\n} }"
        }
        let implementation = fixture.Compile(source, "NativeOverloads", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let caller = fixture.Compile(`import System
import NativeOverloads
` + if instance {
                    "Console.WriteLine(API().Pick(Reader{}))"
                } else {
                    "Console.WriteLine(API.Pick(Reader{}))"
                }, "native-overload-caller", executable: true, "/r:" + image)
            IlVerifier.Verify(caller, []string{implementation})
            Assert.Equal("17\n", fixture.Run(caller))
        }
    }

    @Theory
    @InlineData("throw value")
    @InlineData("let result = if true { throw value } else { 1 }")
    func RoundFourNativeStorageCannotEscapeThroughExceptionTransport(statement string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`import System
protocol P {}
class NativeError : Exception { private var Saved P? }
func Escape(value NativeError) object? {
try {
` + statement + `
} catch (error Exception) { return error }
return nil
}`, "native-throw-boundary", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("throw"), output)
    }

    @Fact
    func RoundFourProtocolOverloadsUseInsertionsFromLaterBoundFactories() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`import System
protocol Message {}
protocol Readable { func Read() int32; }
protocol Writable { func Write() int32; }
struct Reader { func Read() int32 -> 17 }
func Pick(value Readable) int32 -> value.Read()
func Pick(value Writable) int32 -> value.Write()
func Forward(value Message) int32 -> Pick(value)
class Factory { shared { func Make() Message -> Reader{} } }
Console.WriteLine(Forward(Factory.Make()))
Console.WriteLine(Pick(Factory.Make()))
`, "later-native-insertion", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("17\n17\n", fixture.Run(dll))
    }

    @Fact
    func RoundFourImportedProtocolOverloadsUseLaterLocalInsertions() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "LateContracts.ref.dll")
        let implementation = fixture.Compile(`package LateContracts
public protocol Message {}
public protocol Readable { func Read() int32; }
public protocol Writable { func Write() int32; }
`, "LateContracts", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let caller = fixture.Compile(`import System
import LateContracts
public struct Reader { public func Read() int32 -> 17 }
func Pick(value Readable) int32 -> value.Read()
func Pick(value Writable) int32 -> value.Write()
func Forward(value Message) int32 -> Pick(value)
class Factory { shared { func Make() Message -> Reader{} } }
Console.WriteLine(Forward(Factory.Make()))
Console.WriteLine(Pick(Factory.Make()))
`, "late-imported-caller", executable: true, "/r:" + image)
            IlVerifier.Verify(caller, []string{implementation})
            Assert.Equal("17\n17\n", fixture.Run(caller))
        }
    }

    @Theory
    @InlineData("func Check(value [2]?int32) bool;")
    @InlineData("func Check() [2]?int32;")
    func RoundFourNullableFixedArraySlotsRequireAdmission(slot string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "public protocol P { " + slot + " }",
            "nullable-fixed-native",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("fixed-array"), output)
    }

    @Theory
    @InlineData("func Bad(value Holder) int32 -> value")
    @InlineData("func Bad(value Holder?) int32? -> value")
    @InlineData("func Bad(value Holder) int32 -> -value")
    @InlineData("func Bad(left Holder?, right Holder?) int32? -> left + right")
    func RoundFourUnmarkedForeignOperatorsRequireNativeAdmission(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "NativeOperators.ref.dll")
        let implementation = fixture.CompileCSharpWithReference(`using System;
using System.Reflection;
using System.Runtime.CompilerServices;
[assembly: AssemblyMetadata("GSharp.NativeProtocolFeature", "6b105e95-6860-496a-9acb-d81bc250a275/1")]
[assembly: AssemblyMetadata("GSharp.NativeProtocols", """{"schema":"6b105e95-6860-496a-9acb-d81bc250a275/1","declarations":[{"type":"NativeOperators.P","slots":[]}],"entries":[]}""")]
namespace NativeOperators {
[Obsolete("GSharp.NativeProtocols.v1")] public interface P {}
[Obsolete("GSharp.NativeProtocols.v1")] public struct Holder {
private P? saved;
public static implicit operator int(Holder value) => 17;
public static int operator -(Holder value) => 17;
public static int operator +(Holder left, Holder right) => 17;
}
public static class Marker { public static CompilerFeatureRequiredAttribute Type => null!; }
}`, "NativeOperators", reference)
        for image in[]string{implementation, reference} {
            PromoteFixtureProtocolMarker(image)
            let (code, output) = fixture.TryCompile(
                "import NativeOperators\n" + declaration,
                "native-operator-caller",
                executable: false,
                "/r:" + image
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("foreign export"), output)
        }
    }

    @Fact
    func RoundFourNominalInterfaceStaticNativeStorageHasAnImportedContract() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "InterfaceStorage.ref.dll")
        let implementation = fixture.Compile(`package InterfaceStorage
public protocol P { func Read() int32; }
public struct Payload { public func Read() int32 -> 17 }
public struct Other { public func Read() int32 -> 23 }
public interface State { shared { public var Saved P = Payload{} } }
`, "InterfaceStorage", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let caller = fixture.Compile(`import System
import InterfaceStorage
Console.WriteLine(State.Saved.Read())
State.Saved = Other{}
Console.WriteLine(State.Saved.Read())
`, "interface-storage-caller", executable: true, "/r:" + image)
            IlVerifier.Verify(caller, []string{implementation})
            Assert.Equal("17\n23\n", fixture.Run(caller))
        }
    }

    @Theory
    @InlineData("wrapped is Holder { Saved: Counter captured }")
    @InlineData("wrapped is Holder { Saved: Counter }")
    func RoundFourSameProtocolNestedMemberInputsRequireIntermediateViews(pattern string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`protocol P {}
struct Counter {}
class Holder { public var Saved P
init(value P) { Saved = value } }
func Bad(wrapped P) bool -> ` + pattern, "same-native-nested-pattern", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("nested native pattern"), output)
    }

    @Theory
    @InlineData("let read () -> int32 = value.Read")
    @InlineData("let read = func () int32 { return value.Read() }")
    func RoundThreeDelegateTargetsCannotEraseCapturedNativeStorage(binding string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`protocol P {}
class Holder { private var Saved P?
func Read() int32 -> 17 }
func Bad(value Holder) object? {
` + binding + `
return read.Target
}
`, "captured-native-delegate", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("delegate"), output)
    }

    @Theory
    @InlineData("func Bad(value Holder) object? -> value as object")
    @InlineData("func Bad(value Holder) { if value is object escaped {} }")
    @InlineData("func Bad(value Holder) { switch value { case object escaped {} default {} } }")
    @InlineData("func Bad(value Wrapper) { if value is { Item: object escaped } {} }")
    @InlineData("func Bad(value Holder) { let hash () -> int32 = value.GetHashCode }")
    func RoundThreeStorageErasureAndHashGroupsRequireAdmission(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package StorageAdmission
public protocol P {}
public class Holder { private var Saved P? }
public class Wrapper { public var Item Holder }
`
        let (localCode, localOutput) = fixture.TryCompile(
            source + "\n" + declaration,
            "storage-admission-local",
            executable: false
        )
        Assert.NotEqual(0, localCode)
        Assert.Contains("GS0629", localOutput)
        let reference = Path.Combine(fixture.Directory, "StorageAdmission.ref.dll")
        let implementation = fixture.Compile(source, "StorageAdmission", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let (code, output) = fixture.TryCompile(
                "import StorageAdmission\n" + declaration,
                "storage-admission-caller",
                executable: false,
                "/r:" + image
            )
            Assert.NotEqual(0, code)
            Assert.Contains("GS0629", output)
        }
    }

    @Fact
    func RoundThreeImportedArraysKeepAnnotatedNativeDependencies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "NativeArrays.ref.dll")
        let implementation = fixture.Compile(`package NativeArrays
public protocol P {}
public func Make() []P -> []P{}
`, "NativeArrays", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let (code, output) = fixture.TryCompile(
                "import NativeArrays\nfunc Bad() object -> Make()",
                "native-array-caller",
                executable: false,
                "/r:" + image
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("cannot escape"), output)
        }
    }

    @Theory
    @InlineData("delegate D(value P)")
    @InlineData("delegate D() P?")
    @InlineData("delegate D(next D, value P)")
    @InlineData("delegate D(value P)\nfunc Bad(value D) object -> value")
    func RoundThreeNamedNativeDelegateDeclarationsAreNotAdmitted(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "protocol P {}\n" + declaration,
            "native-named-delegate",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("delegate"), output)
    }

    @Fact
    func RoundThreePublicNamedDelegatesRequireAccessibleSignaturePositions() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "internal protocol Hidden {}\npublic delegate D(value Hidden)",
            "native-private-delegate-contract",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("accessible contract"), output)
    }

    @Theory
    @InlineData("func Bad(value Box[Holder]) object -> value.Escape()")
    @InlineData("func Bad(value (Holder) -> Holder) {}")
    @InlineData("func Bad(value []Box[Holder]) {}")
    func RoundThreeGenericAndDelegateContractsCannotEraseSavedStorage(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`protocol P {}
class Holder { private var Saved P? }
class Box[T] { var Value T
func Escape() object -> Value }
` + declaration, "native-transitive-generic", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("delegate/generic"), output)
    }

    @Fact
    func RoundThreeUnmarkedForeignDelegateCannotCarrySavedNativeStorage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ForeignDelegates.ref.dll")
        let implementation = fixture.CompileCSharpWithReference(`using System;
using System.Reflection;
using System.Runtime.CompilerServices;
[assembly: AssemblyMetadata("GSharp.NativeProtocolFeature", "6b105e95-6860-496a-9acb-d81bc250a275/1")]
[assembly: AssemblyMetadata("GSharp.NativeProtocols", """{"schema":"6b105e95-6860-496a-9acb-d81bc250a275/1","declarations":[{"type":"ForeignDelegates.P","slots":[]}],"entries":[]}""")]
namespace ForeignDelegates {
[Obsolete("GSharp.NativeProtocols.v1")] public interface P {}
[Obsolete("GSharp.NativeProtocols.v1")] public sealed class Holder { private P? saved; }
public static class Foreign {
public static Holder Identity(Holder value) => value;
public static CompilerFeatureRequiredAttribute MarkerType => null!;
}
}`, "ForeignDelegates", reference)
        for image in[]string{implementation, reference} {
            PromoteFixtureProtocolMarker(image)
            let (code, output) = fixture.TryCompile(
                "import ForeignDelegates\nfunc Bad() { let callback (Holder) -> Holder = Foreign.Identity }",
                "foreign-native-delegate-caller",
                executable: false,
                "/r:" + image
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("delegate"), output)
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func RoundThreeLiftedAndImportedEqualityCannotObserveNativeStorage(imported bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package LiftedNative
public protocol P {}
public struct Holder { private var Saved P? }
public func (left Holder) operator ==(right Holder) bool -> true
public func (left Holder) operator !=(right Holder) bool -> false
`
        let declaration = "func Bad(left Holder?, right Holder?) bool -> left == right"
        if !imported {
            let (code, output) = fixture.TryCompile(source + declaration, "lifted-native-local", executable: false)
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("equality"), output)
            return
        }
        let reference = Path.Combine(fixture.Directory, "LiftedNative.ref.dll")
        let implementation = fixture.Compile(source, "LiftedNative", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let (code, output) = fixture.TryCompile(
                "import LiftedNative\n" + declaration,
                "lifted-native-caller",
                executable: false,
                "/r:" + image
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("equality"), output)
        }
    }

    @Theory
    @InlineData("[2]int32")
    @InlineData("(int32, [2]int32)")
    func RoundThreeFixedArraySlotsRequireAnAdmittedReferenceContract(type string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "FixedNative.ref.dll")
        let (code, output) = fixture.TryCompile(
            "public protocol P { func Check(value " +
                type +
                ") bool; }\n" +
                "public struct Worker : P { public func Check(value " +
                type +
                ") bool -> true }",
            "FixedNative",
            executable: false,
            "/refout:" + reference
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("fixed-array"), output)
        Assert.False(File.Exists(reference))
    }

    @Fact
    func RoundThreePublicConformanceCannotExportAnInternalExtensionOwner() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "HiddenWitness.ref.dll")
        let (code, output) = fixture.TryCompile(`public protocol P { func Read() int32; }
public struct Value : P {}
internal shared class HiddenWitnesses {}
@ExtensionOwner(typeof(HiddenWitnesses))
public func (value Value) Read() int32 -> 17
public func Make() P -> Value{}
`, "HiddenWitness", executable: false, "/refout:" + reference)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("owner"), output)
        Assert.False(File.Exists(reference))
    }

    @Fact
    func RoundThreeInternalOwnersAndCheckedMethodsRemainUsable() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ScopedWitness.ref.dll")
        let implementation = fixture.Compile(`package ScopedWitness
internal protocol P { func Read() int32; }
public protocol Stored {}
public struct Value : P { public var Number int32 }
internal shared class HiddenWitnesses {}
@ExtensionOwner(typeof(HiddenWitnesses))
public func (value Value) Read() int32 -> value.Number + 1
public class Holder { private var Saved Stored?
private var Number int32 = 10
public func Read() int32 { Number += 1
return Number } }
public func Make() Holder -> Holder()
public func ReadHidden() int32 { let value P = Value{Number: 16}
return value.Read() }
`, "ScopedWitness", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let caller = fixture.Compile(`import System
import ScopedWitness
Console.WriteLine(ReadHidden())
let holder = Make()
Console.WriteLine(holder.Read())
Console.WriteLine(holder.Read())
Console.WriteLine(holder is object)
Console.WriteLine(holder != nil)
`, "scoped-witness-caller", executable: true, "/r:" + image)
            IlVerifier.Verify(caller, []string{implementation})
            Assert.Equal("17\n11\n12\nTrue\nTrue\n", fixture.Run(caller))
        }
    }

    @Theory
    @InlineData(false)
    @InlineData(true)
    func NativeAutoPropertiesRequireAdmittedAccessorBoundaries(staticStorage bool) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let property = "public prop Value P? { get; set; }"
        let source = "public protocol P {}\npublic class Holder { " +
            (
            if staticStorage {
                "shared { " + property + " }"
            } else {
                property
            }
        ) +
            " }"
        let (code, output) = fixture.TryCompile(source, "AutoStorage", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("auto-property"), output)
    }

    @Fact
    func ProtocolArgumentOverloadsUseFinitePositiveCoverage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`import System
protocol Message {}
protocol Readable { func Read() int32; }
protocol Writable { func Write() int32; }
struct Reader { func Read() int32 -> 17 }
func Pick(value Readable) int32 -> value.Read()
func Pick(value Writable) int32 -> value.Write()
let message Message = Reader{}
Console.WriteLine(Pick(message))
`, "protocol-argument-overload", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("17\n", fixture.Run(dll))
    }

    @Fact
    func ProtocolAndObjectTargetsHaveSoundOverloadOrdering() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`import System
protocol P {}
class Concrete {}
func Pick(value P) int32 -> 17
func Pick(value object) int32 -> 99
Console.WriteLine(Pick(Concrete()))
`, "protocol-object-overload", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("17\n", fixture.Run(dll))
    }

    @Fact
    func ExpandingOrdinaryGenericStorageTerminatesWithoutNativeState() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`import System
class Node[T] { var Next Node[[]T]? }
func Read(value Node[int32]) int32 -> 17
Console.WriteLine(Read(Node[int32]()))
`, "protocol-free-expanding-storage", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("17\n", fixture.Run(dll))
    }

    @Fact
    func RequiredProtocolOverloadDoesNotAdmitAbsentArguments() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`import System
protocol P {}
func Pick(value P) int32 -> 17
func Pick(value object?) int32 -> 99
Console.WriteLine(Pick(nil))
`, "protocol-required-overload", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("99\n", fixture.Run(dll))
    }

    @Theory
    @InlineData("let result = holder is { Saved: Counter captured }")
    @InlineData("let result = holder is { Saved: Unknown captured }")
    @InlineData("let result = []P{holder.Saved} is [Counter captured]")
    @InlineData("let result = []P{holder.Saved} is [Unknown captured]")
    @InlineData("switch holder { case { Saved: Counter captured } { } default { } }")
    @InlineData("let result = switch holder { case { Saved: Counter captured }: 1\n default: 0 }")
    func NestedNativePatternInputsRequireIntermediateViews(statement string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`protocol P {}
protocol Unknown { func Missing() int32; }
struct Counter {}
class Holder { var Saved P
init(value P) { Saved = value } }
func Test(holder Holder) {
` + statement + "\n}", "protocol-nested-pattern", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("nested native pattern"), output)
    }

    @Theory
    @InlineData("init() {}")
    @InlineData("init(value P) { Value = value }")
    func RequiredNativeAutoPropertyCannotBypassTheAccessorGate(initializer string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "protocol P {}\nclass Holder { prop Value P { get; set; }\n" + initializer + "\n}",
            "protocol-required-auto-property",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("auto-property"), output)
    }

    @Theory
    @InlineData("public class Holder { public prop Value Hidden? { get; set; } }")
    @InlineData("public func Take(values []Hidden) {}")
    @InlineData("public func Take(values slice[Hidden]) {}")
    @InlineData("public func Take(values (Hidden?, int32)) {}")
    func NestedAndPropertyContractsRequireAccessibleProtocols(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(
            "internal protocol Hidden {}\n" + declaration,
            "protocol-private-contract",
            executable: false
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("accessible contract"), output)
    }

    @Theory
    @InlineData(false, "let escaped = wrapped as object")
    @InlineData(false, "let escaped = wrapped is object captured")
    @InlineData(true, "let escaped = wrapped as object")
    @InlineData(true, "let escaped = wrapped is object captured")
    func PayloadRecoveryCannotEraseSavedNativeStorage(imported bool, statement string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package SavedPayload
public protocol P {}
public struct Counter {}
public class Holder { var Saved P
public init(value P) { Saved = value } }
public func Make() P -> Holder(Counter{})
`
        if !imported {
            let (code, output) = fixture.TryCompile(
                source + "\nfunc Bad() { let wrapped = Make()\n" + statement + "\n}",
                "saved-payload-local",
                executable: false
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("saved-storage"), output)
            return
        }
        let reference = Path.Combine(fixture.Directory, "SavedPayload.ref.dll")
        let implementation = fixture.Compile(source, "SavedPayload", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let (code, output) = fixture.TryCompile(
                "import SavedPayload\nfunc Bad() { let wrapped = Make()\n" + statement + "\n}",
                "saved-payload-caller",
                executable: false,
                "/r:" + image
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("saved-storage"), output)
        }
    }

    @Theory
    @InlineData(false, "left == right")
    @InlineData(false, "left.Equals(right)")
    @InlineData(false, "left.GetHashCode()")
    @InlineData(true, "left == right")
    @InlineData(true, "left.Equals(right)")
    @InlineData(true, "left.GetHashCode()")
    func NativeBearingDataEqualityAndHashAreNotAdmitted(imported bool, expression string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package SavedEquality
public protocol P {}
public struct Counter {}
public data struct Box { public var Value P? }
public func Make() Box -> Box{Value: Counter{}}
`
        if !imported {
            let (code, output) = fixture.TryCompile(
                source + "\nfunc Bad() { let left = Make()\nlet right = Make()\nlet result = " + expression + "\n}",
                "saved-equality-local",
                executable: false
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("equality/hash"), output)
            return
        }
        let reference = Path.Combine(fixture.Directory, "SavedEquality.ref.dll")
        let implementation = fixture.Compile(source, "SavedEquality", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let (code, output) = fixture.TryCompile(
                "import SavedEquality\nfunc Bad() { let left = Make()\nlet right = Make()\nlet result = " +
                    expression +
                    "\n}",
                "saved-equality-caller",
                executable: false,
                "/r:" + image
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("equality/hash"), output)
        }
    }

    @Fact
    func UnrelatedSavedNativePayloadDoesNotBlockOrdinaryConcreteRecovery() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`import System
protocol P {}
struct Counter { var Number int32 }
class Holder { var Saved P
init(value P) { Saved = value } }
func MakeHolder() P -> Holder(Counter{})
let counter P = Counter{Number: 17}
if counter is Counter captured { Console.WriteLine(captured.Number) }
Console.WriteLine(MakeHolder() is Counter)
Console.WriteLine(MakeHolder() is object)
let absent P? = nil
Console.WriteLine(absent is object)
`, "saved-payload-compatible-recovery", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("17\nFalse\nTrue\nFalse\n", fixture.Run(dll))
    }

    @Theory
    @InlineData("class Derived : Foreign(Make()) {}")
    @InlineData("func Bad() { let value = Foreign(Make()) }")
    @InlineData("class Derived : Stored {}")
    @InlineData("func Bad() { let value = Stored() }")
    func ImportedNativeConstructorsRequireAnAdmittedBoundary(declaration string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ConstructorBoundary.ref.dll")
        let implementation = fixture.Compile(`package ConstructorBoundary
public protocol P {}
public struct Counter {}
public open class Foreign { public init(value P) {} }
public open class Stored { private var Saved P?
public init() {} }
public func Make() P -> Counter{}
`, "ConstructorBoundary", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let (code, output) = fixture.TryCompile(
                "import ConstructorBoundary\n" + declaration,
                "constructor-boundary-caller",
                executable: false,
                "/r:" + image
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("metadata-aware"), output)
        }
    }

    @Theory
    @InlineData("Item?", "nil", "value == nil")
    @InlineData("(Item, int32)", "(Item(), 17)", "value.Item2 == 17")
    @InlineData("[]Item", "[]Item{Item()}", "value.Length == 1")
    func StructuralSlotIdentitiesSurviveImplementationAndReferenceImports(
        type string,
        argument string,
        predicate string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "StructuralSlots.ref.dll")
        let implementation = fixture.Compile(`package StructuralSlots
public class Item {}
public protocol P { func Check(value ` + type + `) bool; }
public struct Worker : P {
public func Check(value ` + type + `) bool -> ` + predicate + `
}
public func Make() P -> Worker{}
`, "StructuralSlots", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let caller = fixture.Compile(
                "import System\nimport StructuralSlots\nConsole.WriteLine(Make().Check(" + argument + "))",
                "structural-slots-caller",
                executable: true,
                "/r:" + image
            )
            IlVerifier.Verify(caller, []string{implementation})
            Assert.Equal("True\n", fixture.Run(caller))
        }
    }

    @Theory
    @InlineData("holder.Value = value")
    @InlineData("let result = holder.Value")
    @InlineData("Foreign.Global = value")
    @InlineData("let result = Foreign.Global")
    @InlineData("holder[0] = value")
    @InlineData("let result = holder[0]")
    @InlineData("holder.Field = value")
    @InlineData("let result = holder.Field")
    @InlineData("Foreign.GlobalField = value")
    @InlineData("let result = Foreign.GlobalField")
    func ImportedUnmarkedNativeAccessorsRequireMetadataAwareBoundaries(statement string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "ForeignAccess.ref.dll")
        let implementation = fixture.CompileCSharpWithReference(`using System;
using System.Reflection;
using System.Runtime.CompilerServices;
[assembly: AssemblyMetadata("GSharp.NativeProtocolFeature", "6b105e95-6860-496a-9acb-d81bc250a275/1")]
[assembly: AssemblyMetadata("GSharp.NativeProtocols", """{"schema":"6b105e95-6860-496a-9acb-d81bc250a275/1","declarations":[{"type":"ForeignAccess.P","slots":[]}],"entries":[]}""")]
namespace ForeignAccess {
[Obsolete("GSharp.NativeProtocols.v1")]
public interface P {}
public sealed class Foreign {
public P? Value { get; set; }
public static P? Global { get; set; }
public P? this[int index] { get => null; set {} }
public P? Field;
public static P? GlobalField;
public CompilerFeatureRequiredAttribute MarkerType => null!;
}
}`, "ForeignAccess", reference)
        for image in[]string{implementation, reference} {
            PromoteFixtureProtocolMarker(image)
            let (code, output) = fixture.TryCompile(
                "import ForeignAccess\nfunc Bad(holder Foreign, value P) {\n" + statement + "\n}",
                "foreign-access-caller",
                executable: false,
                "/r:" + image
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("metadata-aware"), output)
        }
    }

    private func PromoteFixtureProtocolMarker(path string) {
        // C# reserves the real attribute; author that exact BCL reference in the
        // fixture metadata, leaving every foreign accessor deliberately unmarked.
        let bytes = File.ReadAllBytes(path)
        using let stream = MemoryStream(bytes)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        let feature = reader.TypeReferences.Single(
            (handle TypeReferenceHandle) ->
            reader.GetString(reader.GetTypeReference(handle).Name) == "CompilerFeatureRequiredAttribute"
        )
        let constructor = reader.MemberReferences.Single(
            (handle MemberReferenceHandle) -> {
                let member = reader.GetMemberReference(handle)
                return member.Parent.Kind == HandleKind.TypeReference && reader.GetString(
                    reader.GetTypeReference(cast[TypeReferenceHandle](member.Parent)).Name
                ) ==
                "ObsoleteAttribute" && reader.GetString(member.Name) == ".ctor"
            }
        )
        let rva = pe.PEHeaders.CorHeader!!.MetadataDirectory.RelativeVirtualAddress
        let section = pe
            .PEHeaders
            .SectionHeaders
            .Single(
            (item SectionHeader) -> rva >= item.VirtualAddress && rva < item.VirtualAddress + item.SizeOfRawData
        )
        let rowSize = reader.GetTableRowSize(TableIndex.MemberRef)
        Assert.Equal(6, rowSize)
        let offset = section.PointerToRawData + rva - section.VirtualAddress + reader.GetTableMetadataOffset(
            TableIndex.MemberRef
        ) +
            (MetadataTokens.GetRowNumber(constructor) - 1) * rowSize
        let parent = (MetadataTokens.GetRowNumber(feature) << 3) | 1
        bytes[offset] = uint8(parent & 255)
        bytes[offset + 1] = uint8(parent >> 8)
        File.WriteAllBytes(path, bytes)
    }

    @Fact
    func ExplicitExtensionOwnerSurvivesImplementationAndReferenceImports() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let refDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(refDirectory)
        let reference = Path.Combine(refDirectory, "OwnedWitness.dll")
        let implementation = fixture.Compile(`package OwnedWitness
public protocol P { func Read() int32; }
public struct Value { var Number int32 }
public shared class Witnesses {}
@ExtensionOwner(typeof(Witnesses))
public func (value Value) Read() int32 -> value.Number + 1
public func Make() P -> Value{Number: 40}
`, "OwnedWitness", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let caller = fixture.Compile(`import System
import OwnedWitness
Console.WriteLine(Make().Read())
`, "OwnedWitnessCaller" + (image == reference).ToString(), executable: true, "/r:" + image)
            IlVerifier.Verify(caller, []string{implementation})
            Assert.Equal("41\n", fixture.Run(caller))
        }
    }

    @Fact
    func StaticNativeStorageHasEquivalentSourceAndImportedEscapeRestrictions() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `package StaticStorage
public protocol P {}
public class Holder { shared { private var Saved P? } }
`
        let (localCode, localOutput) = fixture.TryCompile(
            source + "\nfunc Bad(value Holder) object -> value",
            "static-storage-local",
            executable: false
        )
        Assert.NotEqual(0, localCode)
        Assert.True(localOutput.Contains("GS0629") && localOutput.Contains("cannot escape"), localOutput)
        let reference = Path.Combine(fixture.Directory, "StaticStorage.ref.dll")
        let implementation = fixture.Compile(source, "StaticStorage", executable: false, "/refout:" + reference)
        for image in[]string{implementation, reference} {
            let (code, output) = fixture.TryCompile(
                "import StaticStorage\nfunc Bad(value Holder) object -> value",
                "static-storage-caller",
                executable: false,
                "/r:" + image
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("cannot escape"), output)
        }
    }

    @Fact
    func ImportedByRefExtensionWitnessCannotBecomeKnownMismatch() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = fixture.CompileCSharp(`namespace RefWitness {
public struct Counter { public int Step; }
public static class Extensions {
public static int Next(this ref Counter value) => ++value.Step;
}
}`, "RefWitness")
        let (code, output) = fixture.TryCompile(`import RefWitness
protocol NextValue { func Next() int32; }
let matched = Counter{} is NextValue
`, "RefWitnessConsumer", executable: true, "/r:" + source)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("unsupported witness"), output)
    }

    @Fact
    func ImportedOpenGenericReceiverWitnessCannotBecomeKnownMismatch() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = fixture.CompileCSharp(`namespace GenericWitness {
public struct Counter {}
public static class Extensions {
public static int Next<T>(this T value) => 1;
}
}`, "GenericWitness")
        let (code, output) = fixture.TryCompile(`import GenericWitness
protocol NextValue { func Next() int32; }
let matched = Counter{} is NextValue
`, "GenericWitnessConsumer", executable: true, "/r:" + source)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("unsupported witness"), output)
    }

    @Fact
    func OverloadApplicabilityUsesExactConformanceIncludingExtensions() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`import System
protocol Readable { func Read() int32; }
protocol Writable { func Write() int32; }
struct Reader : Readable { func Read() int32 -> 17 }
struct Extended {}
func (value Extended) Read() int32 -> 23
func Pick(value Readable) int32 -> value.Read()
func Pick(value Writable) int32 -> value.Write()
func Fallback(value Writable) int32 -> 99
func Fallback(value object) int32 -> 31
class Sink { var Result int32
init(value Readable) { Result = value.Read() }
init(value Writable) { Result = value.Write() } }
Console.WriteLine(Pick(Reader{}))
Console.WriteLine(Pick(Extended{}))
Console.WriteLine(Fallback(Reader{}))
Console.WriteLine(Sink(Extended{}).Result)
`, "protocol-overloads", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("17\n23\n31\n23\n", fixture.Run(dll))
    }

    @Fact
    func TotalVarCaptureRetainsValidatedMutableEntry() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`import System
protocol P { func Next() int32; }
struct Counter { var Step int32
func Next() int32 {
Step += 1
return Step
} }
let p P = Counter{Step: 10}
if p is var q { Console.WriteLine(q.Next()) }
Console.WriteLine(p.Next())
`, "protocol-var-capture", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("11\n12\n", fixture.Run(dll))
    }

    @Fact
    func MixedTotalCaptureAndConcreteRecoveryRequireAnIntermediateView() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`protocol P {}
struct Counter {}
func Bad(value P) bool -> value is var captured and Counter concrete
`, "protocol-mixed-capture", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("capture"), output)
    }

    @Theory
    @InlineData("switch p { case Counter c { } default { } }")
    @InlineData("let result = switch p { case Counter c: 1\n default: 0 }")
    @InlineData("switch p { case Future f { } default { } }")
    @InlineData("let result = switch p { case Future f: 1\n default: 0 }")
    func NativeSwitchPatternsRequireAnExplicitView(statement string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let producer = fixture.Compile(`package OldProducer
public protocol P {}
public struct Counter {}
public func Make() P -> Counter{}
`, "OldProducer", executable: false)
        let (code, output) = fixture.TryCompile(
            "import OldProducer\nprotocol Future {}\nlet p = Make()\n" + statement,
            "protocol-switch-boundary",
            executable: true,
            "/r:" + producer
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("switch"), output)
    }

    @Theory
    @InlineData("func Bad(value Derived) object -> value")
    @InlineData(`func Bad(value Derived) string -> "${value}"`)
    @InlineData("func Identity[T](value T) T -> value\nfunc Bad(value Derived) Derived -> Identity(value)")
    @InlineData("interface I {}\nfunc Bad(value Derived) I -> adapt[I](value)")
    func InheritedSavedStorageCannotEscape(statement string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`protocol P {}
open class Base { private var Saved P?
init() {} }
class Derived : Base {}
` + statement, "protocol-inherited-storage", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629"), output)
    }

    @Fact
    func ImportedInheritedStorageCannotLoseItsBoundaryMarker() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let refDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(refDirectory)
        let reference = Path.Combine(refDirectory, "InheritedStorage.dll")
        let implementation = fixture.Compile(`package InheritedStorage
public protocol P { func Next() int32; }
public struct Counter { var Step int32
func Next() int32 {
Step += 1
return Step
} }
public open class Base { private var Saved P
init(value P) { Saved = value }
public func Read() int32 -> Saved.Next() }
public class Derived : Base { init(value P) : base(value) {} }
public func Make() Derived -> Derived(Counter{Step: 10})
`, "InheritedStorage", executable: false, "/refout:" + reference)
        for imported in[]string{implementation, reference} {
            let (code, output) = fixture.TryCompile(
                "import InheritedStorage\nfunc Bad(value Derived) object -> value",
                "InheritedEscape",
                executable: false,
                "/r:" + imported
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("cannot escape"), output)
        }
    }

    @Fact
    func ImportedSavedStorageInstanceContractsAgreeAcrossReferenceImages() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let refDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(refDirectory)
        let reference = Path.Combine(refDirectory, "SavedMethods.dll")
        let implementation = fixture.Compile(`package SavedMethods
public protocol P { func Next() int32; }
public struct Counter { var Step int32
func Next() int32 {
Step += 1
return Step
} }
public class Holder { private var Saved P
init(value P) { Saved = value }
public func Read() int32 -> Saved.Next() }
public func Make() Holder -> Holder(Counter{Step: 10})
`, "SavedMethods", executable: false, "/refout:" + reference)
        for imported in[]string{implementation, reference} {
            let caller = fixture.Compile(`import System
import SavedMethods
let value = Make()
Console.WriteLine(value.Read())
Console.WriteLine(value.Read())
`, "SavedCaller" + (imported == reference).ToString(), executable: true, "/r:" + imported)
            IlVerifier.Verify(caller, []string{implementation})
            Assert.Equal("11\n12\n", fixture.Run(caller))
        }
    }

    @Fact
    func SourceGenericNativeContainerCannotBoxItsHiddenPayload() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`protocol P {}
struct Value {}
class Box[T] { var Value T
func Leak() object -> Value }
let p P = Value{}
let box = Box[P]{Value: p}
let escaped = box.Leak()
`, "protocol-source-generic", executable: true)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("container"), output)
    }

    @Fact
    func OrdinaryBclPayloadsAndExactWitnessesKeepSymbolicIdentityThroughReferenceImports() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let referenceDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(referenceDirectory)
        let contractRef = Path.Combine(referenceDirectory, "BclContract.dll")
        let producerRef = Path.Combine(referenceDirectory, "BclProducer.dll")
        let contract = fixture.Compile(`package BclContract
public protocol Value {}
public protocol Printable { func ToUpperInvariant() string; }
`, "BclContract", executable: false, "/refout:" + contractRef)
        let producer = fixture.Compile(`package BclProducer
import BclContract
public func Number() Value -> 17
public func Text() Printable -> "abc"
`, "BclProducer", executable: false, "/r:" + contract, "/refout:" + producerRef)
        let callerSource = `import System
import BclContract
import BclProducer
func Main() {
    let number = Number()
    if number is int32 original { Console.WriteLine(original) }
    Console.WriteLine(number is Printable)
    let printable = Text()
    Console.WriteLine(printable.ToUpperInvariant())
    let retained Value = printable
    Console.WriteLine((retained as string)!!)
}`
        for reference in[]bool{false, true} {
            let caller = fixture.Compile(
                callerSource,
                "BclCaller" + reference.ToString(),
                executable: true,
                "/r:" +
                    (
                    if reference {
                        contractRef
                    } else {
                        contract
                    }
                ),
                "/r:" +
                    (
                    if reference {
                        producerRef
                    } else {
                        producer
                    }
                )
            )
            IlVerifier.Verify(caller, []string{contract, producer})
            Assert.Equal("17\nFalse\nABC\nabc\n", fixture.Run(caller))
        }
        Assert.Equal(ReadNativeManifest(producer), ReadNativeManifest(producerRef))
    }

    @Fact
    func GlobalMemberStorageAndSuspendingArgumentsKeepValidatedEntries() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ProtocolStorage
import System
import System.Threading.Tasks
protocol Advance { func Next(amount int32) int32; }
struct Counter {
    var Step int32
    func Next(amount int32) int32 {
        Step += amount
        return Step
    }
}
class Holder {
    var Saved Advance
    init(value Advance) { Saved = value }
    func Next() int32 -> Saved.Next(1)
}
var global Advance = Counter{Step: 10}
async func Amount() int32 {
    await Task.Delay(1)
    return 1
}
async func Suspended() int32 {
    let p Advance = Counter{Step: 20}
    let first = p.Next(await Amount())
    return first + p.Next(1)
}
let holder = Holder(global)
Console.WriteLine(holder.Next())
Console.WriteLine(global.Next(1))
Console.WriteLine(Suspended().GetAwaiter().GetResult())
`, "protocol-storage", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("11\n12\n43\n", fixture.Run(dll))
    }

    @Fact
    func ContextualNamesNominalInheritanceAndOptionalOnlyAbsenceRemainOrdinary() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ProtocolCompatibility
import System
protocol Capability { func Read() int32; }
protocol Empty {}
interface Nominal { func Read() int32; }
open class Base { var Value int32 }
class Derived : Base, Nominal, Capability { func Read() int32 -> Value }
class protocol { var Value int32 }
func Named() protocol -> protocol{Value: 7}
func Main() {
    let protocol = 17
    Console.WriteLine(protocol)
    Console.WriteLine(Named().Value)
    let original = Derived{Value: 30}
    let nominal Nominal = original
    Console.WriteLine(nominal.Read())
    let capability Capability = original
    Console.WriteLine(capability.Read())
    Console.WriteLine(original is Base)
    let none Empty? = nil
    Console.WriteLine(none is Empty)
    Console.WriteLine((none as Empty) == nil)
}`, "protocol-compatibility", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("17\n7\n30\n30\nTrue\nFalse\nTrue\n", fixture.Run(dll))
    }

    @Fact
    func ConcreteProbesUseCanonicalConformanceAndEvaluateOnce() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ConcreteProbes
import System
protocol Advance { func Next() int32; }
protocol Missing { func Missing() int32; }
struct Counter {
    var Value int32
    func Next() int32 {
        Value += 1
        return Value
    }
}
func Make() Counter {
    Console.WriteLine("make")
    return Counter{Value: 10}
}
func Main() {
    if Make() is Advance value {
        Console.WriteLine(value.Next())
        Console.WriteLine(value.Next())
    }
    Console.WriteLine(Make() is Missing)
    Console.WriteLine((Make() as Missing) == nil)
    let view = (Make() as Advance)!!
    Console.WriteLine(view.Next())
}`, "concrete-probes", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("make\n11\n12\nmake\nFalse\nmake\nTrue\nmake\n11\n", fixture.Run(dll))
    }

    @Fact
    func OldProducerCannotAnswerUnknownFutureCapabilitiesAsNegativeEvidence() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contract = fixture.Compile(
            "package CoverageContract\npublic protocol Message {}",
            "CoverageContract",
            executable: false
        )
        let producer = fixture.Compile(`package CoverageProducer
import CoverageContract
public class Counter { func Next() int32 -> 1 }
public func Make() Message {
    let message Message = Counter()
    return message
}`, "CoverageProducer", executable: false, "/r:" + contract)
        let (code, output) = fixture.TryCompile(`package CoverageCaller
import CoverageContract
import CoverageProducer
protocol Future { func Next() int32; }
func Test() bool {
    let message = Make()
    return message is Future
}`, "CoverageCaller", executable: false, "/r:" + contract, "/r:" + producer)
        Assert.NotEqual(0, code)
        Assert.True(
            output.Contains("GS0629") && output.Contains("unknown or incompatible imported native protocol coverage"),
            output
        )
    }

    @Theory
    @InlineData("{", "malformed native protocol JSON")
    @InlineData("{\"schema\":\"future\",\"declarations\":[],\"entries\":[]}", "unsupported native protocol schema")
    @InlineData(
        "{\"schema\":\"6b105e95-6860-496a-9acb-d81bc250a275/1\",\"declarations\":[{\"type\":\"Missing\",\"slots\":[]}],\"entries\":[]}",
        "stale or unsupported protocol identity"
    )
    @InlineData(
        "{\"schema\":\"6b105e95-6860-496a-9acb-d81bc250a275/1\",\"declarations\":[{\"type\":\"InvalidContract.P\",\"slots\":[\"stale\"]}],\"entries\":[]}",
        "stale or incomplete native protocol contract revision"
    )
    @InlineData(
        "{\"schema\":\"6b105e95-6860-496a-9acb-d81bc250a275/1\",\"declarations\":[],\"entries\":[]}",
        "missing or invalid imported native protocol declaration evidence"
    )
    func MalformedUnsupportedStaleOrMissingDeclarationEvidenceDiagnoses(payload string, reason string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let invalid = fixture.Compile(`package InvalidContract
import System.Reflection
import System.Runtime.CompilerServices
@assembly: AssemblyMetadata("GSharp.NativeProtocolFeature", "6b105e95-6860-496a-9acb-d81bc250a275/1")
@assembly: AssemblyMetadata("GSharp.NativeProtocols", ` + JsonSerializer.Serialize(payload) + `)
@CompilerFeatureRequired("GSharp.NativeProtocols.v1")
public interface P {}
`, "InvalidContract", executable: false)
        let (code, output) = fixture.TryCompile(
            "import InvalidContract\nfunc Take(value P) {}",
            "InvalidConsumer",
            executable: false,
            "/r:" + invalid
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains(reason), output)
    }

    @Fact
    func FeatureMarkerWithoutRequiredManifestIsNotAnOrdinaryNominalInterface() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let invalid = fixture.Compile(`package MissingManifest
import System.Reflection
import System.Runtime.CompilerServices
@assembly: AssemblyMetadata("GSharp.NativeProtocolFeature", "6b105e95-6860-496a-9acb-d81bc250a275/1")
@CompilerFeatureRequired("GSharp.NativeProtocols.v1")
public interface P {}
`, "MissingManifest", executable: false)
        let (code, output) = fixture.TryCompile(
            "import MissingManifest\nfunc Take(value P) {}",
            "MissingManifestConsumer",
            executable: false,
            "/r:" + invalid
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("missing native protocol manifest"), output)
    }

    @Fact
    func SavedStructAndExtractionShareReferenceFieldsButNotFieldReplacementOrValueState() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ProtocolSharing
import System
protocol Update {
    func Touch() int32;
    func Current() int32;
}
class Box { var Value int32 }
struct Holder : Update {
    var Count int32
    var Shared Box
    var Values []int32
    var Segment slice[int32]
    var Location managed[int32]
    func Touch() int32 {
        Count += 1
        Shared.Value += 1
        Values[0] += 1
        Segment[0] += 1
        *Location += 1
        Shared = Box{Value: 100}
        Values = []int32{200}
        Segment = slice[int32]{300}
        let replacement = Box{Value: 400}
        Location = managed(replacement.Value)
        return Count
    }
    func Current() int32 -> Count
}
func Main() {
    let owner = Box{Value: 50}
    let segment = slice[int32]{40}
    let location = managed(owner.Value)
    let original = Holder{
        Count: 10, Shared: Box{Value: 7}, Values: []int32{30},
        Segment: segment, Location: location
    }
    let p Update = original
    let q = p
    Console.WriteLine(p.Touch())
    Console.WriteLine(q.Touch())
    Console.WriteLine(original.Count)
    Console.WriteLine(original.Shared.Value)
    Console.WriteLine(original.Values[0])
    Console.WriteLine(original.Segment[0])
    Console.WriteLine(*original.Location)
    if p is Holder saved {
        var copy = saved
        Console.WriteLine(copy.Touch())
    }
    Console.WriteLine(p.Current())
    if p is Holder current {
        Console.WriteLine(current.Shared.Value)
        Console.WriteLine(current.Values[0])
        Console.WriteLine(current.Segment[0])
        Console.WriteLine(*current.Location)
    }
    let independent Update = original
    Console.WriteLine(independent.Touch())
    Console.WriteLine(p.Current())
    Console.WriteLine(original.Shared.Value)
    Console.WriteLine(original.Values[0])
    Console.WriteLine(original.Segment[0])
    Console.WriteLine(*original.Location)
}`, "protocol-sharing", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(`11
12
10
8
31
41
51
13
12
101
201
301
401
11
12
9
32
42
52
`, fixture.Run(dll))
    }

    @Fact
    func PublicBoundaryRejectsForeignAbsenceAndUnknownEntriesEvenForUnusedParameters() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ProtocolBoundary
import System
import System.Reflection
import System.Reflection.Emit
protocol Message {}
class Known {}
class Sink {
    shared { func Ignore(value Message) int32 -> 7 }
}
func Probe(method MethodInfo, value object?) {
    try {
        Console.WriteLine(method.Invoke(nil, []object?{value}))
    } catch (error TargetInvocationException) {
        Console.WriteLine(error.InnerException!!.Message)
    }
}
func Main() {
    let known Message = Known()
    Console.WriteLine(Sink.Ignore(known))
    let method = typeof(Sink).GetMethod("Ignore")!!
    Probe(method, nil)
    let assembly = AssemblyBuilder.DefineDynamicAssembly(AssemblyName("ForeignProtocol"), AssemblyBuilderAccess.Run)
    let module = assembly.DefineDynamicModule("ForeignModule")
    let builder = module.DefineType("ForeignEntry", TypeAttributes.Public | TypeAttributes.Sealed)
    builder.AddInterfaceImplementation(typeof(Message))
    builder.DefineDefaultConstructor(MethodAttributes.Public)
    let foreign = Activator.CreateInstance(builder.CreateType())
    Probe(method, foreign)
}`, "protocol-public-boundary", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(`7
A required native protocol value is absent
Invalid or unknown native protocol evidence
`, fixture.Run(dll))
    }

    @Fact
    func OptionalAbsenceAndCompatibleOriginalClassRecoveryPreserveOrdinaryPatternFlow() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ProtocolPatternFlow
import System
protocol NextValue { func Next() int32; }
protocol Missing { func Missing() int32; }
open class Base { var Value int32 }
class Derived : Base {
    func Next() int32 {
        Value += 1
        return Value
    }
}
func Main() {
    let original = Derived{Value: 40}
    let p NextValue = original
    let absent NextValue? = nil
    Console.WriteLine(absent == nil)
    Console.WriteLine(absent is NextValue)
    Console.WriteLine((absent as NextValue) == nil)
    Console.WriteLine(p is not NextValue)
    Console.WriteLine(p is not Missing)
    if p is NextValue view && view.Next() == 41 {
        Console.WriteLine(original.Value)
    }
    if p is Base recovered {
        Console.WriteLine(Object.ReferenceEquals(original, recovered))
    }
    Console.WriteLine(Object.ReferenceEquals(original, p as Base))
    Console.WriteLine(p is string)
}`, "protocol-pattern-flow", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(`True
False
True
False
True
41
True
True
False
`, fixture.Run(dll))
    }

    @Theory
    @InlineData("protocol P[T] {}", "only nongeneric protocols")
    @InlineData("partial protocol P {}", "declaration modifiers")
    @InlineData("sealed protocol P {}", "declaration modifiers")
    @InlineData("internal protocol Hidden {}\npublic func Bad(value Hidden) {}", "accessible contract types")
    @InlineData("internal protocol Hidden {}\npublic class Holder { var Value Hidden }", "accessible contract types")
    @InlineData("protocol P { prop Value int32 { get; } }", "only nongeneric protocols")
    @InlineData("protocol P { func Next() ref int32; }", "by-value signatures")
    @InlineData("protocol P { func Next() int32; }\nstruct Bad : P {}", "explicit conformance")
    @InlineData(
        "protocol P { func Next() int32; }\nstruct Bad : P { private func Next() int32 -> 1 }",
        "explicit conformance"
    )
    @InlineData("protocol P {}\nfunc Bad() P -> nil", "non-null exact payload")
    @InlineData("protocol P {}\nfunc Bad() P -> default(P)", "default would synthesize")
    @InlineData("protocol P {}\nvar value P", "protocol global must be initialized")
    @InlineData("protocol P {}\nfunc Bad() { var value P\nlet copy = value }", "present protocol value")
    @InlineData(
        "protocol P {}\nstruct Envelope { var Value P }\nfunc Bad(value Envelope) object -> value",
        "cannot escape"
    )
    @InlineData(
        "protocol P {}\nstruct Envelope { var Value P }\nfunc Bad(value []Envelope) object -> value",
        "cannot escape"
    )
    @InlineData(
        "protocol P {}\nstruct Envelope { var Value P }\nfunc Bad(value slice[Envelope]) object -> value",
        "cannot escape"
    )
    @InlineData(`protocol P {}
class Envelope { var Next Envelope?
var Value P
init(value P) { Value = value } }
func Bad(value Envelope) string -> "${value}"`, "formatting requires")
    @InlineData("protocol P {}\nclass Holder { var Value P }\nfunc Bad() { let value = Holder() }", "initialized")
    @InlineData(
        "protocol P {}\nstruct Holder { var Value P }\nfunc Bad() { let value = default(Holder) }",
        "default would synthesize"
    )
    @InlineData(
        "protocol P {}\nclass C {}\nfunc Bad() {\nlet p P = C()\nlet q = p\nlet same = p == q\n}",
        "equality/hash"
    )
    @InlineData("protocol P {}\nfunc Bad(value P) object -> value", "cannot escape")
    @InlineData(
        "import System.Collections.Generic\nprotocol P {}\nfunc Bad() { let items = List[P]() }",
        "generic container"
    )
    @InlineData("protocol P {}\nfunc Use[T](value T) {}\nfunc Bad(value P) { Use(value) }", "generic invocation")
    @InlineData("protocol P {}\nasync func Bad(value P) {}", "suspending native protocol signatures")
    @InlineData(
        "public protocol P {}\ninternal class Hidden {}\npublic func Bad() P -> Hidden()",
        "accessible exact payload"
    )
    @InlineData("protocol P {}\nenum Signal conforms P { Ready, Done }", "enum protocol conformance")
    @InlineData("protocol P {}\ninterface Nominal : P {}", "nominal interface inheritance")
    @InlineData("protocol P {}\nfunc Bad(value managed[P]) {}", "generic container")
    @InlineData("protocol P {}\nfunc Bad(value object) bool -> value is P", "exact nongeneric")
    @InlineData("protocol P {}\nfunc Bad(value object) P? -> value as P", "exact nongeneric")
    @InlineData("protocol P {}\nclass C {}\nfunc Bad() { let p = adapt[P](C()) }", "nominal CLR bridge")
    @InlineData("interface I {}\nprotocol P {}\nfunc Bad(value P) { let bridge = adapt[I](value) }", "nominal adapt")
    @InlineData(
        "interface I {}\nprotocol P {}\nstruct Holder { var Value P }\nfunc Bad(value Holder) { let bridge = adapt[I](value) }",
        "nominal adapt"
    )
    @InlineData(
        "protocol P { func Next() int32; }\nfunc Bad(value P) { let callback () -> int32 = value.Next }",
        "method-group export"
    )
    @InlineData(`protocol P {}
func Bad(value P) string -> "${value}"`, "formatting")
    func UnsupportedShapesAndUninitializedRequiredValuesDiagnoseRatherThanGuess(source string, reason string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(source, "protocol-negative", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629"), output)
        Assert.True(output.Contains(reason), output)
    }

    @Fact
    func ImportedNestedNativeStorageCannotLoseItsBoundaryMarker() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let refDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(refDirectory)
        let reference = Path.Combine(refDirectory, "NestedStorage.dll")
        let implementation = fixture.Compile(`package NestedStorage
public protocol P {}
public class Inner { private var Value P
init(value P) { Value = value } }
public class Outer { private var Values []Inner
init(values []Inner) { Values = values } }
`, "NestedStorage", executable: false, "/refout:" + reference)
        for imported in[]string{implementation, reference} {
            let (code, output) = fixture.TryCompile(
                "import NestedStorage\nfunc Bad(value Outer) object -> value",
                "NestedStorageConsumer",
                executable: false,
                "/r:" + imported
            )
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("GS0629") && output.Contains("cannot escape"), output)
        }
    }

    @Theory
    @InlineData("\"name\":\"Next\"", "\"name\":\"Gone\"", "exact native protocol witness target")
    @InlineData("\"authority\":\"public\"", "\"authority\":\"prvate\"", "witness authority")
    @InlineData("retaining-entry/shallow-copy/1", "retaining-entry/shallow-copy/2", "storage/transport")
    @InlineData("\"positive\":true", "\"positive\":null", "malformed native protocol decision")
    func CorruptReferenceEvidenceCannotBecomeAbsenceOrReselectTargets(oldText string, newText string, reason string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let refDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(refDirectory)
        let reference = Path.Combine(refDirectory, "CorruptEvidence.dll")
        fixture.Compile(`package CorruptEvidence
public protocol NextValue { func Next() int32; }
public struct Counter : NextValue { func Next() int32 -> 41 }
public func Make() NextValue -> Counter{}
`, "CorruptEvidence", executable: false, "/refout:" + reference)
        let manifest = ReadNativeManifest(reference)
        Assert.Contains(oldText, manifest)
        ReplaceBinaryText(reference, manifest, manifest.Replace(oldText, newText, StringComparison.Ordinal))
        let (code, output) = fixture.TryCompile(
            "import CorruptEvidence\nfunc Take(value NextValue) int32 -> value.Next()",
            "CorruptEvidenceConsumer",
            executable: false,
            "/r:" + reference
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains(reason), output)
    }

    @Fact
    func ReferenceManifestLossCannotSilentlyBecomeNominalImport() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let refDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(refDirectory)
        let reference = Path.Combine(refDirectory, "LostEvidence.dll")
        fixture.Compile(
            "package LostEvidence\npublic protocol P {}",
            "LostEvidence",
            executable: false,
            "/refout:" + reference
        )
        ReplaceBinaryText(reference, "\u0016GSharp.NativeProtocols", "\u0016GSharp.NativeProtocolz")
        let (code, output) = fixture.TryCompile(
            "import LostEvidence\nfunc Take(value P) {}",
            "LostEvidenceConsumer",
            executable: false,
            "/r:" + reference
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("missing native protocol manifest"), output)
    }

    private func ReplaceBinaryText(path string, oldText string, newText string) {
        let before = System.Text.Encoding.UTF8.GetBytes(oldText)
        let after = System.Text.Encoding.UTF8.GetBytes(newText)
        Assert.Equal(before.Length, after.Length)
        let bytes = File.ReadAllBytes(path)
        let hex = Convert.ToHexString(bytes)
        let needle = Convert.ToHexString(before)
        let offset = hex.IndexOf(needle, StringComparison.Ordinal)
        Assert.True(offset >= 0 && offset % 2 == 0, "Required metadata payload absent")
        Assert.Equal(-1, hex.IndexOf(needle, offset + needle.Length, StringComparison.Ordinal))
        after.CopyTo(bytes, offset / 2)
        File.WriteAllBytes(path, bytes)
    }

    @Fact
    func DuplicateCanonicalSourceRecordsAreNotSilentlyMergedInsideOneManifest() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let producer = fixture.Compile(`package DuplicateSourceOrigin
public protocol P {}
public class Payload {}
public func Make() P -> Payload()
`, "DuplicateSourceOrigin", executable: false)
        using let document = JsonDocument.Parse(ReadNativeManifest(producer))
        let record = document.RootElement.GetProperty("entries")[0].GetRawText()
        let payload = "{\"schema\":\"6b105e95-6860-496a-9acb-d81bc250a275/1\",\"declarations\":[],\"entries\":[" +
            record +
            "," +
            record +
            "]}"
        let duplicate = fixture.CompileCSharp(`using System.Reflection;
[assembly: AssemblyMetadata("GSharp.NativeProtocolFeature", "6b105e95-6860-496a-9acb-d81bc250a275/1")]
[assembly: AssemblyMetadata("GSharp.NativeProtocols", ` + JsonSerializer.Serialize(payload) + `)]
public class Unrelated {}
`, "DuplicateSourceRecords")
        let (code, output) = fixture.TryCompile(
            "import DuplicateSourceOrigin\nfunc Take(value P) {}",
            "DuplicateSourceConsumer",
            executable: false,
            "/r:" + producer,
            "/r:" + duplicate
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("duplicate native protocol source record"), output)
    }

    @Fact
    func AssemblyEvidenceDoesNotReplaceRequiredNativeMethodContractMarkers() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let producer = fixture.Compile(`package BoundaryOrigin
public protocol P {}
public class Payload {}
public func Make() P -> Payload()
`, "BoundaryOrigin", executable: false)
        let refDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(refDirectory)
        let facadeRef = Path.Combine(refDirectory, "BoundaryFacade.dll")
        fixture.Compile(`package BoundaryFacade
import BoundaryOrigin
public func Echo(value P) P -> value
`, "BoundaryFacade", executable: false, "/r:" + producer, "/refout:" + facadeRef)
        ReplaceBinaryText(facadeRef, "GSharp.NativeProtocols.v1", "XSharp.NativeProtocols.v1")
        let (code, output) = fixture.TryCompile(`import BoundaryOrigin
import BoundaryFacade
func Use() P -> Echo(Make())
`, "BoundaryMarkerConsumer", executable: false, "/r:" + producer, "/r:" + facadeRef)
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("metadata-aware G# contract"), output)
    }

    @Fact
    func ReferencedClrTargetsAndOrdinaryImportedExtensionsHaveStableTypedReferenceContracts() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = fixture.CompileCSharp(`namespace ForeignSource {
    public struct Counter {
        public int Step;
        public int Next() => ++Step;
    }
    public struct CopyCounter { public int Step; }
}`, "ForeignSource")
        let referenceDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(referenceDirectory)
        let producerRef = Path.Combine(referenceDirectory, "NativeWitnesses.dll")
        let producer = fixture.Compile(`package NativeWitnesses
import ForeignSource
public protocol NextValue { func Next() int32; }
public func (value CopyCounter) Next() int32 {
    var copy = value
    copy.Step += 1
    return copy.Step
}
public func Save(value Counter) NextValue -> value
`, "NativeWitnesses", executable: false, "/r:" + source, "/refout:" + producerRef)
        let caller = `package ImportedWitnessCaller
import ForeignSource
import NativeWitnesses
import System
func Main() {
    let p = Save(Counter{Step: 10})
    let q = p
    Console.WriteLine(p.Next())
    Console.WriteLine(q.Next())
    if p is Counter saved {
        var copy = saved
        Console.WriteLine(copy.Next())
    }
    Console.WriteLine(p.Next())
    let extension NextValue = CopyCounter{Step: 10}
    Console.WriteLine(extension.Next())
    Console.WriteLine(extension.Next())
}`
        let implementationCaller = fixture.Compile(
            caller,
            "ImportedWitnessImplementation",
            executable: true,
            "/r:" + source,
            "/r:" + producer
        )
        let referenceCaller = fixture.Compile(
            caller,
            "ImportedWitnessReference",
            executable: true,
            "/r:" + source,
            "/r:" + producerRef
        )
        Assert.Equal(ReadNativeManifest(producer), ReadNativeManifest(producerRef))
        IlVerifier.Verify(producer, []string{source})
        IlVerifier.Verify(implementationCaller, []string{source, producer})
        IlVerifier.Verify(referenceCaller, []string{source, producer})
        Assert.Equal("11\n12\n13\n13\n11\n11\n", fixture.Run(implementationCaller))
        Assert.Equal("11\n12\n13\n13\n11\n11\n", fixture.Run(referenceCaller))
    }

    @Fact
    func CanonicalReexportsRetainOldExtensionsAndConflictingOriginsDiagnose() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = fixture.CompileCSharp(
            "namespace ConformanceSource { public struct Counter { public int Step; } }",
            "ConformanceSource"
        )
        let contract = fixture.Compile(
            "package ConformanceContract\npublic protocol NextValue { func Next() int32; }",
            "ConformanceContract",
            executable: false
        )
        let referenceDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(referenceDirectory)
        let firstRef = Path.Combine(referenceDirectory, "FirstOrigin.dll")
        let facadeRef = Path.Combine(referenceDirectory, "ProtocolFacade.dll")
        let first = fixture.Compile(`package FirstOrigin
import ConformanceSource
import ConformanceContract
public func (value Counter) Next() int32 -> value.Step + 1
public func Save(value Counter) NextValue -> value
`, "FirstOrigin", executable: false, "/r:" + source, "/r:" + contract, "/refout:" + firstRef)
        let facade = fixture.Compile(`package ProtocolFacade
import ConformanceContract
public func Echo(value NextValue) NextValue -> value
`, "ProtocolFacade", executable: false, "/r:" + source, "/r:" + contract, "/r:" + firstRef, "/refout:" + facadeRef)
        let caller = fixture.Compile(`package CoherentCaller
import System
import ConformanceSource
import ConformanceContract
import FirstOrigin
import ProtocolFacade
func (value Counter) Next() int32 -> value.Step + 9000
func Main() {
    let p = Echo(Save(Counter{Step: 10}))
    Console.WriteLine(p.Next())
    Console.WriteLine(p.Next())
    let independent NextValue = Counter{Step: 20}
    Console.WriteLine(independent.Next())
}`, "CoherentCaller", executable: true, "/r:" + source, "/r:" + contract, "/r:" + firstRef, "/r:" + facadeRef)
        IlVerifier.Verify(first, []string{source, contract})
        IlVerifier.Verify(facade, []string{source, contract, first})
        IlVerifier.Verify(caller, []string{source, contract, first, facade})
        Assert.Equal("11\n11\n21\n", fixture.Run(caller))
        let second = fixture.Compile(`package SecondOrigin
import ConformanceSource
import ConformanceContract
public func (value Counter) Next() int32 -> value.Step + 1000
public func SaveOther(value Counter) NextValue -> value
`, "SecondOrigin", executable: false, "/r:" + source, "/r:" + contract)
        let (code, output) = fixture.TryCompile(
            "import ConformanceContract\nfunc Take(value NextValue) {}",
            "ConflictingConsumer",
            executable: false,
            "/r:" + source,
            "/r:" + contract,
            "/r:" + firstRef,
            "/r:" + second
        )
        Assert.NotEqual(0, code)
        Assert.True(output.Contains("GS0629") && output.Contains("multiple native entry origins"), output)
    }

    @Fact
    func SeparateContractProducerAndCallerPreserveDispatchStateAndRecoveryThroughReferenceAssemblies() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let referenceDirectory = Path.Combine(fixture.Directory, "ref")
        Directory.CreateDirectory(referenceDirectory)
        let contractRef = Path.Combine(referenceDirectory, "ProtocolContract.dll")
        let producerRef = Path.Combine(referenceDirectory, "ProtocolProducer.dll")
        let contractSource = `package ProtocolContract
public protocol Message {}
public protocol NextValue { func Next() int32; }
public protocol Missing { func Missing() int32; }
`
        let contract = fixture.Compile(
            contractSource,
            "ProtocolContract",
            executable: false,
            "/refout:" + contractRef,
            "/deterministic+"
        )
        let producerSource = `package ProtocolProducer
import ProtocolContract
internal protocol HiddenCore {}
internal struct HiddenPayload : HiddenCore {}
public struct Counter : Message, NextValue, HiddenCore {
    var Step int32
    func Next() int32 {
        Step += 1
        return Step
    }
}
public func Make() Message {
    let saved Message = Counter{Step: 10}
    return saved
}
`
        let producer = fixture.Compile(
            producerSource,
            "ProtocolProducer",
            executable: false,
            "/r:" + contractRef,
            "/refout:" + producerRef,
            "/deterministic+"
        )
        let caller = `package ProtocolCaller
import ProtocolContract
import ProtocolProducer
import System
func Main() {
    let message = Make()
    if message is NextValue value {
        Console.WriteLine(value.Next())
        let q = value
        Console.WriteLine(q.Next())
    }
    if message is Counter recovered {
        var copy = recovered
        Console.WriteLine(copy.Next())
    }
    Console.WriteLine((message as NextValue)!!.Next())
    Console.WriteLine(message is Missing)
    Console.WriteLine((message as Missing) == nil)
}
`
        let implementationCaller = fixture.Compile(
            caller,
            "ProtocolCallerImplementation",
            executable: true,
            "/r:" + contract,
            "/r:" + producer
        )
        let referenceCaller = fixture.Compile(
            caller,
            "ProtocolCallerReference",
            executable: true,
            "/r:" + contractRef,
            "/r:" + producerRef
        )
        IlVerifier.Verify(contract)
        IlVerifier.Verify(producer, []string{contract})
        IlVerifier.Verify(implementationCaller, []string{contract, producer})
        IlVerifier.Verify(referenceCaller, []string{contract, producer})
        Assert.Equal(ReadNativeManifest(contract), ReadNativeManifest(contractRef))
        Assert.Equal(ReadNativeManifest(producer), ReadNativeManifest(producerRef))
        Assert.DoesNotContain("HiddenCore", ReadNativeManifest(producer))
        Assert.DoesNotContain("HiddenPayload", ReadNativeManifest(producer))
        let expected = `11
12
13
13
False
True
`
        Assert.Equal(expected, fixture.Run(implementationCaller))
        Assert.Equal(expected, fixture.Run(referenceCaller))
        let originalImplementation = File.ReadAllBytes(producer)
        let originalReference = File.ReadAllBytes(producerRef)
        fixture.Compile(
            producerSource,
            "ProtocolProducer",
            executable: false,
            "/r:" + contractRef,
            "/refout:" + producerRef,
            "/deterministic+"
        )
        Assert.Equal(originalImplementation, File.ReadAllBytes(producer))
        Assert.Equal(originalReference, File.ReadAllBytes(producerRef))
    }

    private func ReadNativeManifest(path string) string {
        using let stream = File.OpenRead(path)
        using let pe = PEReader(stream)
        let reader = pe.GetMetadataReader()
        for handle in reader.GetAssemblyDefinition().GetCustomAttributes() {
            let attribute = reader.GetCustomAttribute(handle)
            if attribute.Constructor.Kind != HandleKind.MemberReference {
                continue
            }
            let constructor = reader.GetMemberReference(cast[MemberReferenceHandle](attribute.Constructor))
            if constructor.Parent.Kind != HandleKind.TypeReference {
                continue
            }
            let type = reader.GetTypeReference(cast[TypeReferenceHandle](constructor.Parent))
            if reader.GetString(type.Namespace) != "System.Reflection" || reader.GetString(
                type.Name
            ) != "AssemblyMetadataAttribute" {
                continue
            }
            var blob = reader.GetBlobReader(attribute.Value)
            Assert.Equal(uint16(1), blob.ReadUInt16())
            if blob.ReadSerializedString() == "GSharp.NativeProtocols" {
                return blob.ReadSerializedString()!!
            }
        }
        throw InvalidOperationException("Required native protocol manifest absent")
    }

    @Fact
    func RetainedEntriesPreserveSavedMutationAndOriginalPayload() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ProtocolEntries
import System

protocol Message {}
protocol NextValue { func Next() int32; }
protocol Missing { func Missing() int32; }

struct Counter : Message, NextValue {
    var Step int32
    func Next() int32 {
        Step += 1
        return Step
    }
}

func Echo(value NextValue) NextValue -> value

func Main() {
    var x = Counter{Step: 10}
    var p NextValue = x
    let independent NextValue = x
    x.Step = 30
    let q = Echo(p)
    Console.WriteLine(q.Next())
    Console.WriteLine(p.Next())
    Console.WriteLine(independent.Next())
    Console.WriteLine(x.Step)
    let message Message = p
    if message is NextValue view {
        Console.WriteLine(view.Next())
    }
    let view = message as NextValue
    Console.WriteLine(view!!.Next())
    if message is Counter saved {
        var extracted = saved
        Console.WriteLine(extracted.Next())
    }
    Console.WriteLine(p.Next())
    Console.WriteLine(message is Missing)
    Console.WriteLine((message as Missing) == nil)
    p = Counter{Step: 50}
    Console.WriteLine(p.Next())
    Console.WriteLine((message as NextValue)!!.Next())
}`, "protocol-retained-entries", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(`11
12
11
30
13
14
15
15
False
True
51
16
`, fixture.Run(dll))
    }

    @Fact
    func ExtensionsRemainByValueAndClassInsertionRetainsTheEvaluatedObject() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package ProtocolReceivers
import System

protocol NextValue { func Next() int32; }
struct CopyCounter { var Step int32 }
func (value CopyCounter) Next() int32 {
    var copy = value
    copy.Step += 1
    return copy.Step
}
class Counter {
    var Step int32
    func Next() int32 {
        Step += 1
        return Step
    }
}
func Main() {
    let copy NextValue = CopyCounter{Step: 10}
    Console.WriteLine(copy.Next())
    Console.WriteLine(copy.Next())
    var source = Counter{Step: 20}
    let original = source
    let saved NextValue = source
    source = Counter{Step: 90}
    Console.WriteLine(saved.Next())
    Console.WriteLine(original.Step)
    Console.WriteLine(source.Step)
    if saved is Counter recovered {
        Console.WriteLine(Object.ReferenceEquals(recovered, original))
    }
}`, "protocol-receiver-conventions", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(`11
11
21
21
90
True
`, fixture.Run(dll))
    }
}
