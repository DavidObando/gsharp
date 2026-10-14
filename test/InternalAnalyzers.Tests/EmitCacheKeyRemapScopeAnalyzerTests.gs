// <copyright file="EmitCacheKeyRemapScopeAnalyzerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.InternalAnalyzers.Tests

import GSharp.InternalAnalyzers
import System.Threading.Tasks
import Xunit

class EmitCacheKeyRemapScopeAnalyzerTests {
    @Fact
    func ReportsSymbolKeyedReferenceCachesWithoutRemapScope() Task {
        const Source = `package System.Reflection.Metadata

import System.Collections.Generic
import System.Reflection.Metadata
import GSharp.Core.CodeAnalysis.Symbols

struct EntityHandle {
}

struct MemberReferenceHandle {
}

struct TypeSpecificationHandle {
}

struct MethodSpecificationHandle {
}

struct TypeDefinitionHandle {
}

struct MethodDefinitionHandle {
}

struct FieldDefinitionHandle {
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Symbols

import System.Collections.Generic
import System.Reflection.Metadata
import GSharp.Core.CodeAnalysis.Symbols

open class TypeSymbol {
}

open class StructSymbol {
}

open class TypeParameterSymbol {
}

open class FunctionSymbol {
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Emit

import System.Collections.Generic
import System.Reflection.Metadata
import GSharp.Core.CodeAnalysis.Symbols

internal struct RemapScope {
}

internal struct BadCompositeKey {
    private let typeArgs []TypeSymbol

    init(typeArgs []TypeSymbol) {
        this.typeArgs = typeArgs
    }
}

internal class Caches {
    init() {
        NullableCtorRefs = Dictionary[TypeParameterSymbol, MemberReferenceHandle]()
    }

    private let [|plainSymbolCache|] Dictionary[StructSymbol, MemberReferenceHandle] = Dictionary[StructSymbol, MemberReferenceHandle]()
    private let [|objectTupleCache|] Dictionary[(Sym StructSymbol, ClassRemap object, MethodRemap object), EntityHandle] = Dictionary[(Sym StructSymbol, ClassRemap object, MethodRemap object), EntityHandle]()
    private let [|compositeKeyCache|] Dictionary[BadCompositeKey, MethodSpecificationHandle] = Dictionary[BadCompositeKey, MethodSpecificationHandle]()

    prop [|NullableCtorRefs|] Dictionary[TypeParameterSymbol, MemberReferenceHandle] {
        get;
    }
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(
            EmitCacheKeyRemapScopeAnalyzer(),
            Source,
            "GSA0004",
            "GSA0004",
            "GSA0004",
            "GSA0004"
        )
    }

    @Fact
    func IgnoresScopedKeysDefinitionHandlesAndNonSymbolKeys() Task {
        const Source = `package System.Reflection.Metadata

import System.Collections.Generic
import System.Reflection.Metadata
import GSharp.Core.CodeAnalysis.Symbols

struct EntityHandle {
}

struct MemberReferenceHandle {
}

struct TypeSpecificationHandle {
}

struct MethodSpecificationHandle {
}

struct TypeDefinitionHandle {
}

struct MethodDefinitionHandle {
}

struct FieldDefinitionHandle {
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Symbols

import System.Collections.Generic
import System.Reflection.Metadata
import GSharp.Core.CodeAnalysis.Symbols

open class TypeSymbol {
}

open class StructSymbol {
}

open class TypeParameterSymbol {
}

open class FunctionSymbol {
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Emit

import System.Collections.Generic
import System.Reflection.Metadata
import GSharp.Core.CodeAnalysis.Symbols

internal struct RemapScope {
}

internal struct ScopedCompositeKey {
    private let typeArgs []TypeSymbol
    private let $scope RemapScope

    init(typeArgs []TypeSymbol, $scope RemapScope) {
        this.typeArgs = typeArgs
        this.$scope = $scope
    }
}

internal class Caches {
    init() {
        ScopedProperty = Dictionary[(Tp TypeParameterSymbol, Scope RemapScope), MemberReferenceHandle]()
    }

    // Key carries the remap scope: the invariant is satisfied.
    private let scopedTupleCache Dictionary[(Sym StructSymbol, Scope RemapScope), EntityHandle] = Dictionary[(Sym StructSymbol, Scope RemapScope), EntityHandle]()

    private let scopedCompositeCache Dictionary[ScopedCompositeKey, MethodSpecificationHandle] = Dictionary[ScopedCompositeKey, MethodSpecificationHandle]()

    // Definition rows are scope-invariant: one row per symbol.
    private let typeDefCache Dictionary[StructSymbol, TypeDefinitionHandle] = Dictionary[StructSymbol, TypeDefinitionHandle]()

    private let methodDefCache Dictionary[FunctionSymbol, MethodDefinitionHandle] = Dictionary[FunctionSymbol, MethodDefinitionHandle]()

    // Non-symbol keys carry no symbolic type parameters.
    private let stringKeyedCache Dictionary[string, MemberReferenceHandle] = Dictionary[string, MemberReferenceHandle]()

    // Non-handle values are not metadata rows.
    private let symbolToSymbolsCache Dictionary[FunctionSymbol, []TypeParameterSymbol] = Dictionary[FunctionSymbol, []TypeParameterSymbol]()

    prop ScopedProperty Dictionary[(Tp TypeParameterSymbol, Scope RemapScope), MemberReferenceHandle] {
        get;
    }
}

// ---8<--- cs2gs:next-compilation-unit ---
package GSharp.Core.CodeAnalysis.Binding

import System.Collections.Generic
import System.Reflection.Metadata
import GSharp.Core.CodeAnalysis.Symbols

// Outside the Emit namespace: not this rule's concern.
internal class OtherLayer {
    private let notEmit Dictionary[StructSymbol, MemberReferenceHandle] = Dictionary[StructSymbol, MemberReferenceHandle]()
}
`
        return AnalyzerTestHelper.AssertDiagnosticsAsync(EmitCacheKeyRemapScopeAnalyzer(), Source)
    }

    shared {
        private const Prelude string = `using System.Collections.Generic;

namespace System.Reflection.Metadata
{
    public struct EntityHandle { }
    public struct MemberReferenceHandle { }
    public struct TypeSpecificationHandle { }
    public struct MethodSpecificationHandle { }
    public struct TypeDefinitionHandle { }
    public struct MethodDefinitionHandle { }
    public struct FieldDefinitionHandle { }
}

namespace GSharp.Core.CodeAnalysis.Symbols
{
    public class TypeSymbol { }
    public class StructSymbol { }
    public class TypeParameterSymbol { }
    public class FunctionSymbol { }
}
`
    }
}
