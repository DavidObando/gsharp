// <copyright file="NullabilityFunnelAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers.Tests

import GSharp.InternalAnalyzers
import System.Threading.Tasks
import Xunit

/// GSA0007 (ADR-0193 §3): the producer funnel. The real list of attributed
/// members is pinned by `Adr0193NullabilityFunnelMembersTests` in
/// Core.Tests, which reflects over the compiled compiler.
class NullabilityFunnelAnalyzerTests {
    @Fact
    func ReportsEveryDoorCalledOutsideAFunnelMember() Task {
        const Source = `package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor)
internal class NullabilityFunnelAttribute : Attribute {
}

internal enum NullabilityFreeReason { TypeLiteral, TypeStructure }

internal open class TypeSymbol {
    shared {
        @NullabilityFunnel
        func FromClrType(t Type) TypeSymbol -> TypeSymbol()

        @NullabilityFunnel
        internal func FromClrTypeWithoutNullability(t Type, reason NullabilityFreeReason) TypeSymbol -> FromClrType(t)
    }
}

internal class ImportedTypeSymbol : TypeSymbol {
    shared {
        @NullabilityFunnel
        func Get(t Type) ImportedTypeSymbol -> ImportedTypeSymbol()

        @NullabilityFunnel
        internal func GetWithoutNullability(t Type, reason NullabilityFreeReason) ImportedTypeSymbol -> Get(t)
    }
}

internal class NullableTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) NullableTypeSymbol -> NullableTypeSymbol()
    }
}

internal class PlatformTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) TypeSymbol -> t
    }
}

internal enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

internal shared class ClrNullability {
    @NullabilityFunnel
    internal func ReadNullableFlags(p ICustomAttributeProvider, m MemberInfo) ImmutableArray[uint8] -> default(ImmutableArray[uint8])

    @NullabilityFunnel
    internal func ClassifyFlag(b uint8) ClrNullabilityState -> default(ClrNullabilityState)

    @NullabilityFunnel
    internal func ClassifyPosition(f ImmutableArray[uint8], i int32) ClrNullabilityState -> ClassifyFlag(0)

    func GetReturnTypeSymbol(m MethodInfo) TypeSymbol -> TypeSymbol()
}

internal shared class NullabilityImportRule {
    @NullabilityFunnel
    internal func ApplyConcrete(t TypeSymbol, s ClrNullabilityState) TypeSymbol -> if s == ClrNullabilityState.Annotated { cast[TypeSymbol](NullableTypeSymbol.Get(t)) } else { PlatformTypeSymbol.Get(t) }
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

internal shared class MemberLookup {
    @NullabilityFunnel
    func MapOpenClrTypeToSymbolic(t Type, d Type?, a ImmutableArray[TypeSymbol]) TypeSymbol -> TypeSymbol.FromClrType(t)

    @NullabilityFunnel
    internal func MapOpenClrTypeToSymbolicWithoutNullability(
        t Type,
        d Type,
        a ImmutableArray[TypeSymbol],
        reason NullabilityFreeReason) TypeSymbol -> MapOpenClrTypeToSymbolic(t, d, a)
}

internal class Consumer {
    private func Use(t Type, m MethodInfo) {
        let _ = [|TypeSymbol.FromClrType(t)|]
        let _ = [|MemberLookup.MapOpenClrTypeToSymbolic(t, nil, default(ImmutableArray[TypeSymbol]))|]
        let _ = [|ImportedTypeSymbol.Get(t)|]
        let flags = [|ClrNullability.ReadNullableFlags(m.ReturnParameter, m)|]
        let _ = [|ClrNullability.ClassifyPosition(flags, 0)|]
        let _ = [|ClrNullability.ClassifyFlag(1)|]
        let _ = ClrNullability.GetReturnTypeSymbol(m)
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(
            NullabilityFunnelAnalyzer(),
            Source,
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007"
        )
    }

    @Fact
    func FunnelMembersIncludingTheirLambdasLocalFunctionsAndAccessorsPass() Task {
        const Source = `package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import System.Linq

@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor)
internal class NullabilityFunnelAttribute : Attribute {
}

internal enum NullabilityFreeReason { TypeLiteral, TypeStructure }

internal open class TypeSymbol {
    shared {
        @NullabilityFunnel
        func FromClrType(t Type) TypeSymbol -> TypeSymbol()

        @NullabilityFunnel
        internal func FromClrTypeWithoutNullability(t Type, reason NullabilityFreeReason) TypeSymbol -> FromClrType(t)
    }
}

internal class ImportedTypeSymbol : TypeSymbol {
    shared {
        @NullabilityFunnel
        func Get(t Type) ImportedTypeSymbol -> ImportedTypeSymbol()

        @NullabilityFunnel
        internal func GetWithoutNullability(t Type, reason NullabilityFreeReason) ImportedTypeSymbol -> Get(t)
    }
}

internal class NullableTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) NullableTypeSymbol -> NullableTypeSymbol()
    }
}

