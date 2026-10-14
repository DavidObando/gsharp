// <copyright file="Issue1926ReceiverInterfaceConversionTests.cs" company="GSharp">
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

/// Regression tests for issue #1926: a receiver-clause (extension) function
/// declared over a constructed generic CLR/user interface (e.g.
/// `func (values IReadOnlyList[T]) …`) must accept a call-site receiver
/// whose static type is a concrete class implementing that interface (e.g.
/// `List[T]` implements `IReadOnlyList[T]`) instead of failing with
/// GS0155.
/// @remarks Root cause: `Binder.SubstituteType` closes a generic receiver-clause's
/// declared type (e.g. `IReadOnlyList[T]`) over its inferred type
/// argument by calling (cref:Type.MakeGenericType(Type[])) on the
/// interface's open generic definition with the substituted argument's raw
/// (cref:TypeSymbol.ClrType). Well-known primitive
/// (cref:TypeSymbol)s ((cref:TypeSymbol.Int32), etc.) always
/// carry the host process's live `typeof(int)` — but when `gsc` is
/// driven with an explicit `/r:` reference set (as the cs2gs migration
/// pipeline and MSBuild task both do), the receiver-clause's own declared
/// type was resolved through an isolated
/// (cref:System.Reflection.MetadataLoadContext). Mixing a live and an
/// MLC-resolved (cref:Type) in `MakeGenericType` throws
/// (cref:ArgumentException), which was silently swallowed and fell
/// back to an ERASED `IReadOnlyList<object>` receiver type — a type
/// that `List<int>` does NOT implicitly convert to, so the call
/// site failed GS0155 even though `List<int>` genuinely implements
/// `IReadOnlyList<int>`. The fix projects every substituted type
/// argument's CLR type into the SAME reflection context as the declared
/// receiver's open generic definition (mirroring the existing
/// `ReferenceResolver.MapClrTypeToReferences` pattern used throughout the
/// rest of the binder) before calling `MakeGenericType`.
open class Issue1926ReceiverInterfaceConversionTests {
    @Fact
    func GenericExtension_OverClrInterfaceReceiver_AcceptsImplementingClass_UnderMetadataLoadContext() {
        // Grid G13's ExtensionMethodsGeneric.MiddleElement<T>(this IReadOnlyList<T>)
        // translated shape: a generic receiver-clause function whose receiver
        // is the constructed generic CLR interface `IReadOnlyList[T]`, called
        // on a `List[int32]` receiver.
        let source = `package P
import System
import System.Collections.Generic

func (items IReadOnlyList[T]) MiddleElement[T]() T {
    return items[items.Count / 2]
}

var numbers = List[int32]{ 1, 2, 3, 4, 5, 6, 7 }
numbers.MiddleElement()`
        let globalScope = BindWithMlc(source)
        Assert.Empty(globalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func GenericExtension_OverClrDictionaryInterfaceReceiver_AcceptsImplementingClass_UnderMetadataLoadContext() {
        // #1926 must generalize beyond List -> IReadOnlyList: any CLR class
        // implementing any constructed generic interface (here
        // Dictionary[K, V] -> IReadOnlyDictionary[K, V]).
        let source = `package P
import System
import System.Collections.Generic

func (entries IReadOnlyDictionary[K, V]) CountEntries[K, V]() int32 {
    return entries.Count
}

var scores = Dictionary[string, int32]{ "alice": 90, "bob": 85 }
scores.CountEntries()`
        let globalScope = BindWithMlc(source)
        Assert.Empty(globalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func GenericExtension_OverClrInterfaceReceiver_AcceptsImplementingClass_ReferenceTypeArgument_UnderMetadataLoadContext() {
        // Generality check: the fix must not be narrowly special-cased to a
        // single element type. Exercises a reference-type (string) type
        // argument alongside the value-type (int32) case in the first test,
        // covering both MakeGenericType argument shapes.
        let source = `package P
import System
import System.Collections.Generic

func (items IReadOnlyList[T]) MiddleElement[T]() T {
    return items[items.Count / 2]
}

var words = List[string]{ "alpha", "beta", "gamma" }
words.MiddleElement()`
        let globalScope = BindWithMlc(source)
        Assert.Empty(globalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    @Fact
    func GenericExtension_OverClrInterfaceReceiver_AcceptsImplementingClass_ControlCase_DefaultResolver() {
        // Control case: the same call site must already bind (and keep
        // binding) under the default (non-MLC) reflection context, so the fix
        // does not regress the common single-context compile path.
        let source = `package P
import System
import System.Collections.Generic

func (items IReadOnlyList[T]) MiddleElement[T]() T {
    return items[items.Count / 2]
}

var numbers = List[int32]{ 1, 2, 3, 4, 5, 6, 7 }
numbers.MiddleElement()`
        let globalScope = BindDefault(source)
        Assert.Empty(globalScope.Diagnostics.Where((d Diagnostic) -> d.IsError))
    }

    shared {
        /// Build a (cref:ReferenceResolver) rooted at the BCL reference
        /// assemblies. Supplying explicit paths forces gsc into the
        /// (cref:System.Reflection.MetadataLoadContext) resolution path —
        /// the same path the cs2gs migration pipeline and the MSBuild task drive
        /// gsc through — reproducing the cross-reflection-context scenario inside
        /// the unit-test process.
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
