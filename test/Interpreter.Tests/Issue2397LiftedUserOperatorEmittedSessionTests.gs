// <copyright file="Issue2397LiftedUserOperatorEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #2397: Emitted-session coverage for lifted user operator.
open class Issue2397LiftedUserOperatorEmittedSessionTests {
    @Fact
    func LiftedEqualityAndInequality_UseOperatorForValuesAndBuiltInNullSemantics() {
        const source = `import System

struct Score {
    var Rank int32
}

func (left Score) operator ==(right Score) bool {
    return left.Rank / 10 == right.Rank / 10
}

func (left Score) operator !=(right Score) bool {
    return left.Rank / 10 != right.Rank / 10
}

let seven Score? = Score{Rank: 7}
let eight Score? = Score{Rank: 8}
let twelve Score? = Score{Rank: 12}
let missing Score? = nil

Console.WriteLine(seven == eight)
Console.WriteLine(seven == twelve)
Console.WriteLine(seven == missing)
Console.WriteLine(missing == seven)
Console.WriteLine(missing == missing)
Console.WriteLine(seven != eight)
Console.WriteLine(seven != twelve)
Console.WriteLine(seven != missing)
Console.WriteLine(missing != seven)
Console.WriteLine(missing != missing)`
        Assert.Equal(`True
False
False
False
True
False
True
True
True
False
`, RunSubmission(source))
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let previous = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(previous)
            }
            return outWriter.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