internal class PlatformTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) TypeSymbol -> t
    }
}

internal enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

internal shared class ClrNullability {
    @NullabilityFunnel
    internal func ReadNullableFlags(p ICustomAttributeProvider, m MemberInfo) ImmutableArray[uint8] -> default(ImmutableArray[uint8])

    @NullabilityFunnel
    internal func ClassifyFlag(b uint8) ClrNullabilityState -> default(ClrNullabilityState)

    @NullabilityFunnel
    internal func ClassifyPosition(f ImmutableArray[uint8], i int32) ClrNullabilityState -> ClassifyFlag(0)

    func GetReturnTypeSymbol(m MethodInfo) TypeSymbol -> TypeSymbol()
}

internal shared class NullabilityImportRule {
    @NullabilityFunnel
    internal func ApplyConcrete(t TypeSymbol, s ClrNullabilityState) TypeSymbol -> if s == ClrNullabilityState.Annotated { cast[TypeSymbol](NullableTypeSymbol.Get(t)) } else { PlatformTypeSymbol.Get(t) }
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import System.Linq

internal shared class MemberLookup {
    @NullabilityFunnel
    func MapOpenClrTypeToSymbolic(t Type, d Type, a ImmutableArray[TypeSymbol]) TypeSymbol -> TypeSymbol.FromClrType(t)

    @NullabilityFunnel
    internal func MapOpenClrTypeToSymbolicWithoutNullability(
        t Type,
        d Type,
        a ImmutableArray[TypeSymbol],
        reason NullabilityFreeReason) TypeSymbol -> MapOpenClrTypeToSymbolic(t, d, a)
}

internal class Reader {
    @NullabilityFunnel
    private func Read(types []Type) TypeSymbol {
        let Local = func (t Type) TypeSymbol {
            return TypeSymbol.FromClrType(t)
        }
        let mapped = types.Select((t Type) -> TypeSymbol.FromClrType(t)).ToArray()
        return Local(types[0])
    }

    @NullabilityFunnel
    private prop Shape TypeSymbol -> TypeSymbol.FromClrType(typeof(string))
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(NullabilityFunnelAnalyzer(), Source)
    }

    @Fact
    func ExemptionIsPerMemberNotPerType() Task {
        // A sibling member of an attributed one — even in the door-defining
        // type itself — is checked like any other code.
        const Source = `package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor)
internal class NullabilityFunnelAttribute : Attribute {
}

internal enum NullabilityFreeReason { TypeLiteral, TypeStructure }

internal open class TypeSymbol {
    shared {
        @NullabilityFunnel
        func FromClrType(t Type) TypeSymbol -> TypeSymbol()

        @NullabilityFunnel
        internal func FromClrTypeWithoutNullability(t Type, reason NullabilityFreeReason) TypeSymbol -> FromClrType(t)
    }
}

internal class ImportedTypeSymbol : TypeSymbol {
    shared {
        @NullabilityFunnel
        func Get(t Type) ImportedTypeSymbol -> ImportedTypeSymbol()

        @NullabilityFunnel
        internal func GetWithoutNullability(t Type, reason NullabilityFreeReason) ImportedTypeSymbol -> Get(t)
    }
}

internal class NullableTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) NullableTypeSymbol -> NullableTypeSymbol()
    }
}

internal class PlatformTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) TypeSymbol -> t
    }
}

internal enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

internal shared class ClrNullability {
    @NullabilityFunnel
    internal func ReadNullableFlags(p ICustomAttributeProvider, m MemberInfo) ImmutableArray[uint8] -> default(ImmutableArray[uint8])

    @NullabilityFunnel
    internal func ClassifyFlag(b uint8) ClrNullabilityState -> default(ClrNullabilityState)

    @NullabilityFunnel
    internal func ClassifyPosition(f ImmutableArray[uint8], i int32) ClrNullabilityState -> ClassifyFlag(0)

    func GetReturnTypeSymbol(m MethodInfo) TypeSymbol -> TypeSymbol()
}

internal shared class NullabilityImportRule {
    @NullabilityFunnel
    internal func ApplyConcrete(t TypeSymbol, s ClrNullabilityState) TypeSymbol -> if s == ClrNullabilityState.Annotated { cast[TypeSymbol](NullableTypeSymbol.Get(t)) } else { PlatformTypeSymbol.Get(t) }
}

internal partial class TypeSymbolExtras {
    @NullabilityFunnel
    private func Allowed(t Type) TypeSymbol -> TypeSymbol.FromClrType(t)

    private func NotAllowed(t Type) TypeSymbol -> [|TypeSymbol.FromClrType(t)|]
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

internal shared class MemberLookup {
    @NullabilityFunnel
    func MapOpenClrTypeToSymbolic(t Type, d Type, a ImmutableArray[TypeSymbol]) TypeSymbol -> TypeSymbol.FromClrType(t)

    @NullabilityFunnel
    internal func MapOpenClrTypeToSymbolicWithoutNullability(
        t Type,
        d Type,
        a ImmutableArray[TypeSymbol],
        reason NullabilityFreeReason) TypeSymbol -> MapOpenClrTypeToSymbolic(t, d, a)
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(NullabilityFunnelAnalyzer(), Source, "GSA0007")
    }

    @Fact
    func ReportsADoorPassedAsAMethodGroup() Task {
        const Source = `package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import System.Linq

@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor)
internal class NullabilityFunnelAttribute : Attribute {
}

internal enum NullabilityFreeReason { TypeLiteral, TypeStructure }

internal open class TypeSymbol {
    shared {
        @NullabilityFunnel
        func FromClrType(t Type) TypeSymbol -> TypeSymbol()

        @NullabilityFunnel
        internal func FromClrTypeWithoutNullability(t Type, reason NullabilityFreeReason) TypeSymbol -> FromClrType(t)
    }
}

internal class ImportedTypeSymbol : TypeSymbol {
    shared {
        @NullabilityFunnel
        func Get(t Type) ImportedTypeSymbol -> ImportedTypeSymbol()

        @NullabilityFunnel
        internal func GetWithoutNullability(t Type, reason NullabilityFreeReason) ImportedTypeSymbol -> Get(t)
    }
}

internal class NullableTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) NullableTypeSymbol -> NullableTypeSymbol()
    }
}

