// <copyright file="Issue1358ImportedPointerParameterBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System.Collections
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #1358: imported static methods with unmanaged-pointer parameters must
/// remain in the candidate set and participate in overload resolution.
open class Issue1358ImportedPointerParameterBindingTests {
    @Fact
    func ImportedGenericStaticMethod_WithTypedPointerParameter_Binds() {
        const source = `package P
import System.Runtime.Intrinsics

class C {
    unsafe func G(p *uint8) {
        let v = Vector256.Load(p)
    }
}`
        Assert.Empty(GetErrorDiagnostics(source))
    }

    @Fact
    func ImportedGenericStaticMethod_WithVoidPointerParameter_Binds() {
        const source = `package P
import System.Runtime.CompilerServices

class C {
    unsafe func G(p *uint8) {
        let v = Unsafe.Read[uint8](p)
    }
}`
        Assert.Empty(GetErrorDiagnostics(source))
    }

    private struct DiagnosticCollection : IReadOnlyCollection[Diagnostic] {
        private let diagnostics ImmutableArray[Diagnostic]

        init(diagnostics ImmutableArray[Diagnostic]) {
            this.diagnostics = diagnostics
        }

        prop Count int32 -> this.diagnostics.Length

        func GetEnumerator() IEnumerator[Diagnostic] {
            for diagnostic in this.diagnostics {
                yield diagnostic
            }
        }

        private func (IEnumerable) GetEnumerator() IEnumerator {
            return GetEnumerator()
        }
    }

    shared {
        private func GetErrorDiagnostics(source string) DiagnosticCollection {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let all = tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
            return DiagnosticCollection(all)
        }
    }
}
