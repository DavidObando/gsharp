// <copyright file="InterfaceAdaptationReviewTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.Diagnostics.CodeAnalysis
import System.IO
import System.Reflection
import System.Reflection.Emit
import System.Runtime.CompilerServices
import Xunit

class InterfaceAdaptationReviewTests {
    @Fact
    func RichPlansRemainBindingSpecificAcrossNullableSequenceSpecializations() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package RichNullableSequenceSpecializations
import System
interface Reader[T] { func Read() T; }
func values[T](value T) sequence[T?] {
    let reader = object : Reader[T] {
        func Read() T -> value
    }
    yield reader.Read()
    yield nil
}
func Main() {
    for value in values[int32](46) {
        if value != nil { Console.WriteLine(value) }
    }
    for value in values[string]("specialized") {
        if value != nil { Console.WriteLine(value) }
    }
}`, "rich-nullable-sequence-specializations", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(`46
specialized
`, fixture.Run(dll))
    }

    @Fact
    func NullLiteralCannotBeAdaptedEvenToDefaultOnlyInterface() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package NullLiteralAdapter
interface Empty { }
interface DefaultOnly { func Read() int32 { return 1 } }
func Bad() {
    let empty = adapt[Empty](nil)
    let defaulted = adapt[DefaultOnly](nil)
}`, "null-literal-adapter", executable: false)
        Assert.NotEqual(0, code)
        Assert.Equal(2, output.Split("error GS0606:").Length - 1)
        Assert.Contains("null literal cannot be adapted", output)
    }

    @Fact
    func UnconstrainedGenericAdaptersCheckReferenceInstantiationsForNull() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package GenericAdapterNulls
import System
interface DefaultOnly { func Read() int32 { return 1 } }
func Adapt[T](source T) DefaultOnly -> adapt[DefaultOnly](source)
func Main() {
    try {
        let value = Adapt[string?](nil)
        Console.WriteLine("missed")
    } catch (ArgumentNullException) {
        Console.WriteLine("null")
    }
    Console.WriteLine(Adapt[int32](7).Read())
}`, "generic-adapter-nulls", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(`null
1
`, fixture.Run(dll))
    }

    @Fact
    func UserTargetsRespectReadonlyImportedHandleMembers() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`using System;
namespace ReadonlyUserTargetAdapters;
public struct Source
{
    private int value;
    public Source(int value) => this.value = value;
    public readonly int Read() => value;
    public readonly int Value => value;
    public int Mutable { get => value; set => this.value = value; }
    public event Action? Changed;
}`, "ReadonlyUserTargetAdapters")
        let valid = fixture.Compile(`package ReadonlyUserTargetControl
import System
import ReadonlyUserTargetAdapters
interface Reader {
    func Read() int32;
    prop Value int32 { get; }
}
func Main() {
    var source = Source(47)
    let location = readonly managed(source)
    let adapted = adapt[Reader](ref location)
    Console.WriteLine(adapted.Read())
    Console.WriteLine(adapted.Value)
}`, "readonly-user-target-control", executable: true, "/r:" + contracts)
        IlVerifier.Verify(valid, []string{contracts})
        Assert.Equal(`47
47
`, fixture.Run(valid))
        let invalid = []string{
            "interface Target { prop Mutable int32 { get; set; } }",
            "interface Target { event Changed () -> void }"
        }
        for var i = 0; i < invalid.Length; i++ {
            let (code, output) = fixture.TryCompile((`package InvalidReadonlyUserTarget