internal class PlatformTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) TypeSymbol -> t
    }
}

internal enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

internal shared class ClrNullability {
    @NullabilityFunnel
    internal func ReadNullableFlags(p ICustomAttributeProvider, m MemberInfo) ImmutableArray[uint8] -> default(ImmutableArray[uint8])

    @NullabilityFunnel
    internal func ClassifyFlag(b uint8) ClrNullabilityState -> default(ClrNullabilityState)

    @NullabilityFunnel
    internal func ClassifyPosition(f ImmutableArray[uint8], i int32) ClrNullabilityState -> ClassifyFlag(0)

    func GetReturnTypeSymbol(m MethodInfo) TypeSymbol -> TypeSymbol()
}

internal shared class NullabilityImportRule {
    @NullabilityFunnel
    internal func ApplyConcrete(t TypeSymbol, s ClrNullabilityState) TypeSymbol -> if s == ClrNullabilityState.Annotated { cast[TypeSymbol](NullableTypeSymbol.Get(t)) } else { PlatformTypeSymbol.Get(t) }
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import System.Linq

internal shared class MemberLookup {
    @NullabilityFunnel
    func MapOpenClrTypeToSymbolic(t Type, d Type, a ImmutableArray[TypeSymbol]) TypeSymbol -> TypeSymbol.FromClrType(t)

    @NullabilityFunnel
    internal func MapOpenClrTypeToSymbolicWithoutNullability(
        t Type,
        d Type,
        a ImmutableArray[TypeSymbol],
        reason NullabilityFreeReason) TypeSymbol -> MapOpenClrTypeToSymbolic(t, d, a)
}

internal class Consumer {
    private func Map(types []Type) []TypeSymbol -> types.Select([|TypeSymbol.FromClrType|]).ToArray()
    private func Escape() (Type, NullabilityFreeReason) -> TypeSymbol -> [|TypeSymbol.FromClrTypeWithoutNullability|]
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(NullabilityFunnelAnalyzer(), Source, "GSA0007", "GSA0007")
    }

    @Fact
    func EscapeHatchIsAllowedForNonSignatureTypes() Task {
        const Source = `package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Binding

@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor)
internal class NullabilityFunnelAttribute : Attribute {
}

internal enum NullabilityFreeReason { TypeLiteral, TypeStructure }

internal open class TypeSymbol {
    shared {
        @NullabilityFunnel
        func FromClrType(t Type) TypeSymbol -> TypeSymbol()

        @NullabilityFunnel
        internal func FromClrTypeWithoutNullability(t Type, reason NullabilityFreeReason) TypeSymbol -> FromClrType(t)
    }
}

internal class ImportedTypeSymbol : TypeSymbol {
    shared {
        @NullabilityFunnel
        func Get(t Type) ImportedTypeSymbol -> ImportedTypeSymbol()

        @NullabilityFunnel
        internal func GetWithoutNullability(t Type, reason NullabilityFreeReason) ImportedTypeSymbol -> Get(t)
    }
}

internal class NullableTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) NullableTypeSymbol -> NullableTypeSymbol()
    }
}

internal class PlatformTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) TypeSymbol -> t
    }
}

internal enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

internal shared class ClrNullability {
    @NullabilityFunnel
    internal func ReadNullableFlags(p ICustomAttributeProvider, m MemberInfo) ImmutableArray[uint8] -> default(ImmutableArray[uint8])

    @NullabilityFunnel
    internal func ClassifyFlag(b uint8) ClrNullabilityState -> default(ClrNullabilityState)

    @NullabilityFunnel
    internal func ClassifyPosition(f ImmutableArray[uint8], i int32) ClrNullabilityState -> ClassifyFlag(0)

    func GetReturnTypeSymbol(m MethodInfo) TypeSymbol -> TypeSymbol()
}

internal shared class NullabilityImportRule {
    @NullabilityFunnel
    internal func ApplyConcrete(t TypeSymbol, s ClrNullabilityState) TypeSymbol -> if s == ClrNullabilityState.Annotated { cast[TypeSymbol](NullableTypeSymbol.Get(t)) } else { PlatformTypeSymbol.Get(t) }
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Binding

internal shared class MemberLookup {
    @NullabilityFunnel
    func MapOpenClrTypeToSymbolic(t Type, d Type?, a ImmutableArray[TypeSymbol]) TypeSymbol -> TypeSymbol.FromClrType(t)

    @NullabilityFunnel
    internal func MapOpenClrTypeToSymbolicWithoutNullability(
        t Type,
        d Type?,
        a ImmutableArray[TypeSymbol],
        reason NullabilityFreeReason) TypeSymbol -> MapOpenClrTypeToSymbolic(t, d, a)
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Emit

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Binding

internal class Emitter {
    private func Use(symbol TypeSymbol, helperResult Type) {
        let _ = TypeSymbol.FromClrTypeWithoutNullability(typeof(int32), NullabilityFreeReason.TypeLiteral)
        let _ = TypeSymbol.FromClrTypeWithoutNullability(
            symbol.GetType().GetGenericArguments()[0],
            NullabilityFreeReason.TypeStructure)
        let _ = ImportedTypeSymbol.GetWithoutNullability(typeof(string), NullabilityFreeReason.TypeLiteral)
        let _ = MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
            helperResult,
            nil,
            default(ImmutableArray[TypeSymbol]),
            NullabilityFreeReason.TypeStructure)
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(NullabilityFunnelAnalyzer(), Source)
    }

    @Fact
    func EscapeHatchIsReportedOnASignatureAccessorWithinTheMethod() Task {
        const Source = `package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor)
internal class NullabilityFunnelAttribute : Attribute {
}

internal enum NullabilityFreeReason { TypeLiteral, TypeStructure }

internal open class TypeSymbol {
    shared {
        @NullabilityFunnel
        func FromClrType(t Type?) TypeSymbol -> TypeSymbol()

        @NullabilityFunnel
        internal func FromClrTypeWithoutNullability(t Type?, reason NullabilityFreeReason) TypeSymbol -> FromClrType(t)
    }
}

internal class ImportedTypeSymbol : TypeSymbol {
    shared {
        @NullabilityFunnel
        func Get(t Type) ImportedTypeSymbol -> ImportedTypeSymbol()

        @NullabilityFunnel
        internal func GetWithoutNullability(t Type, reason NullabilityFreeReason) ImportedTypeSymbol -> Get(t)
    }
}

internal class NullableTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) NullableTypeSymbol -> NullableTypeSymbol()
    }
}

