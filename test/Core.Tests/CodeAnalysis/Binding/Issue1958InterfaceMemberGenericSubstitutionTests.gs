// <copyright file="Issue1958InterfaceMemberGenericSubstitutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Regression tests for issue #1958: `InterfaceSymbol.SubstituteType` had
/// the same silent `MakeGenericType` erasure bug that PR #1956 fixed in
/// `Binder.SubstituteType` for issue #1926.
/// @remarks Root cause: when a user-defined generic interface exposes a member type
/// that is a constructed generic CLR interface over the interface's OWN type
/// parameter (issue #974 shape, e.g. `func Iter() IEnumerator[T]` on
/// `interface ISeq[T]`), constructing a closed instance (`ISeq[int32]`)
/// substitutes `T` with `int32` in that member's return type by
/// calling `IEnumerator<>.MakeGenericType(typeof(int))`. Under a
/// (cref:System.Reflection.MetadataLoadContext) reference set (as
/// cs2gs / the MSBuild task compile mode use), `IEnumerator<>` is
/// resolved through the MLC while `int32`'s (cref:TypeSymbol.ClrType)
/// is always the host process's live `typeof(int)`; mixing them in
/// `MakeGenericType` throws (cref:ArgumentException), which was
/// silently swallowed, leaking the definition's unsubstituted
/// `IEnumerator[T]` into the constructed `ISeq[int32]` shape. The fix
/// projects each substituted CLR type argument into the interface's
/// constructing `mapClrType` reflection context before calling
/// `MakeGenericType`, mirroring `Binder.SubstituteType`.
open class Issue1958InterfaceMemberGenericSubstitutionTests {
    @Fact
    func GenericUserInterface_MemberOverOwnTypeParameter_SubstitutesUnderMetadataLoadContext() {
        // #974 shape: ISeq[T]'s `Iter()` member exposes the constructed CLR
        // generic `IEnumerator[T]` over the interface's own type parameter.
        // Constructing `ISeq[int32]` (via the `use` parameter below) must
        // substitute T -> int32 in that member so `use`'s declared
        // `IEnumerator[int32]` return type matches `s.Iter()`'s actual
        // (substituted) return type. Before the fix, MakeGenericType threw
        // under MLC and silently fell back to the erased `IEnumerator[T]`,
        // which does not convert to `IEnumerator[int32]` and failed binding.
        let source = `package P
import System.Collections.Generic

interface ISeq[T any] {
    func Iter() IEnumerator[T]
}

func use(s ISeq[int32]) IEnumerator[int32] {
    return s.Iter()
}`
        let globalScope = BindWithMlc(source)
        Assert.Empty(globalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func GenericUserInterface_MemberOverOwnTypeParameter_ControlCase_DefaultResolver() {
        // Control case: the same shape must already bind (and keep binding)
        // under the default (non-MLC) reflection context, so the fix does not
        // regress the common single-context compile path.
        let source = `package P
import System.Collections.Generic

interface ISeq[T any] {
    func Iter() IEnumerator[T]
}

func use(s ISeq[int32]) IEnumerator[int32] {
    return s.Iter()
}`
        let globalScope = BindDefault(source)
        Assert.Empty(globalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func InterfaceSymbol_SubstituteType_ProjectsClrArgsAcrossReflectionContexts() {
        // Direct symbol-layer check (issue #1958's minimum bar): constructing
        // ISeq[int32] under a mapClrType-bearing resolver must produce a
        // substituted `Iter()` return type whose ImportedTypeSymbol.TypeArguments
        // is the concrete int32 argument, NOT the still-open T type parameter
        // that a silently-swallowed ArgumentException would have leaked.
        let resolver = MetadataLoadContextResolver()
        let mapClrType Func[Type?, Type?]? = resolver.MapClrTypeToReferences
        let enumeratorOpenDef = resolver.MapClrTypeToReferences(typeof(System.Collections.Generic.IEnumerator[_]))
        let mlcObject = resolver.MapClrTypeToReferences(typeof(object))
        let tp = TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None)
        let erasedMemberType = ImportedTypeSymbol.GetConstructed(
            enumeratorOpenDef.MakeGenericType(mlcObject),
            enumeratorOpenDef,
            ImmutableArray.Create[TypeSymbol](tp)
        )
        let definition = InterfaceSymbol("ISeq", Accessibility.Public, declaration: nil, packageName: "P")
        definition.SetTypeParameters(ImmutableArray.Create(tp))
        let iterMethod = FunctionSymbol(
            "Iter",
            ImmutableArray[ParameterSymbol].Empty,
            erasedMemberType,
            declaration: nil,
            $package: nil,
            accessibility: Accessibility.Public
        )
        definition.SetMethods(ImmutableArray.Create(iterMethod))
        let constructed = InterfaceSymbol.Construct(
            definition,
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32),
            mapClrType
        )
        let substitutedReturn = Assert.IsType[ImportedTypeSymbol](constructed.Methods[0].Type)
        Assert.Same(TypeSymbol.Int32, Assert.Single(substitutedReturn.TypeArguments))
    }

    shared {
        /// Build a (cref:ReferenceResolver) rooted at the BCL reference
        /// assemblies, forcing gsc into the (cref:System.Reflection.MetadataLoadContext)
        /// resolution path — the same path cs2gs and the MSBuild task drive gsc
        /// through — reproducing the cross-reflection-context scenario inside the
        /// unit-test process.
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(Console).Assembly.Location,
                typeof(Enumerable).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        private func BindWithMlc(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree), MetadataLoadContextResolver())
        }

        private func BindDefault(source string) BoundGlobalScope {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
        }
    }
}