import ReadonlyUserTargetAdapters
` + "${invalid[i]}" + `
func Bad() {
    var source = Source(1)
    let location = readonly managed(source)
    let adapted = adapt[Target](ref location)
}`), "invalid-readonly-user-target-" + i.ToString(), executable: false, "/r:" + contracts)
            Assert.NotEqual(0, code)
            Assert.Contains("error GS0606:", output)
        }
    }

    @Fact
    func UserStaticVirtualPropertiesAreNotInstanceAdapterSlots() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package InvalidUserStaticAdapterProperty
interface Target {
    shared {
        prop Helper int32 { get { return 1 } }
    }
}
class Source { prop Helper int32 -> 2 }
func Bad() { let adapted = adapt[Target](Source()) }`, "invalid-user-static-adapter-property", executable: false)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0606:", output)
        Assert.Contains("static interface property requirement", output)
    }

    @Fact
    func RichBaseArgumentsRejectBorrowedAndRefLikeStorage() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`using System;
namespace RichBaseArguments;
public class RefBase { public RefBase(ref int value) { } }
public class SpanBase { public SpanBase(ReadOnlySpan<int> value) { } }
public class ScalarBase { public ScalarBase(int value) { } }
public static class Inputs
{
    private static readonly int[] values = [1, 2];
    public static ReadOnlySpan<int> Values => values;
}`, "RichBaseArguments")
        let invalid = []string{"func Bad() object { return object : SpanBase(Inputs.Values) { } }"}
        for var i = 0; i < invalid.Length; i++ {
            let (code, output) = fixture.TryCompile(`package InvalidRichBase
import RichBaseArguments
` + invalid[i], "invalid-rich-base-" + i.ToString(), executable: false, "/r:" + contracts)
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("cannot be retained", StringComparison.Ordinal), output)
        }
        let control = fixture.Compile(`package RichBaseControl
import RichBaseArguments
func Main() { let value = object : ScalarBase(7) { } }`, "rich-base-control", executable: true, "/r:" + contracts)
        IlVerifier.Verify(control, []string{contracts})
    }

    @Fact
    func ScopedManagedHandlesCannotEnterRichStoredState() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let invalid = []string{`interface Reader { func Read() int32; }
func Bad(scoped handle managed[int32]) object {
    return object : Reader {
        let Snapshot = handle
        func Read() int32 -> *Snapshot
    }
}`, `open class Base(Value managed[int32]) { }
func Bad(scoped handle managed[int32]) object {
    return object : Base(handle) { }
}`}
        for var i = 0; i < invalid.Length; i++ {
            let (code, output) = fixture.TryCompile(
                "package ScopedRichStorage\n" + invalid[i],
                "scoped-rich-storage-" + i.ToString(),
                executable: false
            )
            Assert.NotEqual(0, code)
            Assert.Contains("error GS0604:", output)
            Assert.Contains("scoped managed handle", output)
        }
    }

    @Fact
    func MixedOriginAdaptersForwardBothDirectionsAndImportedBaseSlots() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`using System;
namespace MixedAdapterOrigins;
public interface IImported
{
    int Read();
    int Value { get; set; }
    event Action<int> Changed;
}
public sealed class ImportedSource
{
    public int Value { get; set; }
    public int Read() => Value;
    public event Action<int>? Changed;
}
public interface IGenericBase<T> { T Echo(T value); }
public sealed class ImportedGenericSource<T> { public T Echo(T value) => value; }`, "MixedAdapterOrigins")
        let dll = fixture.Compile(`package MixedAdapterOriginConsumer
import System
import MixedAdapterOrigins

interface IUser {
    func Read() int32;
    prop Value int32 { get; set; }
    event Changed (int32) -> void
}
interface IUserWithImportedBase[T] : IGenericBase[T] { }
class UserSource {
    var stored int32
    func Read() int32 -> stored
    prop Value int32 {
        get -> stored
        set -> this.stored = value
    }
    event Changed (int32) -> void
}

func Main() {
    let imported = ImportedSource()
    let userTarget = adapt[IUser](imported)
    userTarget.Value = 41
    Console.WriteLine(userTarget.Read())

    let user = UserSource()
    let importedTarget = adapt[IImported](user)
    importedTarget.Value = 42
    Console.WriteLine(importedTarget.Read())

    let inherited = adapt[IUserWithImportedBase[string]](ImportedGenericSource[string]())
    Console.WriteLine(inherited.Echo("generic-base"))
}`, "mixed-adapter-origin-consumer", executable: true, "/r:" + contracts)
        IlVerifier.Verify(dll, []string{contracts})
        Assert.Equal(`41
42
generic-base
`, fixture.Run(dll))
    }

    @Fact
    func PairwiseMatrix_LocalValueCopyForwardsImportedInheritedMembers() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`using System;
namespace PairwiseValueContracts;
public interface IBase<T> { T Echo(T value); }
public interface IComposite<T> : IBase<T>
{
    T Value { get; set; }
    T this[int index] { get; set; }
    event Action<T> Changed;
    void Raise(T value);
}`, "PairwiseValueContracts")
        let dll = fixture.Compile(`package PairwiseValueConsumer
import System
import PairwiseValueContracts

struct LocalSource {
    var stored int32
    var indexed int32
    event Changed (int32) -> void
    func Echo(value int32) int32 -> value
    prop Value int32 {
        get -> stored
        set -> this.stored = value
    }
    prop this[index int32] int32 {
        get -> indexed
        set -> this.indexed = value
    }
    func Raise(value int32) { Changed?.Invoke(value) }
}

func Main() {
    var original = LocalSource{stored: 1, indexed: 2}
    let adapted = adapt[IComposite[int32]](original)
    var observed = 0
    let handler = (value int32) -> { observed = value }
    adapted.Changed += handler
    adapted.Value = 51
    adapted[0] = 52
    adapted.Raise(53)
    adapted.Changed -= handler
    Console.WriteLine(adapted.Echo(50))
    Console.WriteLine(adapted.Value)
    Console.WriteLine(adapted[0])
    Console.WriteLine(observed)
    Console.WriteLine(original.stored)
    Console.WriteLine(original.indexed)
}`, "pairwise-value-consumer", executable: true, "/r:" + contracts)
        IlVerifier.Verify(dll, []string{contracts})
        Assert.Equal(`50
51
52
53
1
2
`, fixture.Run(dll))
    }

    @Fact
    func PairwiseMatrix_ReadonlyHandleForwardsLocalInheritedGenericView() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`namespace PairwiseReadonlySources;
public struct Source<T>
{
    private T value;
    public Source(T value) => this.value = value;
    public readonly T Read() => value;
    public T Value { readonly get => value; set => this.value = value; }
    public T this[int index] { readonly get => value; set => this.value = value; }
}
public sealed class Notifier<T>
{
    public event System.Action<T>? Changed;
    public void Raise(T value) => Changed?.Invoke(value);
}`, "PairwiseReadonlySources")
        let dll = fixture.Compile(`package PairwiseReadonlyConsumer
import System
import PairwiseReadonlySources

interface BaseView[T] { func Read() T; }
interface View[T] : BaseView[T] {
    prop Value T { get; }
    prop this[index int32] T { get; }
}
interface EventView[T] {
    event Changed (T) -> void
    func Raise(value T);
}

func Main() {
    var source = Source[string]("readonly")
    let location = readonly managed(source)
    let adapted = adapt[View[string]](ref location)
    Console.WriteLine(adapted.Read())
    Console.WriteLine(adapted.Value)
    Console.WriteLine(adapted[0])

    let notifier = Notifier[string]()
    let events = adapt[EventView[string]](notifier)
}`, "pairwise-readonly-consumer", executable: true, "/r:" + contracts)
        IlVerifier.Verify(dll, []string{contracts})
        Assert.Equal(`readonly
readonly
readonly
`, fixture.Run(dll))
        let (code, output) = fixture.TryCompile(`package PairwiseReadonlyReject
import PairwiseReadonlySources
interface MutableView[T] {
    prop Value T { get; set; }
    prop this[index int32] T { get; set; }
}
func Bad() {
    var source = Source[int32](1)
    let location = readonly managed(source)
    let adapted = adapt[MutableView[int32]](ref location)
}`, "pairwise-readonly-reject", executable: false, "/r:" + contracts)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0606:", output)
    }

    @Fact
    func SymbolicImportedGenericAdaptersPreserveEnclosingTypeParameters() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`using System;
namespace SymbolicImportedAdapters;
public interface IBase<T>
{
    T Value { get; }
    T this[int index] { get; }
    event Action<T> Changed;
}
public interface IReader<T> : IBase<T> { T Read(); }
public sealed class Source<T>
{
    private readonly T value;
    public Source(T value) => this.value = value;
    public T Value => value;
    public T this[int index] => value;
    public event Action<T>? Changed;
    public T Read() => value;
}`, "SymbolicImportedAdapters")
        let reference = Path.Combine(fixture.Directory, "SymbolicImportedAdapterApi.ref.dll")
        let dll = fixture.Compile(`package SymbolicImportedAdapterApi
import System
import SymbolicImportedAdapters
public func Wrap[T](source Source[T]) IReader[T] {
    return adapt[IReader[T]](source)
}
func Main() {
    let text = Wrap[string](Source[string]("symbolic"))
    Console.WriteLine(text.Read())
    Console.WriteLine(text.Value)
    Console.WriteLine(text[0])
    let number = Wrap[int32](Source[int32](44))
    Console.WriteLine(number.Read())
    Console.WriteLine(number.Value)
    Console.WriteLine(number[0])
}`, "SymbolicImportedAdapterApi", executable: true, "/r:" + contracts, "/refout:" + reference)
        IlVerifier.Verify(dll, []string{contracts})
        Assert.True(File.Exists(reference))
        Assert.Equal(`symbolic
symbolic
symbolic
44
44
44
`, fixture.Run(dll))
    }

    @Fact
    func ConcreteStaticInterfacePropertiesAreNotAdapterSlots() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`using System;
namespace StaticAdapterProperties;
public interface ITarget
{
    static int Helper => 1;
    static event Action Changed { add { } remove { } }
    int Read();
}
public interface IStaticRequired
{
    static abstract event Action Changed;
}
public sealed class Source
{
    public int Helper => 2;
    public event Action? Changed;
    public int Read() => 45;
}`, "StaticAdapterProperties")
        let dll = fixture.Compile(`package StaticAdapterPropertyConsumer
import System
import StaticAdapterProperties
func Main() {
    let adapted = adapt[ITarget](Source())
    Console.WriteLine(adapted.Read())
}`, "static-adapter-property-consumer", executable: true, "/r:" + contracts)
        IlVerifier.Verify(dll, []string{contracts})
        Assert.Equal("45\n", fixture.Run(dll))
        let (code, output) = fixture.TryCompile(`package InvalidStaticAdapterEvent
import StaticAdapterProperties
func Bad() { let adapted = adapt[IStaticRequired](Source()) }`, "invalid-static-adapter-event", executable: false, "/r:" +
                contracts)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0606:", output)
    }

    @Fact
    func GenericRichLiteralOmittedReturnUsesTheEnclosingConstruction() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package GenericRichReturn
