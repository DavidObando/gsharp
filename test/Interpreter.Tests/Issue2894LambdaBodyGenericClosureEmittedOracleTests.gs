// <copyright file="Issue2894LambdaBodyGenericClosureEmittedOracleTests.cs" company="GSharp">
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

/// Issue #2894: Emitted-oracle coverage for lambda body generic closure.
open class Issue2894LambdaBodyGenericClosureEmittedOracleTests {
    @Fact
    func BodyOnlyGenericParameter_TopLevel_Runs() {
        const Source = `open class Box { var Value int32 }
class IntBox : Box {}
class Descriptor { var Factory (() -> Box)? }
let Make[TBox Box] = func(input Box) Descriptor {
    return Descriptor{
        Factory: func() Box {
            let marker = default(TBox)
            if marker == nil {
                return input
            }
            return marker
        },
    }
}
let descriptor = Make[IntBox](Box{ Value: 99 })
let factory = descriptor.Factory!!
Console.WriteLine(factory().Value)`
        Assert.Equal("99${Environment.NewLine}", Evaluate(Source))
    }

    @Fact
    func BodyOnlyGenericParameter_InsideFunction_Runs() {
        const Source = `open class Box { var Value int32 }
class IntBox : Box {}
class Descriptor { var Factory (() -> Box)? }
func Run() int32 {
    let Make[TBox Box] = func(input Box) Descriptor {
        return Descriptor{
            Factory: func() Box {
                let marker = default(TBox)
                if marker == nil {
                    return input
                }
                return marker
            },
        }
    }
    let descriptor = Make[IntBox](Box{ Value: 111 })
    let factory = descriptor.Factory!!
    return factory().Value
}
Console.WriteLine(Run())`
        Assert.Equal("111${Environment.NewLine}", Evaluate(Source))
    }

    shared {
        private func Evaluate(source string) string {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics)
            return result.Output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
