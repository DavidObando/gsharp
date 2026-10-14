// <copyright file="Issue814OrNilOverloadTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #814 / ADR-0084 §L5 closing bullet — disambiguation of two
/// extension overloads that share a shape-identical receiver type
/// (`(self sequence[T])`) and parameter list, distinguished only
/// by a `class` / `struct` generic-parameter constraint and a
/// return-type representation that bottoms out in `T?`. The
/// canonical surface is (cref:System.Linq)-style
/// `FirstOrNil` / `LastOrNil` / `SingleOrNil`.
open class Issue814OrNilOverloadTests {
    @Fact
    func FirstOrNil_TwoOverloadsCoexist_NoDuplicateDeclarationDiagnostic() {
        // Both overloads must declare cleanly even though their declared
        // receiver shape (`sequence[T]`) is structurally identical — the
        // T in each is a different TypeParameterSymbol with a disjoint
        // constraint, so they are distinct extension entries.
        const source = `
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? { return nil }
func (self sequence[T]) FirstOrNil[T struct]() T? { return nil }
`
        Assert.Empty(GetErrorDiagnostics(source))
    }

    @Fact
    func FirstOrNil_OnStringArray_ResolvesClassOverload() {
        const source = `
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() string { return "class" }
func (self sequence[T]) FirstOrNil[T struct]() string { return "struct" }

let arr = []string{}
let tag = arr.FirstOrNil()
tag
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("class", result.Value)
    }

    @Fact
    func FirstOrNil_OnInt32Array_ResolvesStructOverload() {
        const source = `
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() string { return "class" }
func (self sequence[T]) FirstOrNil[T struct]() string { return "struct" }

let arr = []int32{}
let tag = arr.FirstOrNil()
tag
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("struct", result.Value)
    }

    @Fact
    func FirstOrNil_ReturnTypeIsTQuestion_ResolvesClassOverloadForStrings() {
        // The actual ADR-0084 §L5 shape: return type is `T?`. The class
        // overload returns a reference-typed `T?`; the struct overload
        // returns a `Nullable<T>`. Pre-fix the two overloads were both
        // declared but the binder's tie-break could not pick a winner
        // when the only distinguishing constraint was class/struct on
        // the receiver type-parameter.
        const source = `
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? {
    for v in self { return v }
    return nil
}

func (self sequence[T]) FirstOrNil[T struct]() T? {
    for v in self { return v }
    return nil
}

let strs = []string{ "alpha", "beta" }
let head = strs.FirstOrNil() ?? "<none>"
head
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("alpha", result.Value)
    }

    @Fact
    func FirstOrNil_ReturnTypeIsTQuestion_ResolvesStructOverloadForInt32() {
        const source = `
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? {
    for v in self { return v }
    return nil
}

func (self sequence[T]) FirstOrNil[T struct]() T? {
    for v in self { return v }
    return nil
}

let nums = []int32{ 11, 22, 33 }
let head = nums.FirstOrNil() ?? -1
head
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(11, result.Value)
    }

    @Fact
    func LastOrNil_TwoOverloadsCoexist_AndDispatchByConstraint() {
        const source = `
package P
import System
import System.Collections.Generic

func (self sequence[T]) LastOrNil[T class]() string { return "class" }
func (self sequence[T]) LastOrNil[T struct]() string { return "struct" }

let arr1 = []string{ "a" }
let arr2 = []int32{ 1 }
arr1.LastOrNil() + arr2.LastOrNil()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("classstruct", result.Value)
    }

    @Fact
    func SingleOrNil_TwoOverloadsCoexist_AndDispatchByConstraint() {
        const source = `
package P
import System
import System.Collections.Generic

func (self sequence[T]) SingleOrNil[T class]() string { return "class" }
func (self sequence[T]) SingleOrNil[T struct]() string { return "struct" }

let arr1 = []string{ "a" }
let arr2 = []int32{ 1 }
arr1.SingleOrNil() + arr2.SingleOrNil()
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("classstruct", result.Value)
    }

    @Fact
    func TwoOverloads_OnlyOneMatchesConstraint_PicksUnambiguously() {
        // Only the class overload is declared; calling on an int32
        // array must diagnose because neither candidate satisfies a
        // struct argument.
        const source = `
package P
import System
import System.Collections.Generic

func (self sequence[T]) FirstOrNil[T class]() T? {
    for v in self { return v }
    return nil
}

let nums = []int32{ 1, 2, 3 }
let head = nums.FirstOrNil()
head
`
        // The lookup falls through; the call site should fail to resolve.
        let diags = GetErrorDiagnostics(source)
        Assert.NotEmpty(diags)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func GetErrorDiagnostics(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let program = compilation.BoundProgram
            return tree
                .Diagnostics
                .Concat(compilation.GlobalScope.Diagnostics)
                .Concat(program.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .ToImmutableArray()
        }
    }
}
