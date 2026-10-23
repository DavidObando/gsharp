// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.IO
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Text.Json
import Xunit

class NativeProtocolLanguageTests {
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
