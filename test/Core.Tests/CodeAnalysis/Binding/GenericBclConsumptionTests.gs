// <copyright file="GenericBclConsumptionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Linq
import Xunit

/// Phase 4.4 — generic BCL consumption. Users write
/// `List[int]` / `Dictionary[string, int]` in type position and the
/// binder constructs the closed CLR generic type via
/// (cref:System.Type.MakeGenericType).
open class GenericBclConsumptionTests {
    @Fact
    func ListIntInParameterType_Binds() {
        let source = `
import System.Collections.Generic

func consume(xs List[int32]) int32 {
    return 0
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func DictionaryStringIntInParameterType_Binds() {
        let source = `
import System.Collections.Generic

func consume(d Dictionary[string, int32]) int32 {
    return 0
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func GenericTypeWrongArity_FallsThroughAndDiagnoses() {
        let source = `
import System.Collections.Generic

func consume(xs List[int32, string]) int32 {
    return 0
}
`
        let result = Evaluate(source)
        Assert.NotEmpty(result.Diagnostics)
    }

    @Fact
    func TypeParameterAsTypeArgument_InParameterType_Binds() {
        // Issue #313: an in-scope generic type parameter used as a type
        // argument to a generic type (e.g. `List[T]`) must bind, including
        // element access in the body, instead of reporting `GS0149`.
        let source = `
import System.Collections.Generic

func First[T](items List[T]) T {
    return items[0]
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TypeParameterAsTypeArgument_InReturnType_Binds() {
        // Issue #313: type parameter as a type argument in the return position.
        let source = `
import System.Collections.Generic

func Echo[T](items List[T]) List[T] {
    return items
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TypeParameterAsTypeArgument_InLocalVariableType_Binds() {
        // Issue #313: type parameter as a type argument in a local declaration.
        let source = `
import System.Collections.Generic

func PassThrough[T](items List[T]) List[T] {
    var local List[T] = items
    return local
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func TypeParameterAsTypeArgument_Nested_Binds() {
        // Issue #313: type parameter nested inside another generic type
        // argument (`List[Dictionary[string, T]]`).
        let source = `
import System.Collections.Generic

func FirstValue[T](rows List[Dictionary[string, T]]) T {
    var head = rows[0]
    return head["key"]
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    shared {
        private func Evaluate(source string) EmittedOracleResult {
            return EmittedOracle.Evaluate(source)
        }
    }
}
