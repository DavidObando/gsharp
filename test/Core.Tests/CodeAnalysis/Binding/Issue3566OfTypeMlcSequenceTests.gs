// <copyright file="Issue3566OfTypeMlcSequenceTests.cs" company="GSharp">
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

/// Issue #3566: `xs.OfType[U]()` / `xs.Cast[U]()` on a
/// `sequence[T]` receiver whose element type resolves through a
/// (cref:System.Reflection.MetadataLoadContext) reported GS0159.
/// The extensions' self-parameter is the NON-generic
/// `System.Collections.IEnumerable`, and `sequence[T]`'s CLR type
/// is the runtime `IEnumerable<>` closed over the MLC element — a
/// hybrid constructed type whose interface set the cross-context by-name
/// walk cannot read. The conversion classifier now answers semantically:
/// an `IEnumerable<T>` shape implements non-generic
/// `IEnumerable` by definition.
open class Issue3566OfTypeMlcSequenceTests {
    @Fact
    func OfType_OnSequenceOfMlcElement_Binds() {
        let source = `package Repro
import System
import System.Linq

func CountVersions(xs sequence[Version]) int32 {
    return xs.OfType[Version]().Count()
}`
        let diagnostics = BindWithMlc(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func Cast_OnSequenceOfMlcElement_Binds() {
        let source = `package Repro
import System
import System.Linq

func AsObjects(xs sequence[Version]) sequence[object] {
    return xs.Cast[object]()
}`
        let diagnostics = BindWithMlc(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func SequenceConvertsToNonGenericIEnumerable() {
        // IEnumerable<T> implements the non-generic IEnumerable by
        // definition — the direct upcast the new classifier arm answers.
        // (The arm itself gates on the IEnumerable`1 shape so async
        // sequences never enter it; their conversion behavior is governed
        // by pre-existing rules.)
        let source = `package Repro
import System
import System.Collections

func Sync(xs sequence[Version]) IEnumerable {
    return xs
}`
        Assert.DoesNotContain(BindWithMlc(source), (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    shared {
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

        private func BindWithMlc(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let globalScope = Binder.BindGlobalScope(
                previous: nil,
                ImmutableArray.Create(tree),
                MetadataLoadContextResolver()
            )
            return globalScope.Diagnostics
        }
    }
}
