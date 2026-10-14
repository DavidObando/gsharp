// <copyright file="Issue2114RangeSliceMlcTests.cs" company="GSharp">
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

/// Regression tests for issue #2114: binding a range-slice expression
/// `expr[a..b]` against a sliceable BCL type (e.g. `Span` /
/// `ReadOnlySpan`) must not crash when the receiver type is resolved
/// through a (cref:System.Reflection.MetadataLoadContext) (the
/// `/reference:` resolver path used by the BuildTask and cs2gs migrate).
///
/// The slice-shape probe in `ExpressionBinder.TryFindSliceShape` previously
/// called `clrType.GetMethod("Slice", …, new[] { typeof(int), typeof(int) }, …)`.
/// When `clrType` is an MLC `RoType`, comparing its candidate parameter
/// types against the host's runtime `typeof(int)` made
/// `DefaultBinder.SelectMethod` throw
/// `ArgumentException: Type must be a type provided by the MetadataLoadContext`,
/// surfaced as a `GS9998` ICE. The probe now enumerates candidates and
/// compares parameter types with `IsSameAs`, which works across reflection
/// contexts.
open class Issue2114RangeSliceMlcTests {
    @Fact
    func RangeSlice_OnReadOnlySpan_UnderMlc_DoesNotCrash() {
        let source = `package Repro
import System

func TakeTail(s ReadOnlySpan[int64]) ReadOnlySpan[int64] {
    return s[2..]
}`
        // Pre-fix this threw ArgumentException from the binder (GS9998 ICE).
        let diagnostics = BindWithMlc(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    @Fact
    func RangeSlice_OnSpan_WithBounds_UnderMlc_DoesNotCrash() {
        let source = `package Repro
import System

func Middle(s Span[uint8]) Span[uint8] {
    return s[1..3]
}`
        let diagnostics = BindWithMlc(source)
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Severity == DiagnosticSeverity.Error)
    }

    shared {
        /// Build a (cref:ReferenceResolver) rooted at BCL reference
        /// assemblies. Supplying explicit paths forces gsc into the
        /// (cref:System.Reflection.MetadataLoadContext) resolution path,
        /// reproducing the BuildTask / migrate scenario inside the test process.
        private func MetadataLoadContextResolver() ReferenceResolver {
            let paths = []string{
                typeof(object).Assembly.Location,
                typeof(System.Collections.Generic.List[_]).Assembly.Location,
                typeof(System.ReadOnlySpan[_]).Assembly.Location,
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