internal class PlatformTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) TypeSymbol -> t
    }
}

internal enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

internal shared class ClrNullability {
    @NullabilityFunnel
    internal func ReadNullableFlags(p ICustomAttributeProvider, m MemberInfo) ImmutableArray[uint8] -> default(ImmutableArray[uint8])

    @NullabilityFunnel
    internal func ClassifyFlag(b uint8) ClrNullabilityState -> default(ClrNullabilityState)

    @NullabilityFunnel
    internal func ClassifyPosition(f ImmutableArray[uint8], i int32) ClrNullabilityState -> ClassifyFlag(0)

    func GetReturnTypeSymbol(m MethodInfo) TypeSymbol -> TypeSymbol()
}

internal shared class NullabilityImportRule {
    @NullabilityFunnel
    internal func ApplyConcrete(t TypeSymbol, s ClrNullabilityState) TypeSymbol -> if s == ClrNullabilityState.Annotated { cast[TypeSymbol](NullableTypeSymbol.Get(t)) } else { PlatformTypeSymbol.Get(t) }
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

internal shared class MemberLookup {
    @NullabilityFunnel
    func MapOpenClrTypeToSymbolic(t Type?, d Type?, a ImmutableArray[TypeSymbol]) TypeSymbol -> TypeSymbol.FromClrType(t)

    @NullabilityFunnel
    internal func MapOpenClrTypeToSymbolicWithoutNullability(
        t Type?,
        d Type?,
        a ImmutableArray[TypeSymbol],
        reason NullabilityFreeReason) TypeSymbol -> MapOpenClrTypeToSymbolic(t, d, a)
}

internal class Consumer {
    private func Use(method MethodInfo, property PropertyInfo, field FieldInfo, evt EventInfo) {
        let _ = [|TypeSymbol.FromClrTypeWithoutNullability(method.ReturnType, NullabilityFreeReason.TypeStructure)|]
        let _ = [|TypeSymbol.FromClrTypeWithoutNullability(
            reason: NullabilityFreeReason.TypeStructure,
            t: method.ReturnType)|]
        let _ = [|TypeSymbol.FromClrTypeWithoutNullability(
            method.ReturnParameter.ParameterType,
            NullabilityFreeReason.TypeStructure)|]
        let _ = [|TypeSymbol.FromClrTypeWithoutNullability(
            method.GetParameters()[0].ParameterType.GetElementType(),
            NullabilityFreeReason.TypeStructure)|]
        let _ = [|TypeSymbol.FromClrTypeWithoutNullability(
            property.PropertyType.GetGenericArguments()[0],
            NullabilityFreeReason.TypeStructure)|]
        let _ = [|ImportedTypeSymbol.GetWithoutNullability(field.FieldType, NullabilityFreeReason.TypeStructure)|]
        let _ = [|MemberLookup.MapOpenClrTypeToSymbolicWithoutNullability(
            evt.EventHandlerType,
            nil,
            default(ImmutableArray[TypeSymbol]),
            NullabilityFreeReason.TypeStructure)|]
        let local = method.ReturnType
        let element Type? = local.GetElementType()
        let _ = [|TypeSymbol.FromClrTypeWithoutNullability(element, NullabilityFreeReason.TypeStructure)|]
        var assigned Type
        assigned = property.PropertyType
        let _ = [|TypeSymbol.FromClrTypeWithoutNullability(assigned, NullabilityFreeReason.TypeStructure)|]
        for parameter in method.GetParameters() {
            let _ = [|TypeSymbol.FromClrTypeWithoutNullability(
                parameter.ParameterType,
                NullabilityFreeReason.TypeStructure)|]
        }
        for argument in method.ReturnType.GetGenericArguments() {
            let _ = [|TypeSymbol.FromClrTypeWithoutNullability(argument, NullabilityFreeReason.TypeStructure)|]
        }
        Split(field.FieldType, out var fromOut)
        let _ = [|TypeSymbol.FromClrTypeWithoutNullability(fromOut, NullabilityFreeReason.TypeStructure)|]
    }

    // A reassigned parameter is traced like a local; an untouched one is not.
    private func Reassigned(method MethodInfo, type Type, untouched Type) {
        var type = type
        let _ = TypeSymbol.FromClrTypeWithoutNullability(untouched, NullabilityFreeReason.TypeStructure)
        type = method.ReturnType
        let _ = [|TypeSymbol.FromClrTypeWithoutNullability(type, NullabilityFreeReason.TypeStructure)|]
    }

    shared {
        private func Split(type Type, out result Type) -> result = type
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(
            NullabilityFunnelAnalyzer(),
            Source,
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007",
            "GSA0007"
        )
    }

    @Fact
    func WrapperFactoriesAreReportedInsideFunnelWalkersOnly() Task {
        const Source = (`package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor)
internal class NullabilityFunnelAttribute : Attribute {
}

internal enum NullabilityFreeReason { TypeLiteral, TypeStructure }

internal open class TypeSymbol {
    shared {
        @NullabilityFunnel
        func FromClrType(t Type) TypeSymbol -> TypeSymbol()

        @NullabilityFunnel
        internal func FromClrTypeWithoutNullability(t Type, reason NullabilityFreeReason) TypeSymbol -> FromClrType(t)
    }
}

internal class ImportedTypeSymbol : TypeSymbol {
    shared {
        @NullabilityFunnel
        func Get(t Type) ImportedTypeSymbol -> ImportedTypeSymbol()

        @NullabilityFunnel
        internal func GetWithoutNullability(t Type, reason NullabilityFreeReason) ImportedTypeSymbol -> Get(t)
    }
}

internal class NullableTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) NullableTypeSymbol -> NullableTypeSymbol()
    }
}

internal class PlatformTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) TypeSymbol -> t
    }
}

internal enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

internal shared class ClrNullability {
    @NullabilityFunnel
    internal func ReadNullableFlags(p ICustomAttributeProvider, m MemberInfo) ImmutableArray[uint8] -> default(ImmutableArray[uint8])

    @NullabilityFunnel
    internal func ClassifyFlag(b uint8) ClrNullabilityState -> default(ClrNullabilityState)

    @NullabilityFunnel
    internal func ClassifyPosition(f ImmutableArray[uint8], i int32) ClrNullabilityState -> ClassifyFlag(0)

    func GetReturnTypeSymbol(m MethodInfo) TypeSymbol -> TypeSymbol()
}

internal shared class NullabilityImportRule {
    @NullabilityFunnel
    internal func ApplyConcrete(t TypeSymbol, s ClrNullabilityState) TypeSymbol -> if s == ClrNullabilityState.Annotated { cast[TypeSymbol](NullableTypeSymbol.Get(t)) } else { PlatformTypeSymbol.Get(t) }
}

internal shared class Walker {
    @NullabilityFunnel
    private func Walk(t Type) TypeSymbol {
        let mapped = TypeSymbol.FromClrType(t)
        let _ = [|NullableTypeSymbol.Get(mapped)|]
        return [|PlatformTypeSymbol.Get(mapped)|]
    }

    // Outside the funnel the language wraps types it already has (the
    // ` + "`" + `?.` + "`" + ` result, a nil arm): not a door.
    private func Language(t TypeSymbol) TypeSymbol -> NullableTypeSymbol.Get(t)
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

internal shared class MemberLookup {
    @NullabilityFunnel
    func MapOpenClrTypeToSymbolic(t Type, d Type, a ImmutableArray[TypeSymbol]) TypeSymbol -> TypeSymbol.FromClrType(t)

    @NullabilityFunnel
    internal func MapOpenClrTypeToSymbolicWithoutNullability(
        t Type,
        d Type,
        a ImmutableArray[TypeSymbol],
        reason NullabilityFreeReason) TypeSymbol -> MapOpenClrTypeToSymbolic(t, d, a)
}
`)
        return AnalyzerTestHelper.AssertDiagnosticsAsync(NullabilityFunnelAnalyzer(), Source, "GSA0007", "GSA0007")
    }

    @Fact
    func IgnoresCodeOutsideCore() Task {
        const Source = `package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor)
internal class NullabilityFunnelAttribute : Attribute {
}

internal enum NullabilityFreeReason { TypeLiteral, TypeStructure }

internal open class TypeSymbol {
    shared {
        @NullabilityFunnel
        func FromClrType(t Type) TypeSymbol -> TypeSymbol()

        @NullabilityFunnel
        internal func FromClrTypeWithoutNullability(t Type, reason NullabilityFreeReason) TypeSymbol -> FromClrType(t)
    }
}

internal class ImportedTypeSymbol : TypeSymbol {
    shared {
        @NullabilityFunnel
        func Get(t Type) ImportedTypeSymbol -> ImportedTypeSymbol()

        @NullabilityFunnel
        internal func GetWithoutNullability(t Type, reason NullabilityFreeReason) ImportedTypeSymbol -> Get(t)
    }
}

internal class NullableTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) NullableTypeSymbol -> NullableTypeSymbol()
    }
}

internal class PlatformTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) TypeSymbol -> t
    }
}

internal enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

internal shared class ClrNullability {
    @NullabilityFunnel
    internal func ReadNullableFlags(p ICustomAttributeProvider, m MemberInfo) ImmutableArray[uint8] -> default(ImmutableArray[uint8])

    @NullabilityFunnel
    internal func ClassifyFlag(b uint8) ClrNullabilityState -> default(ClrNullabilityState)

    @NullabilityFunnel
    internal func ClassifyPosition(f ImmutableArray[uint8], i int32) ClrNullabilityState -> ClassifyFlag(0)

    func GetReturnTypeSymbol(m MethodInfo) TypeSymbol -> TypeSymbol()
}

internal shared class NullabilityImportRule {
    @NullabilityFunnel
    internal func ApplyConcrete(t TypeSymbol, s ClrNullabilityState) TypeSymbol -> if s == ClrNullabilityState.Annotated { cast[TypeSymbol](NullableTypeSymbol.Get(t)) } else { PlatformTypeSymbol.Get(t) }
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

internal shared class MemberLookup {
    @NullabilityFunnel
    func MapOpenClrTypeToSymbolic(t Type, d Type, a ImmutableArray[TypeSymbol]) TypeSymbol -> TypeSymbol.FromClrType(t)

    @NullabilityFunnel
    internal func MapOpenClrTypeToSymbolicWithoutNullability(
        t Type,
        d Type,
        a ImmutableArray[TypeSymbol],
        reason NullabilityFreeReason) TypeSymbol -> MapOpenClrTypeToSymbolic(t, d, a)
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Cs2Gs.Tests

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

internal class Test {
    private func Probe(t Type) TypeSymbol -> TypeSymbol.FromClrType(t)
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(NullabilityFunnelAnalyzer(), Source)
    }

    @Fact
    func CatchesTheHistoricalSymbolicReturnGap() Task {
        // ADR-0193: `ResolveCallReturnTypeFromSymbolicTypeArgs` projected an
        // open generic return through symbolic method type arguments and
        // returned it with no declaration-nullability merge (#4361, deferred
        // by PR #4362 round 3). The same shape, un-suppressed, is reported.
        const Source = `package GSharp.Core.CodeAnalysis.Symbols

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

@AttributeUsage(AttributeTargets.Property | AttributeTargets.Method | AttributeTargets.Constructor)
internal class NullabilityFunnelAttribute : Attribute {
}

internal enum NullabilityFreeReason { TypeLiteral, TypeStructure }

internal open class TypeSymbol {
    shared {
        @NullabilityFunnel
        func FromClrType(t Type) TypeSymbol -> TypeSymbol()

        @NullabilityFunnel
        internal func FromClrTypeWithoutNullability(t Type, reason NullabilityFreeReason) TypeSymbol -> FromClrType(t)
    }
}

internal class ImportedTypeSymbol : TypeSymbol {
    shared {
        @NullabilityFunnel
        func Get(t Type) ImportedTypeSymbol -> ImportedTypeSymbol()

        @NullabilityFunnel
        internal func GetWithoutNullability(t Type, reason NullabilityFreeReason) ImportedTypeSymbol -> Get(t)
    }
}

internal class NullableTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) NullableTypeSymbol -> NullableTypeSymbol()
    }
}