import System
interface Reader[T] { func Read() T; }
private func Make[T](value T) -> object : Reader[T] {
    func Read() T -> value
}
func Main() {
    Console.WriteLine(Make[string]("generic").Read())
    Console.WriteLine(Make[int32](42).Read())
}`, "generic-rich-return", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(`generic
42
`, fixture.Run(dll))
    }

    @Fact
    func BorrowedCapturesRejectWhileSnapshotsAndManagedHandlesRemainSafe() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let invalid = []string{
            "func Bad(in value int32) Reader { return object : Reader { func Read() int32 -> value } }",
            "func Bad(ref value int32) Reader { return object : Reader { func Read() int32 -> value } }",
            "func Bad(out value int32) Reader { value = 1; return object : Reader { func Read() int32 -> value } }",
            "func Bad() Reader { var value = 1; let ref alias = value; return object : Reader { func Read() int32 -> alias } }",
            "func Bad() Reader { var value = 1; let ref readonly alias = value; return object : Reader { func Read() int32 -> alias } }",
            "struct Owner { var Value int32; func Bad() Reader { let ref alias = this.Value; return object : Reader { func Read() int32 -> alias } } }"
        }
        for var i = 0; i < invalid.Length; i++ {
            let (code, output) = fixture.TryCompile(`package BorrowedCapture
interface Reader { func Read() int32; }
` + invalid[i], "borrowed-capture-" + i.ToString(), executable: false)
            Assert.NotEqual(0, code)
            Assert.Contains("error GS0604:", output)
        }
        let valid = fixture.Compile(`package BorrowedCaptureControls
import System
interface Reader { func Read() int32; }
func Snapshot(in value int32) Reader {
    return object : Reader {
        let Snapshot = value
        func Read() int32 -> Snapshot
    }
}
struct Source {
    var Value int32
    func Read() int32 -> Value
}
func Main() {
    var value = 7
    Console.WriteLine(Snapshot(in value).Read())
    var source = Source{Value: 9}
    let location = managed(source)
    Console.WriteLine(adapt[Reader](ref location).Read())
}`, "borrowed-capture-controls", executable: true)
        IlVerifier.Verify(valid)
        Assert.Equal(`7
