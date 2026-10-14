// <copyright file="Issue2193ExtensionOverloadShadowTests.cs" company="GSharp">
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

/// Issue #2193. A user-defined extension function that shares a name with an
/// instance method on a BCL/imported receiver type must participate in overload
/// resolution alongside the instance method. The best type-compatible candidate
/// must win: when the BCL instance method is not applicable (or is a worse
/// match) the user extension must be selected instead of resolving to the
/// incompatible instance method.
open class Issue2193ExtensionOverloadShadowTests {
    @Fact
    func UserExtension_Chosen_Over_NonMatching_BclInstanceMethod_ExplicitTypeArgs() {
        // SynchronizationContext.Send(SendOrPostCallback, object) returns void
        // and shadows the user extension Send[T, TResult]((T) -> TResult, T)
        // TResult. The extension is the correct (and only type-compatible)
        // match, so the call must return TResult and compile clean.
        const source = `
package Repro
import System.Threading

func (ctx SynchronizationContext) Send[T, TResult](delgat (T) -> TResult, p T) TResult -> delgat(p)

class Wrap {
    private let sync SynchronizationContext?
    init(s SynchronizationContext?) { this.sync = s }
    func Call[T, TResult](delgat (T) -> TResult, p T) TResult {
        return sync!!.Send[T, TResult](delgat, p)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func UserExtension_Chosen_Over_NonMatching_BclInstanceMethod_InferredTypeArgs() {
        const source = `
package Repro
import System.Threading

func (ctx SynchronizationContext) Send[T, TResult](delgat (T) -> TResult, p T) TResult -> delgat(p)

class Wrap {
    private let sync SynchronizationContext?
    init(s SynchronizationContext?) { this.sync = s }
    func Call[T, TResult](delgat (T) -> TResult, p T) TResult {
        return sync!!.Send(delgat, p)
    }
}
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
    }

    @Fact
    func SameNamedInstanceMethod_ThatIsBetterMatch_StillWins_NoRegression() {
        // Guard: both a genuine string instance method StartsWith(string) and a
        // same-named user extension StartsWith(string) are applicable. The
        // instance method is an identity (exact) match, so it must still win —
        // the extension (which would return false) must NOT shadow it.
        const source = `
import System

func (s string) StartsWith(prefix string) bool {
    return false
}

var text = "hello world"
text.StartsWith("hello")
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(true, result.Value)
    }

    @Fact
    func UserExtension_Chosen_Over_NonMatching_BclInstanceMethod_InferredLambdaArgs_Emits() {
        // GS0151 variant: with inferred type arguments from a literal lambda the
        // mixed candidate set (BCL void Send + user extension Send) must resolve
        // to the extension, which returns TResult; the program then evaluates.
        const source = `
package Repro
import System.Threading

func (ctx SynchronizationContext) Send[T, TResult](delgat (T) -> TResult, p T) TResult -> delgat(p)

var ctx = SynchronizationContext()
ctx.Send((x int32) -> x + 1, 5)
`
        let result = Evaluate(source)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(6, result.Value)
    }

    @Fact
    func UserExtension_NonColliding_Name_Control_StillBinds() {
        const source = `
package Repro
import System.Threading

func (ctx SynchronizationContext) Run[T, TResult](delgat (T) -> TResult, p T) TResult -> delgat(p)

class Wrap {
    private let sync SynchronizationContext?
    init(s SynchronizationContext?) { this.sync = s }
    func Call[T, TResult](delgat (T) -> TResult, p T) TResult {
        return sync!!.Run(delgat, p)
    }
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