internal class PlatformTypeSymbol : TypeSymbol {
    shared {
        func Get(t TypeSymbol) TypeSymbol -> t
    }
}

internal enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

internal shared class ClrNullability {
    @NullabilityFunnel
    internal func ReadNullableFlags(p ICustomAttributeProvider, m MemberInfo) ImmutableArray[uint8] -> default(ImmutableArray[uint8])

    @NullabilityFunnel
    internal func ClassifyFlag(b uint8) ClrNullabilityState -> default(ClrNullabilityState)

    @NullabilityFunnel
    internal func ClassifyPosition(f ImmutableArray[uint8], i int32) ClrNullabilityState -> ClassifyFlag(0)

    func GetReturnTypeSymbol(m MethodInfo) TypeSymbol -> TypeSymbol()
}

internal shared class NullabilityImportRule {
    @NullabilityFunnel
    internal func ApplyConcrete(t TypeSymbol, s ClrNullabilityState) TypeSymbol -> if s == ClrNullabilityState.Annotated { cast[TypeSymbol](NullableTypeSymbol.Get(t)) } else { PlatformTypeSymbol.Get(t) }
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Immutable
import System.Reflection
import GSharp.Core.CodeAnalysis.Symbols

internal shared class MemberLookup {
    @NullabilityFunnel
    func MapOpenClrTypeToSymbolic(t Type, d Type?, a ImmutableArray[TypeSymbol]) TypeSymbol -> TypeSymbol.FromClrType(t)

    @NullabilityFunnel
    internal func MapOpenClrTypeToSymbolicWithoutNullability(
        t Type,
        d Type,
        a ImmutableArray[TypeSymbol],
        reason NullabilityFreeReason) TypeSymbol -> MapOpenClrTypeToSymbolic(t, d, a)
}

internal shared class Lookup {
    func ResolveCallReturnTypeFromSymbolicTypeArgs(closed MethodInfo, args ImmutableArray[TypeSymbol]) TypeSymbol {
        let openMethod = closed.GetGenericMethodDefinition()
        return [|MemberLookup.MapOpenClrTypeToSymbolic(openMethod.ReturnType, nil, args)|]
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(NullabilityFunnelAnalyzer(), Source, "GSA0007")
    }

    shared {
        // A minimal stand-in for the Core types the analyzer matches by name.
        private const Stubs string = `using System;
using System.Collections.Immutable;
using System.Reflection;

namespace GSharp.Core.CodeAnalysis.Symbols
{
    [AttributeUsage(AttributeTargets.Method | AttributeTargets.Constructor | AttributeTargets.Property)]
    sealed class NullabilityFunnelAttribute : Attribute { }

    enum NullabilityFreeReason { TypeLiteral, TypeStructure }

    class TypeSymbol
    {
        [NullabilityFunnel]
        public static TypeSymbol FromClrType(Type t) => new TypeSymbol();

        [NullabilityFunnel]
        internal static TypeSymbol FromClrTypeWithoutNullability(Type t, NullabilityFreeReason reason) => FromClrType(t);
    }

    class ImportedTypeSymbol : TypeSymbol
    {
        [NullabilityFunnel]
        public static ImportedTypeSymbol Get(Type t) => new ImportedTypeSymbol();

        [NullabilityFunnel]
        internal static ImportedTypeSymbol GetWithoutNullability(Type t, NullabilityFreeReason reason) => Get(t);
    }

    class NullableTypeSymbol : TypeSymbol
    {
        public static NullableTypeSymbol Get(TypeSymbol t) => new NullableTypeSymbol();
    }

    class PlatformTypeSymbol : TypeSymbol
    {
        public static TypeSymbol Get(TypeSymbol t) => t;
    }

    enum ClrNullabilityState { Oblivious, NotAnnotated, Annotated }

    static class ClrNullability
    {
        [NullabilityFunnel]
        internal static ImmutableArray<byte> ReadNullableFlags(ICustomAttributeProvider p, MemberInfo m) => default;

        [NullabilityFunnel]
        internal static ClrNullabilityState ClassifyFlag(byte b) => default;

        [NullabilityFunnel]
        internal static ClrNullabilityState ClassifyPosition(ImmutableArray<byte> f, int i) => ClassifyFlag(0);

        public static TypeSymbol GetReturnTypeSymbol(MethodInfo m) => new TypeSymbol();
    }

    static class NullabilityImportRule
    {
        [NullabilityFunnel]
        internal static TypeSymbol ApplyConcrete(TypeSymbol t, ClrNullabilityState s)
            => s == ClrNullabilityState.Annotated ? NullableTypeSymbol.Get(t) : PlatformTypeSymbol.Get(t);
    }
}

namespace GSharp.Core.CodeAnalysis.Binding
{
    using GSharp.Core.CodeAnalysis.Symbols;

    static class MemberLookup
    {
        [NullabilityFunnel]
        public static TypeSymbol MapOpenClrTypeToSymbolic(Type t, Type d, ImmutableArray<TypeSymbol> a) => TypeSymbol.FromClrType(t);

        [NullabilityFunnel]
        internal static TypeSymbol MapOpenClrTypeToSymbolicWithoutNullability(Type t, Type d, ImmutableArray<TypeSymbol> a, NullabilityFreeReason reason)
            => MapOpenClrTypeToSymbolic(t, d, a);
    }
}`
    }
}
