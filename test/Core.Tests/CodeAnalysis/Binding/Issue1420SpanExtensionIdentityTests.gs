// <copyright file="Issue1420SpanExtensionIdentityTests.cs" company="GSharp">
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
import System.Runtime.InteropServices
import Xunit

/// Regression tests for issue #1420: a generic extension declared on a
/// `ref struct` receiver (`func (ints Span[T]) AllLE[...](...)`) must
/// bind against a `Span<int>` produced by a BCL signature
/// (`CollectionsMarshal.AsSpan(List[int32])`).
///
/// The BCL signature surfaces the element type as the metadata
/// `System.Int32` while the substituted extension receiver carries the G#
/// primitive alias `int32`. Substitution cannot rebuild the real closed
/// CLR `Span<int>` (the alias holds the runtime `System.Int32`
/// whereas `Span<>` came from a MetadataLoadContext, and mixing the
/// two throws), so the substituted receiver stays symbolic. Conversion identity
/// must normalize the two element representations onto the SAME
/// (cref:TypeSymbol) so the receiver binds instead of failing GS0155.
open class Issue1420SpanExtensionIdentityTests {
    @Fact
    func SpanGenericExtension_BindsAgainstAsSpanResult() {
        let source = `package App
import System
import System.Collections.Generic
import System.Runtime.InteropServices

func (ints Span[T]) AllLE[T IComparable[T] unmanaged](value T) bool -> true

func F(list List[int32]) {
    let sp = CollectionsMarshal.AsSpan(list)
    let b = sp.AllLE(int32(5))
}`
        Assert.Empty(Bind(source))
    }

    @Fact
    func SpanWrongElement_StillReportsConversionError() {
        // The BCL Span<long> from AsSpan(List[int64]) must NOT unify with the
        // explicit Span[int32] parameter — the identity normalization is by
        // element type, not blanket acceptance of any Span instantiation.
        let source = `package App
import System
import System.Collections.Generic
import System.Runtime.InteropServices

func G(s Span[int32]) int32 -> 0

func F(list List[int64]) {
    let sp = CollectionsMarshal.AsSpan(list)
    let r = G(sp)
}`
        Assert.NotEmpty(Bind(source))
    }

    shared {
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(CollectionsMarshal).Assembly.Location,
                typeof(System.IComparable[_]).Assembly.Location
            }
                .Where((p string) -> !string.IsNullOrEmpty(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
            return ReferenceResolver.WithReferences(paths)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                MetadataLoadContextResolver()
            )
            let program = Binder.BindProgram(globalScope, MetadataLoadContextResolver())
            return globalScope.Diagnostics.AddRange(program.Diagnostics)
        }
    }
}
