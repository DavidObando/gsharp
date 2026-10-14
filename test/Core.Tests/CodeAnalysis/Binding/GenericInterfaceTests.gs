// <copyright file="GenericInterfaceTests.cs" company="GSharp">
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

/// Phase 4.3c / ADR-0020 — generic `interface` declarations with optional
/// variance modifiers (ADR-0021). Verifies that generic interfaces parse,
/// bind, can be referenced as constructed types `Foo[int]` in type
/// position, and that variance position violations are reported.
open class GenericInterfaceTests {
    @Fact
    func GenericInterfaceDeclaration_Binds() {
        let source = `
interface Iter[T any] {
    func Next() T;
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func ConstructedInterface_AsParameterType_Binds() {
        let source = `
interface Iter[T any] {
    func Next() T;
}

func consume(it Iter[int32]) int32 {
    return it.Next()
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func VarianceOut_OnReturn_OK() {
        let source = `
interface Producer[out T] {
    func Get() T;
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func VarianceIn_OnParam_OK() {
        let source = `
interface Consumer[in T] {
    func Put(v T);
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func VarianceOut_InParamPosition_Diagnoses() {
        let source = `
interface Bad[out T] {
    func Take(v T);
}
`
        let result = Evaluate(source)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("'out'") && d.Message.Contains("input")
        )
    }

    @Fact
    func VarianceIn_InReturnPosition_Diagnoses() {
        let source = `
interface Bad[in T] {
    func Get() T;
}
`
        let result = Evaluate(source)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("'in'") && d.Message.Contains("output")
        )
    }

    @Fact
    func ConstructedInterface_WrongArity_Diagnoses() {
        let source = `
interface Iter[T any] {
    func Next() T;
}

func consume(it Iter[int32, string]) int32 { return 0 }
`
        let result = Evaluate(source)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Message.Contains("requires") || d.Message.Contains("type argument")
        )
    }

    @Fact
    func SealedGenericInterface_Binds() {
        let source = `
sealed interface Result[T any] {
    func Get() T;
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
