// <copyright file="Issue819PrimaryCtorVariadicTests.cs" company="GSharp">
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

/// Issue #819 / ADR-0102 follow-up — primary-constructor parameter lists
/// (ADR-0078) accept a trailing variadic `name ...T`. The variadic
/// parameter promotes to a `[]T` auto-field of the same name; at call
/// sites trailing positional arguments are packed into a fresh `[]T`
/// (or forwarded unwrapped when the caller supplies a single `[]T`).
open class Issue819PrimaryCtorVariadicTests {
    // ----- Parser-level acceptance (ADR-0078 spelling matrix) -----
    @Theory
    @InlineData("class Tags(name string, tags ...string) { }")
    @InlineData("open class Tags(name string, tags ...string) { }")
    @InlineData("data class Person(name string, hobbies ...string) { }")
    @InlineData("data struct Point(x int32, ys ...int32) { }")
    @InlineData("struct Tags(name string, tags ...string) { }")
    @InlineData("inline struct Ids(values ...int32) { }")
    func PrimaryCtorVariadic_OnAllSites_ParsesAndBinds(declaration string) {
        let diagnostics = Bind("package P\n" + declaration + "\n")
        Assert.DoesNotContain(diagnostics, (d Diagnostic) -> d.Id == "GS0145" || d.Id == "GS0364" || d.Id == "GS0146")
    }

    // ----- Binder structural rules (GS0145, GS0364) -----
    @Fact
    func PrimaryCtorVariadic_NotLast_ReportsGS0145() {
        let diagnostics = Bind(`
package P
class Bad(xs ...int32, n int32) { }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0145")
    }

    @Fact
    func PrimaryCtorVariadic_MultipleVariadic_ReportsGS0364() {
        let diagnostics = Bind(`
package P
class Bad(xs ...int32, ys ...int32) { }
`)
        Assert.Contains(diagnostics, (d Diagnostic) -> d.Id == "GS0364")
    }

    // ----- Field promotion shape -----
    @Fact
    func PrimaryCtorVariadic_AutoFieldType_IsSliceOfElementType() {
        let (compilation, _) = Compile(`
package P
class Tags(name string, tags ...string) { }
`)
        let tagsType = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Tags")
        Assert.True(tagsType.TryGetField("tags", out var tagsField))
        Assert.IsType[SliceTypeSymbol](tagsField.Type)
        let slice = cast[SliceTypeSymbol](tagsField.Type)
        Assert.Same(TypeSymbol.String, slice.ElementType)
        let primaryParams = tagsType.PrimaryConstructorParameters
        let last = primaryParams[primaryParams.Length - 1]
        Assert.Equal("tags", last.Name)
        Assert.True(last.IsVariadic)
        Assert.IsType[SliceTypeSymbol](last.Type)
    }

    // ----- Call-site binding semantics -----
    @Fact
    func PrimaryCtorVariadic_PacksTrailingArgs() {
        let result = Evaluate(`
class Tags(name string, tags ...string) { }
let t = Tags("project", "a", "b", "c")
t.tags.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(3, result.Value)
    }

    @Fact
    func PrimaryCtorVariadic_EmptyTrailing_ProducesEmptySlice() {
        let result = Evaluate(`
class Tags(name string, tags ...string) { }
let t = Tags("project")
t.tags.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func PrimaryCtorVariadic_SingleSliceArg_PassesThrough() {
        let result = Evaluate(`
class Tags(name string, tags ...string) { }
let arr = []string{"x", "y"}
let t = Tags("pass", arr)
t.tags.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func PrimaryCtorVariadic_PassThrough_PreservesIdentity() {
        // Pass-through: the field's array is the same reference as the
        // caller-supplied array — mutating one is visible on the other.
        let result = Evaluate(`
class Tags(name string, tags ...string) { }
let arr = []string{"one", "two"}
let t = Tags("x", arr)
arr[0] = "ONE"
t.tags[0]
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("ONE", result.Value)
    }

    @Fact
    func PrimaryCtorVariadic_OnlyVariadicParam_PacksAll() {
        let result = Evaluate(`
class Words(values ...string) { }
let w = Words("a", "b", "c", "d")
w.values.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
    }

    @Fact
    func PrimaryCtorVariadic_OnlyVariadicParam_EmptyCall() {
        let result = Evaluate(`
class Words(values ...string) { }
let w = Words()
w.values.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func PrimaryCtorVariadic_OnGenericClass_InfersElementType() {
        let result = Evaluate(`
class Box[T](first T, rest ...T) { }
let b = Box(10, 20, 30)
b.rest.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func PrimaryCtorVariadic_OnGenericClass_EmptyPack_NeedsExplicitTypeArg() {
        let result = Evaluate(`
class Box[T](first T, rest ...T) { }
let b = Box[int32](5)
b.rest.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(0, result.Value)
    }

    @Fact
    func PrimaryCtorVariadic_OnGenericClass_SinglePassThrough_InfersFromSlice() {
        let result = Evaluate(`
class Box[T](first T, rest ...T) { }
let arr = []int32{100, 200}
let b = Box(7, arr)
b.rest.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func PrimaryCtorVariadic_TooFewFixedArgs_ReportsDiagnostic() {
        let result = Evaluate(`
class TwoFixedAndVariadic(a int32, b int32, rest ...int32) { }
let x = TwoFixedAndVariadic(1)
0
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func PrimaryCtorVariadic_WrongElementType_ReportsDiagnostic() {
        let result = Evaluate(`
class Nums(values ...int32) { }
let x = Nums(1, "x", 3)
0
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func PrimaryCtorVariadic_OnDataClass_PacksAndComparesByReference() {
        let result = Evaluate(`
data class Person(name string, hobbies ...string) { }
let p = Person("Alice", "reading", "hiking")
p.hobbies.Length
`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(2, result.Value)
    }

    @Fact
    func PrimaryCtorVariadic_OnInlineStruct_PromotesSliceField() {
        let (compilation, _) = Compile(`
package P
inline struct Ids(values ...int32) { }
`)
        let idsType = compilation.GlobalScope.Structs.Single((s StructSymbol) -> s.Name == "Ids")
        Assert.True(idsType.TryGetField("values", out var valuesField))
        Assert.IsType[SliceTypeSymbol](valuesField.Type)
    }

    @Fact
    func PrimaryCtorVariadic_NamedArguments_Rejected() {
        // Named arguments are not legal at a variadic primary-ctor call site
        // (the trailing slot consumes any number of positional arguments).
        let result = Evaluate(`
class Tags(name string, tags ...string) { }
let t = Tags(name: "a", tags: "b")
0
`)
        Assert.NotEmpty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }

        private func Bind(source string) ImmutableArray[Diagnostic] {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            if tree.Diagnostics.Any() {
                return tree.Diagnostics
            }
            let globalScope = Binder.BindGlobalScope(previous: nil, ImmutableArray.Create(tree))
            if globalScope.Diagnostics.Any() {
                return globalScope.Diagnostics
            }
            let program = Binder.BindProgram(globalScope)
            return program.Diagnostics
        }

        private func Compile(source string)(compilation Compilation, diagnostics ImmutableArray[Diagnostic]) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let diagnostics = compilation.GlobalScope.Diagnostics
            return (compilation, diagnostics)
        }
    }
}