9
`, fixture.Run(valid))
    }

    @Fact
    func PointerAndFunctionPointerSourcesRejectEvenWithoutAbstractSlots() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package PointerAdapters
interface Empty { }
interface DefaultOnly { func Value() int32 { return 1 } }
unsafe func ManagedTarget() int32 -> 1
unsafe func Pointer(p *int32) { let adapted = adapt[Empty](p) }
unsafe func ManagedFunctionPointer() {
    let p *func() int32 = &ManagedTarget
    let adapted = adapt[DefaultOnly](p)
}
unsafe func UnmanagedFunctionPointer(p unmanaged[Cdecl] () -> int32) {
    let adapted = adapt[Empty](p)
}`, "pointer-adapters", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Split("error GS0606:").Length - 1 >= 3, output)
        let controls = fixture.Compile(`package PointerAdapterControls
interface Empty { }
class Source { }
func Main() {
    let reference = adapt[Empty](Source())
    let scalar = adapt[Empty](42)
}`, "pointer-adapter-controls", executable: true)
        IlVerifier.Verify(controls)
    }

    @Fact
    func RichShellsPreserveOwnerMethodNestedAndShadowedGenerics() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(`package RichGenericShells
import System
interface Pair[A, B] { func First() A; func Second() B; }
interface Triple[A, B, C] { func First() A; func Second() B; func Third() C; }
interface Mixed[T] { func Inner() T; func Outer() object; }
interface Marker[T] { }
interface DefaultFactory[T] {
    func MakeDefault() Marker[T] {
        return object : Marker[T] {
            func Value() int32 -> 0
        }
    }
}
interface VariantOwner[out T] {
    func Get() T;
    private func Make[T struct]() Marker[T] {
        return object : Marker[T] {
            let Outer = this.Get()
            func Value() int32 -> 1
        }
    }
}

class Owner[T class] {
    func PairWith[U struct](first T, second U) Pair[T, U] {
        return object : Pair[T, U] {
            func First() T -> first
            func Second() U -> second
        }
    }

    public struct Middle[V struct] {
        func Make[W](first T, second V, third W) Triple[T, V, W] {
            return object : Triple[T, V, W] {
                func First() T -> first
                func Second() V -> second
                func Third() W -> third
            }
        }
    }
}

class Shadow[T class](Value T) {
    func Make[T struct](inner T) Mixed[T] {
        let outer = this.Value
        return object : Mixed[T] {
            func Inner() T -> inner
            func Outer() object -> outer
        }
    }

    func PrintInferred[T struct](inner T) {
        let value = MakeInferred[T](inner)
        Console.WriteLine(value.Inner())
        Console.WriteLine(value.OuterValue())
    }

    func PrintIterator[T struct](inner T) {
        for value in MakeIterator[T](inner).Values() {
            Console.WriteLine(value)
        }
    }

    private func MakeInferred[T struct](inner T) -> object {
        let Outer = this.Value
        func Inner() T -> inner
        func OuterValue() object -> Outer
    }

    private func MakeIterator[T struct](inner T) -> object {
        let Outer = this.Value
        func Values() sequence[object] {
            yield inner
            yield Outer
        }
    }
}

func Main() {
    let pair = Owner[string]().PairWith[int32]("owner", 2)
    Console.WriteLine(pair.First())
    Console.WriteLine(pair.Second())
    let middle = Owner[string].Middle[int32]{}
    let triple = middle.Make[bool]("nested", 3, true)
    Console.WriteLine(triple.First())
    Console.WriteLine(triple.Second())
    Console.WriteLine(triple.Third())
    let mixed = Shadow[string]("shadow").Make[int32](4)
    Console.WriteLine(mixed.Inner())
    Console.WriteLine(mixed.Outer())
    Shadow[string]("inferred").PrintInferred[int32](5)
    Shadow[string]("iterator").PrintIterator[int32](6)

}`, "rich-generic-shells", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal(`owner
2
nested
3
True
4
shadow
5
inferred
6
iterator
`, fixture.Run(dll))
        let reference = Path.Combine(fixture.Directory, "RichGenericApi.ref.dll")
        let library = fixture.Compile(`package RichGenericApi
public interface Pair[A, B] { func First() A; func Second() B; }
public class Owner[T class] {
    public func Make[U struct](first T, second U) Pair[T, U] {
        return object : Pair[T, U] {
            func First() T -> first
            func Second() U -> second
        }
    }
}`, "RichGenericApi", executable: false, "/refout:" + reference)
        IlVerifier.Verify(library)
        let consumer = fixture.Compile(`package RichGenericApiConsumer
import System
import RichGenericApi
let pair = Owner[string]().Make[int32]("refout", 5)
Console.WriteLine(pair.First())
Console.WriteLine(pair.Second())`, "RichGenericApiConsumer", executable: true, "/r:" + reference)
        IlVerifier.Verify(consumer, []string{library})
        Assert.Equal(`refout
5
`, fixture.Run(consumer))
    }

    @Fact
    func RichFieldInferenceRejectsNilAndUntypedCyclesButAcceptsExplicitTypes() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (code, output) = fixture.TryCompile(`package RichFieldInference
func BadNil() object {
    return object {
        let Value = nil
        func Touch() { }
    }
}
func BadCycle() object {
    return object {
        let Value = Value
        func Touch() { }
    }
}`, "rich-field-inference-invalid", executable: false)
        Assert.NotEqual(0, code)
        Assert.True(output.Split("error GS0605:").Length - 1 >= 2, output)
        let valid = fixture.Compile(`package RichFieldInferenceControl
func Make() object {
    return object {
        let Value object? = nil
        func Touch() { }
    }
}`, "rich-field-inference-control", executable: false)
        IlVerifier.Verify(valid)
    }

    @Fact
    func ImportedInterfaceSourceClosuresForwardPropertiesAndEvents() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`using System;
namespace ImportedSourceClosure;
public interface IBaseProperty<T> { T Value { get; set; } }
public interface IBaseEvent<T> { event Action<T> Changed; }
public interface ILeft<T> : IBaseProperty<T>, IBaseEvent<T> { }
public interface IRight<T> : IBaseProperty<T>, IBaseEvent<T> { }
public interface IDiamond<T> : ILeft<T>, IRight<T> { }
public interface ITarget<T> { T Value { get; set; } event Action<T> Changed; }
public sealed class Source<T> : IDiamond<T>
{
    public T Value { get; set; }
    public event Action<T>? Changed;
    public Source(T value) => Value = value;
    public void Raise(T value) => Changed?.Invoke(value);
}
public interface IA { int Value { get; } }
public interface IB { int Value { get; } }
public interface IAmbiguous : IA, IB { }
public interface IGet { int Value { get; } }
public sealed class Ambiguous : IAmbiguous { public int Value => 1; }`, "ImportedSourceClosure")
        let dll = fixture.Compile(`package ImportedSourceClosureConsumer
import System
import ImportedSourceClosure
func Main() {
    let concrete = Source[int32](7)
    let source IDiamond[int32] = concrete
    let adapted = adapt[ITarget[int32]](source)
    adapted.Value = 8
    var observed = 0
    let handler = (value int32) -> { observed = value }
    adapted.Changed += handler
    concrete.Raise(9)
    adapted.Changed -= handler
    Console.WriteLine(adapted.Value)
    Console.WriteLine(observed)
}`, "imported-source-closure-consumer", executable: true, "/r:" + contracts)
        IlVerifier.Verify(dll, []string{contracts})
        Assert.Equal(`8
9
`, fixture.Run(dll))
        let (code, output) = fixture.TryCompile(`package ImportedSourceAmbiguity
import ImportedSourceClosure
func Bad(source IAmbiguous) { let adapted = adapt[IGet](source) }`, "imported-source-ambiguity", executable: false, "/r:" +
                contracts)
        Assert.NotEqual(0, code)
        Assert.Contains("error GS0606:", output)
        Assert.Contains("ambiguous", output)
    }

    @Fact
    func ImportedDefaultEventsInheritOrDiagnoseBeforeReadonlyForwarding() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = Path.Combine(fixture.Directory, "DefaultEvents.dll")
        BuildDefaultEventContractLibrary(contracts)
        let valid = fixture.Compile(`package DefaultEventConsumer
import DefaultEvents
interface Target : IDefault { }
func Main() {
    var value = 1
    let location = readonly managed(value)
    let adapted = adapt[Target](ref location)
}`, "default-event-consumer", executable: true, "/r:" + contracts)
        IlVerifier.Verify(valid, []string{contracts})
        let eventSource = fixture.CompileCSharp(`using System;
namespace InheritedImportedEvent;
public interface IBase { event Action? Changed; }
public struct Source { public event Action? Changed; }`, "InheritedImportedEvent")
        let (readonlyCode, readonlyOutput) = fixture.TryCompile(`package InvalidReadonlyInheritedEvent
import InheritedImportedEvent
interface Target : IBase { }
func Bad() {
    var source = Source{}
    let location = readonly managed(source)
    let adapted = adapt[Target](ref location)
}`, "invalid-readonly-inherited-event", executable: false, "/r:" + eventSource)
        Assert.NotEqual(0, readonlyCode)
        Assert.Contains("error GS0606:", readonlyOutput)
        Assert.Contains("readonly managed-handle adaptation cannot forward event 'Changed'", readonlyOutput)
        for target in[]string{"IPartial", "IConflict"} {
            let (code, output) = fixture.TryCompile((`package InvalidDefaultEvent
import DefaultEvents
func Bad() { let adapted = adapt[` + "$target" + `](1) }`), "invalid-default-event-" +
                    target, executable: false, "/r:" + contracts)
            Assert.NotEqual(0, code)
            Assert.Contains("error GS0606:", output)
        }
    }

    @Fact
    func DefaultPropertyDiamondsRequireOneMostSpecificImplementation() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let (userCode, userOutput) = fixture.TryCompile(`package UserDefaultPropertyConflict
interface IA { prop Value int32 { get { return 1 } } }
interface IB { prop Value int32 { get { return 2 } } }
interface IConflict : IA, IB { }
class Source { }
func Bad() { let adapted = adapt[IConflict](Source()) }`, "user-default-property-conflict", executable: false)
        Assert.NotEqual(0, userCode)
        Assert.Contains("error GS0606:", userOutput)
        Assert.Contains("no unique most-specific", userOutput)
        let contracts = fixture.CompileCSharp(`namespace ImportedDefaultProperties;
public interface IA { int Value => 1; }
public interface IB { int Value => 2; }
public interface IConflict : IA, IB { }
public interface IMostSpecific : IA, IB { new int Value => 3; }
public sealed class Source { }`, "ImportedDefaultProperties")
        let valid = fixture.Compile(`package ImportedDefaultPropertyControl
import ImportedDefaultProperties
func Main() { let adapted = adapt[IMostSpecific](Source()) }`, "imported-default-property-control", executable: true, "/r:" +
                contracts)
        IlVerifier.Verify(valid, []string{contracts})
        let (importedCode, importedOutput) = fixture.TryCompile(`package ImportedDefaultPropertyConflict
import ImportedDefaultProperties
func Bad() { let adapted = adapt[IConflict](Source()) }`, "imported-default-property-conflict", executable: false, "/r:" +
                contracts)
        Assert.NotEqual(0, importedCode)
        Assert.Contains("error GS0606:", importedOutput)
        Assert.Contains("no unique most-specific", importedOutput)
    }

    @Fact
    func ImportedAdapterEventsPreserveNestedNullabilityMetadata() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`#nullable enable
using System;
namespace NullableAdapterEvents;
public interface ITarget { event Action<string?> Changed; }
public sealed class Source
{
    public event Action<string?>? Changed;
    public void Raise(string? value) => Changed?.Invoke(value);
}`, "NullableAdapterEvents")
        let reference = Path.Combine(fixture.Directory, "NullableAdapterEventApi.ref.dll")
        let dll = fixture.Compile(`package NullableAdapterEventApi
import NullableAdapterEvents
public func Create() ITarget { return adapt[ITarget](Source()) }`, "NullableAdapterEventApi", executable: false, "/r:" +
                contracts, "/refout:" + reference)
        IlVerifier.Verify(dll, []string{contracts})
        Assert.True(File.Exists(reference))
        let assemblies = EmittedFixture.LoadTogether(contracts, dll)
        let assembly = assemblies[1]
        let adapter = Assert.Single(
            assembly.GetTypes(),
            (type Type) -> type.Name.StartsWith("<>Adapter", StringComparison.Ordinal)
        )
        let eventInfo EventInfo? = adapter.GetEvent("Changed", BindingFlags.Instance | BindingFlags.NonPublic)
        Assert.NotNull(eventInfo)
        let addMethod MethodInfo? = eventInfo!!.GetAddMethod(nonPublic: true)
        Assert.NotNull(addMethod)
        let addParameter = Assert.Single(addMethod!!.GetParameters())
        let addNullability = NullabilityInfoContext().Create(addParameter)
        Assert.Equal(NullabilityState.Nullable, Assert.Single(addNullability.GenericTypeArguments).ReadState)
        let removeMethod MethodInfo? = eventInfo!!.GetRemoveMethod(nonPublic: true)
        Assert.NotNull(removeMethod)
        let removeParameter = Assert.Single(removeMethod!!.GetParameters())
        let removeNullability = NullabilityInfoContext().Create(removeParameter)
        Assert.Equal(NullabilityState.Nullable, Assert.Single(removeNullability.GenericTypeArguments).ReadState)
    }

    @Fact
    func ImportedGenericNullabilityAndConstraintMetadataRemainExact() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`#nullable enable
using System.Collections.Generic;
namespace GenericAdapterContracts;
public interface IFoo { }
public interface IBar { }
public sealed class Item : IFoo, IBar { public Item() { } }
public interface INullable { T? Echo<T>(T? value); }
public interface INonNullable { T Echo<T>(T value); }
public interface INested { List<T?> Echo<T>(List<T?> value); }
public sealed class NullableExact { public T? Echo<T>(T? value) => value; }
public sealed class NonNullableExact { public T Echo<T>(T value) => value; }
public sealed class NestedExact { public List<T?> Echo<T>(List<T?> value) => value; }
public interface IOneBound { T Echo<T>(T value) where T : IFoo; }
public sealed class OneBound { public T Echo<T>(T value) where T : IFoo => value; }
public interface IMixedBound { T Echo<T>(T value) where T : class, IFoo, new(); }
public sealed class MixedBound { public T Echo<T>(T value) where T : class, IFoo, new() => value; }
public interface IValueBound { T Echo<T>(T value) where T : struct, IFoo; }
public sealed class ValueBound { public T Echo<T>(T value) where T : struct, IFoo => value; }
public interface ITwoBounds { T Echo<T>(T value) where T : IFoo, IBar; }
public sealed class TwoBounds { public T Echo<T>(T value) where T : IFoo, IBar => value; }`, "GenericAdapterContracts")
        let reference = Path.Combine(fixture.Directory, "GenericAdapterApi.ref.dll")
        let valid = fixture.Compile(`package GenericAdapterApi
import System.Collections.Generic
import GenericAdapterContracts
public func Nullable() INullable { return adapt[INullable](NullableExact()) }
public func Nested() INested { return adapt[INested](NestedExact()) }
public func One() IOneBound { return adapt[IOneBound](OneBound()) }
public func Mixed() IMixedBound { return adapt[IMixedBound](MixedBound()) }
public func Value() IValueBound { return adapt[IValueBound](ValueBound()) }`, "GenericAdapterApi", executable: false, "/r:" +
                contracts, "/refout:" + reference)
        IlVerifier.Verify(valid, []string{contracts})
        Assert.True(File.Exists(reference))
        let invalidPrograms = []string{
            "func Bad() { let value = adapt[INullable](NonNullableExact()) }",
            "func Bad() { let value = adapt[INonNullable](NullableExact()) }",
            "func Bad() { let value = adapt[ITwoBounds](TwoBounds()) }"
        }
        for var i = 0; i < invalidPrograms.Length; i++ {
            let (code, output) = fixture.TryCompile(`package InvalidGenericAdapters
import GenericAdapterContracts
` + invalidPrograms[i], "invalid-generic-adapter-" + i.ToString(), executable: false, "/r:" + contracts)
            Assert.NotEqual(0, code)
            Assert.Contains("error GS0606:", output)
        }
    }

    @Fact
    func UnsupportedAccessorCustomModifiersRejectBeforeMethodImplEmission() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = Path.Combine(fixture.Directory, "UnsupportedAdapterModifiers.dll")
        BuildUnsupportedModifierContractLibrary(contracts)
        let invalid = []string{
            "func Bad() { let adapted = adapt[ITarget](Source()) }",
            "interface LocalTarget { prop Value int32 { get; } }\nfunc Bad() { let adapted = adapt[LocalTarget](Source()) }",
            "class LocalSource { prop Value int32 -> 1 }\nfunc Bad() { let adapted = adapt[ITarget](LocalSource()) }",
            "func Bad() { let adapted = adapt[IEventTarget](EventSource()) }",
            `interface LocalEventTarget { event Changed () -> void }
func Bad() { let adapted = adapt[LocalEventTarget](EventSource()) }`,
            "class LocalEventSource { event Changed () -> void }\nfunc Bad() { let adapted = adapt[IEventTarget](LocalEventSource()) }",
            "func Bad() { let adapted = adapt[IMethodTarget](MethodSource()) }",
            "interface LocalMethodTarget { func Read() int32; }\nfunc Bad() { let adapted = adapt[LocalMethodTarget](MethodSource()) }",
            `class LocalMethodSource { func Read() int32 -> 1 }
func Bad() { let adapted = adapt[IMethodTarget](LocalMethodSource()) }`
        }
        for var i = 0; i < invalid.Length; i++ {
            let (code, output) = fixture.TryCompile(`package UnsupportedModifierConsumer
import UnsupportedAdapterModifiers
` + invalid[i], "unsupported-modifier-consumer-" + i.ToString(), executable: false, "/r:" + contracts)
            Assert.NotEqual(0, code)
            Assert.Contains("error GS0606:", output)
        }
        let control = fixture.Compile(`package SupportedModifierControl
import UnsupportedAdapterModifiers
func Main() { let adapted = adapt[IControl](ControlSource()) }`, "supported-modifier-control", executable: true, "/r:" +
                contracts)
        IlVerifier.Verify(control, []string{contracts})
    }

    @Fact
    func MixedOriginRefPropertyMetadataRemainsExact() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = Path.Combine(fixture.Directory, "RefPropertyAdapterContracts.dll")
        BuildRefPropertyContractLibrary(contracts)
        let contractAssembly = EmittedFixture.Load(contracts)
        let importedGetter MethodInfo? = contractAssembly
            .GetType("RefPropertyAdapterContracts.IUnscopedRefTarget")
            ?.GetProperty("RefValue")
            ?.GetMethod
        Assert.NotNull(importedGetter)
        Assert.Contains(
            importedGetter!!.ReturnParameter.GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Diagnostics.CodeAnalysis.UnscopedRefAttribute"
        )
        let reference = Path.Combine(fixture.Directory, "RefPropertyAdapterApi.ref.dll")
        let valid = fixture.Compile(`package RefPropertyAdapterApi
import System.Diagnostics.CodeAnalysis
import RefPropertyAdapterContracts

struct LocalSource {
    shared { var stored int32 }
    prop RefValue ref int32 -> LocalSource.stored
}

public func LocalSourceToImportedTarget(source LocalSource) IRefTarget {
    return adapt[IRefTarget](source)
}`, "RefPropertyAdapterApi", executable: false, "/r:" + contracts, "/refout:" + reference)
        IlVerifier.Verify(valid, []string{contracts})
        Assert.True(File.Exists(reference))
        let invalid = []string{`struct LocalSource {
    shared { var stored int32 }
    prop RefValue ref int32 -> LocalSource.stored
}
func Bad() { let adapted = adapt[IUnscopedRefTarget](LocalSource{}) }`}
        for var i = 0; i < invalid.Length; i++ {
            let (code, output) = fixture.TryCompile(`package InvalidRefPropertyAdapter
import RefPropertyAdapterContracts
` + invalid[i], "invalid-ref-property-adapter-" + i.ToString(), executable: false, "/r:" + contracts)
            Assert.NotEqual(0, code)
            Assert.True(output.Contains("error GS0606:", StringComparison.Ordinal), output)
        }
    }

    @Fact
    func SourcePropertyInitOnlyContractMustMatchWhenSetterIsRequired() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let exact = fixture.Compile(`package InitOnlyAdapters
interface InitTarget { prop Value int32 { get; init; } }
interface GetTarget { prop Value int32 { get; } }
class InitSource { prop Value int32 { get; init; } }
func Main() {
    let exact = adapt[InitTarget](InitSource())
    let getter = adapt[GetTarget](InitSource())
}`, "init-only-adapter-exact", executable: true)
        IlVerifier.Verify(exact)
        let invalid = []string{
            "interface Target { prop Value int32 { get; set; } }\nclass Source { prop Value int32 { get; init; } }",
            "interface Target { prop Value int32 { get; init; } }\nclass Source { prop Value int32 { get; set; } }"
        }
        for var i = 0; i < invalid.Length; i++ {
            let (code, output) = fixture.TryCompile(
                "package InvalidInitAdapter\n" + invalid[i] + "\nfunc Bad() { let value = adapt[Target](Source()) }",
                "invalid-init-adapter-" + i.ToString(),
                executable: false
            )
            Assert.True(code != 0, "init-only case $i unexpectedly compiled: $output")
            Assert.Contains("error GS0606:", output)
        }
        let imported = fixture.CompileCSharp(`namespace ImportedInitContracts;
public interface IInit { int Value { get; init; } }
public sealed class InitExact { public int Value { get; init; } }
public sealed class SetMismatch { public int Value { get; set; } }`, "ImportedInitContracts")
        let importedExact = fixture.Compile(`package ImportedInitConsumer
import ImportedInitContracts
func Main() { let value = adapt[IInit](InitExact()) }`, "imported-init-exact", executable: true, "/r:" + imported)
        IlVerifier.Verify(importedExact, []string{imported})
        let (importedCode, importedOutput) = fixture.TryCompile(`package InvalidImportedInitConsumer
import ImportedInitContracts
func Bad() { let value = adapt[IInit](SetMismatch()) }`, "imported-init-mismatch", executable: false, "/r:" + imported)
        Assert.NotEqual(0, importedCode)
        Assert.Contains("error GS0606:", importedOutput)
    }

    @Fact
    func StaticAbstractOperatorRequirementsDiagnoseBeforeSpecialNameFiltering() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let contracts = fixture.CompileCSharp(`namespace StaticOperatorContracts;
public interface IOperator
{
    static abstract IOperator operator +(IOperator left, IOperator right);
    static virtual IOperator operator -(IOperator left, IOperator right) => left;
    int Read();
}
public interface IOperatorOnly
{
    static abstract IOperatorOnly operator +(IOperatorOnly left, IOperatorOnly right);
}
public sealed class Source { public int Read() => 1; }`, "StaticOperatorContracts")
        let (code, output) = fixture.TryCompile(`package StaticOperatorConsumer
import StaticOperatorContracts
func Bad() {
    let mixed = adapt[IOperator](Source())
    let only = adapt[IOperatorOnly](Source())
}`, "static-operator-consumer", executable: false, "/r:" + contracts)
        Assert.NotEqual(0, code)
        Assert.True(output.Split("error GS0606:").Length - 1 >= 2, output)
        Assert.Contains("op_Addition", output)
    }

    shared {
        private func BuildDefaultEventContractLibrary(path string) {
            let assembly = PersistedAssemblyBuilder(AssemblyName("DefaultEvents"), typeof(object).Assembly)
            let module = assembly.DefineDynamicModule("DefaultEvents")
            let first = DefineEventInterface(module, "DefaultEvents.IA", addDefault: true, removeDefault: true)
            let second = DefineEventInterface(module, "DefaultEvents.IB", addDefault: true, removeDefault: true)
            DefineEventInterface(module, "DefaultEvents.IDefault", addDefault: true, removeDefault: true)
            DefineEventInterface(module, "DefaultEvents.IPartial", addDefault: true, removeDefault: false)
            DefineEventInterface(module, "DefaultEvents.IConflict", addDefault: nil, removeDefault: nil, first, second)
            assembly.Save(path)
        }

        private func BuildUnsupportedModifierContractLibrary(path string) {
            let assembly = PersistedAssemblyBuilder(
                AssemblyName("UnsupportedAdapterModifiers"),
                typeof(object).Assembly
            )
            let module = assembly.DefineDynamicModule("UnsupportedAdapterModifiers")
            DefineModifierPropertyType(
                module,
                "UnsupportedAdapterModifiers.ITarget",
                isInterface: true,
                useModifier: true
            )
            DefineModifierPropertyType(
                module,
                "UnsupportedAdapterModifiers.Source",
                isInterface: false,
                useModifier: true
            )
            DefineModifierEventType(module, "UnsupportedAdapterModifiers.IEventTarget", isInterface: true)
            DefineModifierEventType(module, "UnsupportedAdapterModifiers.EventSource", isInterface: false)
            DefineModifierMethodType(module, "UnsupportedAdapterModifiers.IMethodTarget", isInterface: true)
            DefineModifierMethodType(module, "UnsupportedAdapterModifiers.MethodSource", isInterface: false)
            DefineModifierPropertyType(
                module,
                "UnsupportedAdapterModifiers.IControl",
                isInterface: true,
                useModifier: false
            )
            DefineModifierPropertyType(
                module,
                "UnsupportedAdapterModifiers.ControlSource",
                isInterface: false,
                useModifier: false
            )
            assembly.Save(path)
        }

        private func BuildRefPropertyContractLibrary(path string) {
            let assembly = PersistedAssemblyBuilder(
                AssemblyName("RefPropertyAdapterContracts"),
                typeof(object).Assembly
            )
            let module = assembly.DefineDynamicModule("RefPropertyAdapterContracts")
            DefineRefPropertyInterface(module, "RefPropertyAdapterContracts.IRefTarget", unscoped: false)
            DefineRefPropertyInterface(module, "RefPropertyAdapterContracts.IUnscopedRefTarget", unscoped: true)
            assembly.Save(path)
        }

        private func DefineRefPropertyInterface(module ModuleBuilder, name string, unscoped bool) {
            let type = module.DefineType(
                name,
                TypeAttributes.Public | TypeAttributes.Interface | TypeAttributes.Abstract
            )
            let methodAttributes = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName | MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot
            let byRefInt = typeof(int32).MakeByRefType()
            let getter = type.DefineMethod("get_RefValue", methodAttributes)
            getter.SetSignature(
                byRefInt,
                returnTypeRequiredCustomModifiers: nil,
                returnTypeOptionalCustomModifiers: nil,
                parameterTypes: Type.EmptyTypes,
                parameterTypeRequiredCustomModifiers: nil,
                parameterTypeOptionalCustomModifiers: nil
            )
            if unscoped {
                let constructor ConstructorInfo? = typeof(UnscopedRefAttribute).GetConstructor(Type.EmptyTypes)
                Assert.NotNull(constructor)
                getter.DefineParameter(0, ParameterAttributes.Retval, nil).SetCustomAttribute(
                    CustomAttributeBuilder(constructor!!, Array.Empty[object]())
                )
            }
            let property = type.DefineProperty("RefValue", PropertyAttributes.None, byRefInt, Type.EmptyTypes)
            property.SetGetMethod(getter)
            type.CreateType()
        }

        private func DefineModifierPropertyType(module ModuleBuilder, name string, isInterface bool, useModifier bool) {
            let attributes = TypeAttributes.Public | (
                if isInterface {
                    TypeAttributes.Interface | TypeAttributes.Abstract
                } else {
                    TypeAttributes.Class
                }
            )
            let type = module.DefineType(name, attributes)
            if !isInterface {
                type.DefineDefaultConstructor(MethodAttributes.Public)
            }
            var methodAttributes = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
            if isInterface {
                methodAttributes |= MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot
            }
            let getter = type.DefineMethod("get_Value", methodAttributes)
            getter.SetSignature(
                typeof(int32),
                returnTypeRequiredCustomModifiers: nil,
                returnTypeOptionalCustomModifiers: if useModifier {
                    []Type{typeof(IsVolatile)}
                } else {
                    default([]?Type)
                },
                parameterTypes: Type.EmptyTypes,
                parameterTypeRequiredCustomModifiers: nil,
                parameterTypeOptionalCustomModifiers: nil
            )
            if !isInterface {
                getter.GetILGenerator().Emit(OpCodes.Ldc_I4_1)
                getter.GetILGenerator().Emit(OpCodes.Ret)
            }
            let property = type.DefineProperty("Value", PropertyAttributes.None, typeof(int32), Type.EmptyTypes)
            property.SetGetMethod(getter)
            type.CreateType()
        }

        private func DefineModifierMethodType(module ModuleBuilder, name string, isInterface bool) {
            let attributes = TypeAttributes.Public | (
                if isInterface {
                    TypeAttributes.Interface | TypeAttributes.Abstract
                } else {
                    TypeAttributes.Class
                }
            )
            let type = module.DefineType(name, attributes)
            if !isInterface {
                type.DefineDefaultConstructor(MethodAttributes.Public)
            }
            var methodAttributes = MethodAttributes.Public | MethodAttributes.HideBySig
            if isInterface {
                methodAttributes |= MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot
            }
            let method = type.DefineMethod("Read", methodAttributes)
            method.SetSignature(
                typeof(int32),
                returnTypeRequiredCustomModifiers: nil,
                returnTypeOptionalCustomModifiers: []Type{typeof(IsVolatile)},
                parameterTypes: Type.EmptyTypes,
                parameterTypeRequiredCustomModifiers: nil,
                parameterTypeOptionalCustomModifiers: nil
            )
            if !isInterface {
                method.GetILGenerator().Emit(OpCodes.Ldc_I4_1)
                method.GetILGenerator().Emit(OpCodes.Ret)
            }
            type.CreateType()
        }

        private func DefineModifierEventType(module ModuleBuilder, name string, isInterface bool) {
            let attributes = TypeAttributes.Public | (
                if isInterface {
                    TypeAttributes.Interface | TypeAttributes.Abstract
                } else {
                    TypeAttributes.Class
                }
            )
            let type = module.DefineType(name, attributes)
            if !isInterface {
                type.DefineDefaultConstructor(MethodAttributes.Public)
            }
            var methodAttributes = MethodAttributes.Public | MethodAttributes.HideBySig | MethodAttributes.SpecialName
            if isInterface {
                methodAttributes |= MethodAttributes.Virtual | MethodAttributes.Abstract | MethodAttributes.NewSlot
            }
            let Accessor = func (prefix string) MethodBuilder {
                let method = type.DefineMethod(prefix + "_Changed", methodAttributes)
                method.SetSignature(
                    typeof(Void),
                    returnTypeRequiredCustomModifiers: nil,
                    returnTypeOptionalCustomModifiers: nil,
                    parameterTypes: []Type{typeof(() -> void)},
                    parameterTypeRequiredCustomModifiers: nil,
                    parameterTypeOptionalCustomModifiers: [][]Type{[]Type{typeof(IsVolatile)}}
                )
                if !isInterface {
                    method.GetILGenerator().Emit(OpCodes.Ret)
                }
                return method
            }
            let eventBuilder = type.DefineEvent("Changed", EventAttributes.None, typeof(() -> void))
            eventBuilder.SetAddOnMethod(Accessor("add"))
            eventBuilder.SetRemoveOnMethod(Accessor("remove"))
            type.CreateType()
        }

        private func DefineEventInterface(
            module ModuleBuilder,
            name string,
            addDefault bool?,
            removeDefault bool?,
            bases ...Type
        ) Type {
            let type = module.DefineType(
                name,
                TypeAttributes.Public | TypeAttributes.Interface | TypeAttributes.Abstract
            )
            for baseInterface in bases {
                type.AddInterfaceImplementation(baseInterface)
            }
            if addDefault != nil && removeDefault != nil {
                let eventBuilder = type.DefineEvent("Changed", EventAttributes.None, typeof(() -> void))
                eventBuilder.SetAddOnMethod(DefineEventAccessor(type, "add_Changed", addDefault))
                eventBuilder.SetRemoveOnMethod(DefineEventAccessor(type, "remove_Changed", removeDefault))
            }
            return type.CreateType()
        }

        private func DefineEventAccessor(owner TypeBuilder, name string, hasBody bool) MethodBuilder {
            var attributes = MethodAttributes.Public | MethodAttributes.Virtual | MethodAttributes.NewSlot | MethodAttributes.SpecialName | MethodAttributes.HideBySig
            if !hasBody {
                attributes |= MethodAttributes.Abstract
            }
            let method = owner.DefineMethod(name, attributes, typeof(Void), []Type{typeof(() -> void)})
            if hasBody {
                method.GetILGenerator().Emit(OpCodes.Ret)
            }
            return method
        }
    }
}
