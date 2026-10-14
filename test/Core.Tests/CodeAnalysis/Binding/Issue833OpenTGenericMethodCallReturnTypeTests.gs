// <copyright file="Issue833OpenTGenericMethodCallReturnTypeTests.cs" company="GSharp">
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

/// Issue #833 (sibling to #794). When a generic method (top-level
/// `func`, generic shared method on a class, or generic extension
/// method) calls an imported CLR generic method whose type argument
/// is the in-scope method's own type parameter (e.g.
/// `Enumerable.Empty[T]()`, `[]T{}.ToArray()`,
/// `Array.Empty[T]()`), the call's bound return type must
/// preserve the symbolic `T` — not the CLR-erased `object`.
/// - `Enumerable.Empty[T]()` → `IEnumerable[T]` (was `IEnumerable[object]`)
/// - `Array.Empty[T]()` → `[]T` (was `[]object`)
/// - `[]T{}.ToArray()` → `[]T` (was `[]object`)
/// - `Enumerable.Repeat[T](v, n)` → `IEnumerable[T]`
/// Pre-fix the binder closed the static generic method against
/// `object` (because `T` has no reference-context CLR type),
/// so (cref:System.Reflection.MethodInfo.ReturnType) surfaced as
/// the erased projection. That then failed conversion to the declared
/// `IEnumerable[T]` / `[]T`.
open class Issue833OpenTGenericMethodCallReturnTypeTests {
    @Fact
    func EnumerableEmpty_With_OpenT_Returns_SymbolicIEnumerableT() {
        const source = `
package Repro
import System
import System.Linq
import System.Collections.Generic

class Sequences {
    shared {
        func Empty[T]() IEnumerable[T] {
            return Enumerable.Empty[T]()
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ArrayEmpty_With_OpenT_Returns_SymbolicSliceT() {
        const source = `
package P
import System

class Sequences {
    shared {
        func Empty[T]() []T {
            return Array.Empty[T]()
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func ToArray_On_OpenT_Slice_Returns_SymbolicSliceT() {
        const source = `
package P
import System
import System.Linq

class Sequences {
    shared {
        func MakeEmpty[T]() []T {
            return []T{}.ToArray()
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func EnumerableRepeat_With_OpenT_Returns_SymbolicIEnumerableT() {
        const source = `
package P
import System
import System.Linq
import System.Collections.Generic

class Sequences {
    shared {
        func Three[T](v T) IEnumerable[T] {
            return Enumerable.Repeat[T](v, 3)
        }
    }
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Inside_TopLevel_Generic_Func_EnumerableEmpty_Threads_T() {
        const source = `
package P
import System
import System.Linq
import System.Collections.Generic

func Empty[T]() IEnumerable[T] {
    return Enumerable.Empty[T]()
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func Inside_Generic_Extension_Method_ToArray_Threads_T() {
        const source = `
package P
import System
import System.Linq
import System.Collections.Generic

func (self []T) MakeEmptyLike[T]() []T {
    return Array.Empty[T]()
}
`
        Assert.Empty(GetDiagnostics(source))
    }

    @Fact
    func EnumerableEmpty_Bound_Return_Type_Is_SymbolicIEnumerableT() {
        // Walk the bound tree to confirm the call's bound return type
        // is `IEnumerable[T]` over the function's type parameter — not
        // the erased `IEnumerable[object]`.
        const source = `
package P
import System
import System.Linq
import System.Collections.Generic

func Empty[T]() IEnumerable[T] {
    return Enumerable.Empty[T]()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "Empty")
        let body = compilation.BoundProgram.Functions[fn]
        let imps = Issue833OpenTGenericMethodCallReturnTypeTests.TypeCollector[ImportedTypeSymbol]()
        imps.Visit(body)
        Assert.Contains(
            imps.Collected,
            (t ImportedTypeSymbol) -> !t.TypeArguments.IsDefaultOrEmpty && t.TypeArguments.Any(
                (a TypeSymbol) -> a is TypeParameterSymbol tp && tp.Name == "T"
            )
        )
    }

    @Fact
    func ArrayEmpty_Bound_Return_Type_Is_SliceOfT() {
        const source = `
package P
import System

func Empty[T]() []T {
    return Array.Empty[T]()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "Empty")
        let body = compilation.BoundProgram.Functions[fn]
        let slices = Issue833OpenTGenericMethodCallReturnTypeTests.TypeCollector[SliceTypeSymbol]()
        slices.Visit(body)
        Assert.Contains(
            slices.Collected,
            (s SliceTypeSymbol) -> s.ElementType is TypeParameterSymbol tp && tp.Name == "T"
        )
    }

    @Fact
    func ToArray_On_SliceOfT_Bound_Return_Type_Is_SliceOfT() {
        const source = `
package P
import System
import System.Linq

func MakeEmpty[T]() []T {
    return []T{}.ToArray()
}
`
        let compilation = Compile(source)
        Assert.Empty(compilation.GlobalScope.Diagnostics)
        let fn = compilation.BoundProgram.Functions.Keys.Single((f FunctionSymbol) -> f.Name == "MakeEmpty")
        let body = compilation.BoundProgram.Functions[fn]
        let slices = Issue833OpenTGenericMethodCallReturnTypeTests.TypeCollector[SliceTypeSymbol]()
        slices.Visit(body)
        Assert.Contains(
            slices.Collected,
            (s SliceTypeSymbol) -> s.ElementType is TypeParameterSymbol tp && tp.Name == "T"
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
