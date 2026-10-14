// <copyright file="Issue737NilGuardElseBranchEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #737: Emitted-session coverage for nil guard else branch.
open class Issue737NilGuardElseBranchEmittedSessionTests {
    @Fact
    func IfElse_BothBranchesReturn_String_ElseBranchReadsNarrowed() {
        let source = `func Length(s string?) int32 {
    if s == nil {
        return -1
    } else {
        return s.Length
    }
}

Console.WriteLine(Length("hello"))
Console.WriteLine(Length(nil))`
        Assert.Equal("5${Environment.NewLine}-1${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfElse_PositiveGuard_ThenBranchReadsNarrowed() {
        let source = `func Use(s string) int32 {
    return s.Length
}

func Length(s string?) int32 {
    if s != nil {
        return Use(s)
    }
    return -1
}

Console.WriteLine(Length("hi"))
Console.WriteLine(Length(nil))`
        Assert.Equal("2${Environment.NewLine}-1${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfElse_BothBranchesReturn_OrComposition_ElseReadsNarrowed() {
        let source = `func Length(s string?, force bool) int32 {
    if s == nil || force {
        return -1
    } else {
        return s.Length
    }
}

Console.WriteLine(Length("hello", false))
Console.WriteLine(Length("hello", true))
Console.WriteLine(Length(nil, false))`
        Assert.Equal("5${Environment.NewLine}-1${Environment.NewLine}-1${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfElse_BothBranchesReturn_ChainedAndGuard() {
        let source = `func Both(a string?, b string?) int32 {
    if a != nil && b != nil {
        return a.Length + b.Length
    } else {
        return -1
    }
}

Console.WriteLine(Both("hi", "ya"))
Console.WriteLine(Both("hi", nil))
Console.WriteLine(Both(nil, "ya"))`
        Assert.Equal("4${Environment.NewLine}-1${Environment.NewLine}-1${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfElse_BothBranchesReturn_UserClass_ElseReadsNarrowed() {
        let source = `class Greeter {
    var Name string
    func Greet() string { return "hi " + Name }
}

func DescribeOrDefault(g Greeter?) string {
    if g == nil {
        return "none"
    } else {
        return g.Greet()
    }
}

Console.WriteLine(DescribeOrDefault(Greeter{Name: "Alice"}))
Console.WriteLine(DescribeOrDefault(nil))`
        Assert.Equal("hi Alice${Environment.NewLine}none${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfElse_BothBranchesReturn_Interface_ElseReadsNarrowed() {
        // A G#-declared interface (not a CLR import) keeps this case focused
        // on emitted flow narrowing over source-defined interface members.
        let source = `interface IGreeter {
    func Greet() string;
}

class Hello : IGreeter {
    var Name string
    func Greet() string { return "hi " + Name }
}

func DescribeOrDefault(g IGreeter?) string {
    if g == nil {
        return "none"
    } else {
        return g.Greet()
    }
}

var h IGreeter = Hello{Name: "Alice"}
Console.WriteLine(DescribeOrDefault(h))
Console.WriteLine(DescribeOrDefault(nil))`
        Assert.Equal("hi Alice${Environment.NewLine}none${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IfElse_BothBranchesReturn_NonNullableBaseline_NoNarrowing() {
        let source = `func Classify(n int32) int32 {
    if n > 0 {
        return 1
    } else {
        return -1
    }
}

Console.WriteLine(Classify(5))
Console.WriteLine(Classify(-3))`
        Assert.Equal("1${Environment.NewLine}-1${Environment.NewLine}", RunSubmission(source))
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            let prevOut = Console.Out
            Console.SetOut(outWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
            }
            return outWriter.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
