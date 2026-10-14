// <copyright file="Issue794GenericInstanceCallReturnTypeTests.cs" company="GSharp">
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
import System.Linq
import Xunit

/// Issue #794 / ADR-0084 §L5 follow-up. When a generic method (top-level
/// `func`, generic shared method on a class, or generic extension
/// method) instantiates an imported CLR generic over its own in-scope
/// type parameter (e.g. `List[T]()`), every subsequent instance
/// call or property access on that receiver must thread the symbolic
/// type argument back through the member's return / parameter signature:
/// - `List[T]().ToArray()` → `[]T` (was `object[]`)
/// - `List[T]().Add(v)` binds when `v` is typed `T`
/// - `List[T]().Count` → `int32`
/// - `Dictionary[K, V]().Keys` → `ICollection[K]`
/// Pre-fix the binder used (cref:System.Type)-driven reflection
/// on the receiver's type-erased closed CLR shape
/// (`List<object>`) and surfaced the return / property type
/// as the erased projection, which then failed conversion to the
/// declared `[]T` / `K` / `ICollection[K]`.
open class Issue794GenericInstanceCallReturnTypeTests {
    @Fact
    func Repro_From_Issue_ListT_ToArray_Inside_Generic_Shared_Returns_SliceOfT() {
        // Verbatim issue repro (sans the `default` literal, tracked
        // separately). Pre-fix: `GS0155: Cannot convert type
        // 'System.Object[]' to '[]T'.`
        const source = `
package Repro
import System
import System.Collections.Generic

class Sequences {
    shared {
        func MakeList[T any]() []T {
            var list = List[T]()
            return list.ToArray()
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ListT_Count_Returns_Int32_Inside_Generic_Shared() {
        const source = `
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Make[T any]() int32 {
            var list = List[T]()
            return list.Count
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ListT_Add_Accepts_TypeParameter_Argument_Inside_Generic_Shared() {
        const source = `
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func Make[T any](v T) int32 {
            var list = List[T]()
            list.Add(v)
            return list.Count
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func DictionaryKV_Keys_Returns_GenericKeyCollection_Inside_Generic_Shared() {
        // The for-in iteration variable `k` must surface as the
        // receiver's symbolic `K` (not the erased `object`) so the
        // return-as-`K` unifies. The fix substitutes the `Keys`
        // property type (`ICollection<TKey>`) through the receiver's
        // TypeArguments.
        const source = `
package P
import System
import System.Collections.Generic

class Sequences {
    shared {
        func FirstKey[K any, V any](fb K) K {
            var dict = Dictionary[K, V]()
            for k in dict.Keys {
                return k
            }
            return fb
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Inside_TopLevel_Generic_Func_ToArray_Threads_T() {
        // Identical shape to the issue repro but inside a top-level
        // generic `func` rather than a shared method on a class.
        const source = `
package P
import System
import System.Collections.Generic

func MakeList[T any]() []T {
    var list = List[T]()
    return list.ToArray()
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Inside_Generic_Extension_Method_ToArray_Threads_T() {
        // Cross-check with the #773 receiver-clause fix: an extension
        // method with a generic receiver must also thread its own type
        // parameter through subsequent instance calls on a CLR generic.
        const source = `
package P
import System
import System.Collections.Generic

func (self []T) DuplicateInto[T]() []T {
    var list = List[T]()
    for v in self {
        list.Add(v)
        list.Add(v)
    }
    return list.ToArray()
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ListT_ToArray_Bound_Return_Type_Is_SliceOfT() {
        // Walk the bound tree to confirm the call's bound return type
        // is `[]T` over the function's type parameter — not the erased
        // `[]object`.
        const source = `
package P
import System
import System.Collections.Generic

func MakeList[T any]() []T {
    var list = List[T]()
    return list.ToArray()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "MakeList")
        let body = compilation.BoundProgram.Functions[fn]
        let slices = Issue794GenericInstanceCallReturnTypeTests.TypeCollector[SliceTypeSymbol]()
        slices.Visit(body)
        Assert.Contains(
            slices.Collected,
            (s SliceTypeSymbol) -> s.ElementType is TypeParameterSymbol tp && tp.Name == "T"
        )
    }

    @Fact
    func DictionaryKV_Keys_Bound_Type_Carries_Symbolic_K() {
        const source = `
package P
import System
import System.Collections.Generic

func MakeKeys[K any, V any]() {
    var dict = Dictionary[K, V]()
    var keys = dict.Keys
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "MakeKeys")
        let body = compilation.BoundProgram.Functions[fn]
        let imps = Issue794GenericInstanceCallReturnTypeTests.TypeCollector[ImportedTypeSymbol]()
        imps.Visit(body)
        Assert.Contains(
            imps.Collected,
            (t ImportedTypeSymbol) -> !t.TypeArguments.IsDefaultOrEmpty && t.TypeArguments.Any(
                (a TypeSymbol) -> a is TypeParameterSymbol tp && tp.Name == "K"
            )
        )
    }

    private class TypeCollector[T TypeSymbol] : BoundTreeWalker {
        init() {
            Collected = List[T]()
        }

        prop Collected List[T] {
            get;
        }

        override func VisitExpression(node BoundExpression?) {
            if node?.Type is T match {
                Collected.Add(match)
            }
            base.VisitExpression(node)
        }
    }

    shared {
        private func GetDiagnostics(source string) IReadOnlyList[Diagnostic] {
            let result = EmittedOracle.Evaluate(source)
            return result.Diagnostics
        }

        private func Compile(source string) Compilation {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            return Compilation(tree){IsLibrary = true}
        }
    }
}
