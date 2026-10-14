// <copyright file="Issue2150DataClassInterfacePropertyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2150: a data-class positional (primary-constructor) parameter is
/// materialized as an init-only property and may satisfy a matching get-only
/// interface property. Before the fix the interface-satisfaction walk only
/// scanned `StructSymbol.Properties`, so the positional field never
/// satisfied the contract and GS0187 fired. The fix recognises the positional
/// parameter as an implementation and synthesises a backing auto-property
/// getter so the emitted type carries the CLR `get_` interface slot.
/// Issue #2875 separately rejects using that init-only member for an ordinary
/// settable interface property.
open class Issue2150DataClassInterfacePropertyTests {
    @Fact
    func PositionalParams_SatisfyGetOnlyInterfaceProperties_NoDiagnostics() {
        // The exact issue repro: two positional parameters satisfy two get-only
        // interface properties. Previously reported GS0187 twice.
        const source = `package Test
interface IQuality {
    prop SampleRate int32? { get; }
    prop BitRate int32? { get; }
}
open data class Quality(SampleRate int32?, BitRate int32?) : IQuality {
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func RegularProperty_StillSatisfiesInterface_NoDiagnostics() {
        // Guard: a hand-written property still satisfies the same interface.
        const source = `package Test
interface IQuality {
    prop SampleRate int32? { get; }
}
class QualityOk : IQuality {
    prop SampleRate int32? -> nil
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func MissingInterfaceProperty_StillReportsGS0187() {
        // Don't over-fix: a genuinely missing member is still an error. The
        // positional parameter X satisfies the interface, but Y has no
        // corresponding member.
        const source = `package Test
interface IHas {
    prop X int32 { get; }
    prop Y int32 { get; }
}
open data class D(X int32) : IHas {
}`
        let diagnostics = Bind(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0187" && d.Message.Contains("Y"))
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0187" && d.Message.Contains(".X"))
    }

    @Fact
    func TypeMismatchedPositionalParam_ReportsSingleGS0504() {
        // A positional parameter whose name matches but whose type is
        // incompatible does NOT satisfy the contract, and the diagnostic is
        // reported exactly once (not duplicated by the fallback path).
        const source = `package Test
interface IHas {
    prop X int32 { get; }
}
open data class D(X string) : IHas {
}`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0504", diagnostic.Id)
        Assert.Contains("expected type 'int32', actual type 'string'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func GetOnlyNullableInterfaceProperty_SatisfiedByNullablePositionalParam_NoDiagnostics() {
        // Original #2150 repro: iface `int32?` <- impl `int32?` (exact match).
        const source = `package Test
interface IQuality {
    prop SampleRate int32? { get; }
}
open data class Quality(SampleRate int32?) : IQuality {
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GetOnlyNullableValueInterfaceProperty_NotSatisfiedByNonNullablePositionalParam_ReportsGS0504() {
        // `int32?` is CLR Nullable<int32>, not an erased annotation. Its getter
        // signature therefore differs from `int32`, so covariance is invalid.
        const source = `package Test
interface IHasNullableX {
    prop X int32? { get; }
}
open data class NonNullableX(X int32) : IHasNullableX {
}`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0504", diagnostic.Id)
        Assert.Contains("expected type 'int32?', actual type 'int32'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func GetOnlyNullableReferenceInterfaceProperty_SatisfiedByNonNullablePositionalParam_EmitsAndLoads() {
        const source = `package Test
interface IHasNullableX {
    prop X string? { get; }
}
data class NonNullableX(X string) : IHasNullableX`
        AssertEmitsAndLoads(source)
    }

    @Fact
    func GetOnlyNonNullableInterfaceProperty_SatisfiedByNonNullablePositionalParam_NoDiagnostics() {
        // Exact match: iface `int32` <- impl `int32`.
        const source = `package Test
interface IHasX {
    prop X int32 { get; }
}
open data class ExactX(X int32) : IHasX {
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func GetOnlyNonNullableInterfaceProperty_NotSatisfiedByNullablePositionalParam_ReportsGS0504() {
        // Unsound direction, now rejected: iface `int32` <- impl `int32?`.
        // A get-only interface property is a covariant (return) position, so
        // the implementation must be a SUBTYPE of the interface's declared
        // type. `int32?` is a SUPERTYPE of `int32` (never the reverse), so
        // accepting it here would let a consumer of the non-null `X int32`
        // contract observe `null` and NPE. Mirrors
        // `interface IProfileKey { prop AccountId string { get; } }` rejecting
        // `open data class ProfileKey(AccountId string?) : IProfileKey`.
        const source = `package Test
interface IProfileKey {
    prop AccountId string { get; }
}
open data class ProfileKey(AccountId string?) : IProfileKey {
}`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0504", diagnostic.Id)
        Assert.Contains("expected type 'string', actual type 'string?'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func GetSetNullableInterfaceProperty_NotSatisfiedByNullablePositionalParam_ReportsGS0502() {
        const source = `package Test
interface IHasX {
    prop X int32? { get; set; }
}
open data class ExactNullableX(X int32?) : IHasX {
}`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0502")
        Assert.Contains("positional member 'X'", diagnostic.Message, StringComparison.Ordinal)
        Assert.Contains("IHasX.X", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func GetSetNullableInterfaceProperty_NotSatisfiedByNonNullablePositionalParam_ReportsGS0504() {
        // Invariant mismatch: iface `int32?` <- impl `int32`. A setter makes
        // the interface property invariant (both a producer, via get, and a
        // consumer, via set), so widening alone is unsound: a caller could
        // `set` a `null` through the interface reference into a field the
        // implementation type promises is never null.
        const source = `package Test
interface IHasX {
    prop X int32? { get; set; }
}
open data class NonNullableX(X int32) : IHasX {
}`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0504", diagnostic.Id)
        Assert.Contains("expected type 'int32?', actual type 'int32'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func GetSetNonNullableInterfaceProperty_NotSatisfiedByNullablePositionalParam_ReportsGS0504() {
        // Invariant mismatch (reverse direction): iface `int32` <- impl
        // `int32?`. Also unsound via the `get` side (as in the get-only case).
        const source = `package Test
interface IHasX {
    prop X int32 { get; set; }
}
open data class NullableX(X int32?) : IHasX {
}`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0504", diagnostic.Id)
        Assert.Contains("expected type 'int32', actual type 'int32?'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func PositionalParam_DoesNotSatisfySetterRequiringInterfaceProperty_ReportsGS0502() {
        const source = `package Test
interface IHas {
    prop X int32 { get; set; }
}
open data class D(X int32) : IHas {
}`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0502")
        Assert.Equal(
            "Type 'D' cannot use positional member 'X' to implement interface property 'IHas.X' because the member uses accessor 'init' but the interface requires 'set'; declare property 'X' explicitly with a 'set' accessor.",
            diagnostic.Message
        )
    }

    @Fact
    func ExplicitInitOnlyProperty_DoesNotSatisfySettableInterfaceProperty_ReportsGS0502() {
        const source = `package Test
interface IHas {
    prop X int32 { get; set; }
}
class D : IHas {
    prop X int32 { get; init; }
}`
        let diagnostic = Assert.Single(Bind(source), (d Diagnostic) -> d.Id == "GS0502")
        Assert.Contains("property 'X'", diagnostic.Message, StringComparison.Ordinal)
        Assert.Contains("uses accessor 'init'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func ExplicitInitOnlyProperty_DoesNotSatisfySettableInterfaceProperty_ReportsOnlyGS0502() {
        const source = `package Test
interface IHas {
    prop X int32 { get; set; }
}
class D : IHas {
    prop (IHas) X int32 { get; init; }
}`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0502", diagnostic.Id)
        Assert.Contains("change property 'X' to use accessor 'set'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func SettableProperty_DoesNotSatisfyInitOnlyInterfaceProperty_ReportsGS0502() {
        const source = `package Test
interface IHas {
    prop X int32 { get; init; }
}
class D : IHas {
    prop X int32 { get; set; }
}`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0502", diagnostic.Id)
        Assert.Contains("uses accessor 'set'", diagnostic.Message, StringComparison.Ordinal)
        Assert.Contains("requires 'init'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func ExplicitSettableProperty_DoesNotSatisfyInitOnlyInterfaceProperty_ReportsOnlyGS0502() {
        const source = `package Test
interface IHas {
    prop X int32 { get; init; }
}
class D : IHas {
    prop (IHas) X int32 { get; set; }
}`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0502", diagnostic.Id)
        Assert.Contains("change property 'X' to use accessor 'init'", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func GenericSettableInterfaceProperty_NotSatisfiedByPositionalMember_ReportsGS0502() {
        const source = `package Test
interface IBox[T] {
    prop Value T { get; set; }
}
data class Box(Value int32) : IBox[int32]`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0502", diagnostic.Id)
        Assert.Contains("IBox[int32].Value", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func GenericMissingInterfaceProperty_ReportsGS0187() {
        const source = `package Test
interface IBox[T] {
    prop Value T { get; set; }
}
class Box : IBox[int32] {
}`
        let diagnostic = Assert.Single(Bind(source))
        Assert.Equal("GS0187", diagnostic.Id)
        Assert.Contains("Value", diagnostic.Message, StringComparison.Ordinal)
    }

    @Fact
    func GenericGetOnlyInterfaceProperty_SatisfiedByPositionalMember_EmitsAndLoads() {
        const source = `package Test
interface IBox[T] {
    prop Value T { get; }
}
data class Box(Value int32) : IBox[int32]`
        AssertEmitsAndLoads(source)
    }

    @Fact
    func ExplicitInitProperty_ConstructedGenericInterface_EmitsAndLoads() {
        const source = `package Test
interface IBox[T] {
    prop Value T { get; init; }
}
class Box : IBox[int32] {
    private prop (IBox[int32]) Value int32 { get; init; }
}`
        AssertEmitsAndLoads(source)
    }

    @Fact
    func ExplicitProperties_ForTwoConstructionsOfSameGenericInterface_EmitAndLoad() {
        const source = `package Test
interface IBox[T] {
    prop Value T { get; }
}
class Boxes : IBox[int32], IBox[string] {
    private prop (IBox[int32]) Value int32 -> 1
    private prop (IBox[string]) Value string -> "two"
}`
        AssertEmitsAndLoads(source)
    }

    @Fact
    func BaseDataClassParam_SatisfiesInterfaceListedOnDerived_NoDiagnostics() {
        // Issue #1066 semantics: a positional parameter on a base data class
        // satisfies an interface listed on a derived data class.
        const source = `package Test
interface IHas {
    prop X int32 { get; }
}
open data class Base(X int32) {
}
open data class Derived(Y int32) : Base(0), IHas {
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func EmittedType_ImplementsInterface_AndDispatchesThroughIt() {
        // The binder no longer reports GS0187, but the emitted assembly must
        // also be loadable: the data class needs a real get_ accessor to fill
        // the CLR interface slot. This test emits, loads, and dispatches a call
        // through the interface accessor — a missing accessor would surface here
        // as a TypeLoadException at load time.
        const source = `package Test
interface IQuality {
    prop SampleRate int32? { get; }
}
open data class Quality(SampleRate int32?) : IQuality {
}`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message))
        )
        peStream.Position = 0
        let loadContext = AssemblyLoadContext("Issue2150_EmitDispatch", isCollectible: true)
        try {
            let asm = loadContext.LoadFromStream(peStream)
            // Loading the type graph exercises the CLR interface-slot check.
            let quality = asm.GetTypes().First((t Type) -> t.Name == "Quality")
            let iquality = asm.GetTypes().First((t Type) -> t.Name == "IQuality")
            Assert.True(iquality.IsAssignableFrom(quality), "Quality must implement IQuality")
            let instance object? = Activator.CreateInstance(quality, []object{int32?(44100)})
            // Dispatch through the interface's get accessor (not the field).
            let getter MethodInfo? = iquality.GetMethod("get_SampleRate")
            Assert.NotNull(getter)
            let viaInterface object? = getter!!.Invoke(instance, nil)
            Assert.Equal(int32?(44100), int32?(viaInterface))
        } finally {
            loadContext.Unload()
        }
    }

    shared {
        private func Bind(source string) IReadOnlyList[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.GlobalScope.Diagnostics.ToList()
        }

        private func AssertEmitsAndLoads(source string) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            using let peStream = MemoryStream()
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            let _ = EmittedFixture.Load(peStream.ToArray()).GetTypes()
        }
    }
}
