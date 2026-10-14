// <copyright file="Issue3003LambdaBodyLoweringTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Issue #3003: function-literal bodies must be lowered before evaluation.
open class Issue3003LambdaBodyLoweringTests {
    @Fact
    func LambdaBody_LowersIfAndAllForForms() {
        const Source = `let choose = func(n int32) string {
    if n > 0 {
        return "positive"
    }
    return "zero"
}

let sumRange = func() int32 {
    var sum = 0
    for value in []int32{1, 2, 3} {
        sum += value
    }
    return sum
}

let countEllipsis = func() int32 {
    var count = 0
    for _ in 0 ... 3 {
        count++
    }
    return count
}

let countInfinite = func() int32 {
    var count = 0
    for {
        count++
        if count == 3 {
            break
        }
    }
    return count
}

Console.WriteLine(choose(1))
Console.WriteLine(sumRange())
Console.WriteLine(countEllipsis())
Console.WriteLine(countInfinite())`
        Assert.Equal(
            "positive${Environment.NewLine}6${Environment.NewLine}3${Environment.NewLine}3${Environment.NewLine}",
            Evaluate(Source)
        )
    }

    @Fact
    func LambdaBody_PreservesConditionForSwitchAndMethodGroupDelegate() {
        const Source = `func sign(n int32) string {
    if n > 0 {
        return "positive"
    }
    return "zero"
}

let countTo = func(n int32) int32 {
    var count = 0
    for count < n {
        count++
    }
    return count
}

let classify = func(n int32) string {
    switch n {
        case 1 {
            return "one"
        }
        default {
            return "other"
        }
    }
}

let signDelegate (int32) -> string = sign

Console.WriteLine(countTo(3))
Console.WriteLine(classify(1))
Console.WriteLine(signDelegate(1))
Console.WriteLine(signDelegate(0))`
        Assert.Equal(
            "3${Environment.NewLine}one${Environment.NewLine}positive${Environment.NewLine}zero${Environment.NewLine}",
            Evaluate(Source)
        )
    }

    shared {
        private func Evaluate(source string) string {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            return result.Output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
