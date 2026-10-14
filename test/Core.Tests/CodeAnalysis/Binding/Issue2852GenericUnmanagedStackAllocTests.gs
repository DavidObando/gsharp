// <copyright file="Issue2852GenericUnmanagedStackAllocTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #2852: `stackalloc [n]T` accepts an
/// `unmanaged`-constrained type parameter without admitting type
/// parameters or structs that may contain managed references.
open class Issue2852GenericUnmanagedStackAllocTests {
    @Fact
    func StackAlloc_UnmanagedTypeParameter_Binds() {
        const source = `package p
func F[T unmanaged](value T) T {
    var values = stackalloc [4]T
    values[3] = value
    return values[3]
}`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StackAlloc_StructConstrainedTypeParameter_ReportsGS0399() {
        const source = `package p
func F[T struct]() {
    var values = stackalloc [4]T
}`
        Assert.Contains(GetDiagnostics(source), (d Diagnostic) -> d.Id == "GS0399")
    }

    @Fact
    func StackAlloc_UnconstrainedTypeParameter_ReportsGS0399() {
        const source = `package p
func F[T any]() {
    var values = stackalloc [4]T
}`
        Assert.Contains(GetDiagnostics(source), (d Diagnostic) -> d.Id == "GS0399")
    }

    @Fact
    func StackAlloc_StructContainingReference_ReportsGS0399() {
        const source = `package p
struct Bad {
    var Text string
}
func F() {
    var values = stackalloc [4]Bad
}`
        Assert.Contains(GetDiagnostics(source), (d Diagnostic) -> d.Id == "GS0399")
    }

    @Fact
    func StackAlloc_ImportedStructContainingReference_ReportsGS0399() {
        const source = `package p
import GSharp.Core.Tests.CodeAnalysis.Binding
func F() {
    var values = stackalloc [4]Issue2852ImportedManagedStruct
}`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0399")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func StackAlloc_ImportedNestedStructContainingReference_ReportsGS0399() {
        const source = `package p
import GSharp.Core.Tests.CodeAnalysis.Binding
func F() {
    var values = stackalloc [4]Issue2852ImportedNestedManagedStruct
}`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0399")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func StackAlloc_ImportedRefStruct_ReportsGS0399() {
        const source = `package p
import GSharp.Core.Tests.CodeAnalysis.Binding
func F() {
    var values = stackalloc [4]Issue2852ImportedRefStruct
}`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0399")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func StackAlloc_ImportedNestedUnmanagedStruct_Binds() {
        const source = `package p
import GSharp.Core.Tests.CodeAnalysis.Binding
func F() {
    var values = stackalloc [4]Issue2852ImportedUnmanagedOuter
}`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StackAlloc_ImportedStructContainingPointerAndFunctionPointerFields_Binds() {
        const source = `package p
import GSharp.Core.Tests.CodeAnalysis.Binding
func F() {
    var values = stackalloc [4]Issue2852ImportedPointerFields
}`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func StackAlloc_ImportedStructContainingNullableField_ReportsGS0399() {
        const source = `package p
import GSharp.Core.Tests.CodeAnalysis.Binding
func F() {
    var values = stackalloc [4]Issue2852ImportedNullableFieldStruct
}`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0399")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func StackAlloc_ImportedOpenGenericDefinition_ReportsGS0399() {
        const source = `package definitions
struct Empty[T] {}

package p
import definitions
func F() {
    var values = stackalloc [4]Empty
}`
        let diagnostics = GetDiagnostics(source)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0399")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS9998")
    }

    @Fact
    func Classifier_ImportedGenericParameter_IsNotUnmanaged() {
        let genericParameter = typeof(Issue2852ImportedUnmanagedGenericHost[_]).GetGenericArguments()[0]
        let type = TypeSymbol.FromClrType(genericParameter)
        Assert.False(BlittableDetector().IsUnmanaged(type))
    }

    @Fact
    func Classifier_ImportedOpenGenericDefinition_IsNotUnmanaged() {
        let type = TypeSymbol.FromClrType(typeof(Issue2852ImportedEmptyGenericStruct[_]))
        Assert.False(BlittableDetector().IsUnmanaged(type))
    }

    @Fact
    func Classifier_ClosedImportedGenericStruct_RemainsUnmanaged() {
        let type = TypeSymbol.FromClrType(typeof(Issue2852ImportedEmptyGenericStruct[int32]))
        Assert.True(BlittableDetector().IsUnmanaged(type))
    }

    shared {
        private func GetDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
        }
    }
}

struct Issue2852ImportedManagedStruct {
    prop Text string
}

struct Issue2852ImportedNestedManagedStruct {
    prop Inner Issue2852ImportedManagedStruct
}

ref struct Issue2852ImportedRefStruct {
    prop Values Span[int32]
}

struct Issue2852ImportedUnmanagedInner {
    prop Value int32
}

struct Issue2852ImportedUnmanagedOuter {
    prop Inner Issue2852ImportedUnmanagedInner
}

unsafe struct Issue2852ImportedPointerFields {
    prop Pointer *int32
    prop FunctionPointer unmanaged(int32) -> int32
}

struct Issue2852ImportedNullableFieldStruct {
    prop Value int32?
}

struct Issue2852ImportedEmptyGenericStruct[T] { }

struct Issue2852ImportedUnmanagedGenericHost[T unmanaged] { }
