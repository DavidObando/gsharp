// <copyright file="BaseAccessInFunctionLiteralBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

/// ADR-0192 follow-on 2: `base.Member` inside a function literal nested
/// in an instance member. cs2gs translates a C# local function to a G#
/// function literal, and the real `[GeneratedRegex]` output calls
/// `base.Crawlpos()` from one.
///
/// The base-access binder read the enclosing class from the function being
/// bound, which inside a literal is the literal's synthetic symbol with no
/// receiver, so every base access reported GS0383 "'base' is not valid
/// here: '<top-level>'". C# lets a lambda or local function in an
/// instance member use `base`, and the call stays non-virtual.
open class BaseAccessInFunctionLiteralBinderTests {
    @Fact
    func BaseMethodCall_InFunctionLiteral_IsNonVirtual() {
        const source = `import System

open class Base {
    open func Name() string { return "base" }
}

class Derived : Base {
    override func Name() string { return "derived" }

    func Go() string {
        let viaFunc = func () string { return base.Name() }
        let viaArrow = () -> base.Name()
        let nested = func () string {
            let inner = () -> base.Name()
            return inner()
        }
        return "${viaFunc()} ${viaArrow()} ${nested()} ${Name()}"
    }
}

Console.WriteLine(Derived().Go())`
        AssertRuns(source, "base base base derived")
    }

    @Fact
    func BasePropertyAndFieldAccess_InFunctionLiteral_BindAndRun() {
        const source = `import System

open class Base {
    protected var count int32
    open prop Auto int32 { get; set; }
}

class Derived : Base {
    override prop Auto int32 {
        get -> 1000
        set { }
    }

    func Go() string {
        let bump = func (n int32) int32 {
            base.count += n
            base.count++
            base.Auto = base.count
            return base.Auto
        }
        let first = bump(4)
        let second = bump(1)
        return "$first $second $Auto"
    }
}

Console.WriteLine(Derived().Go())`
        AssertRuns(source, "5 7 1000")
    }

    @Fact
    func ImportedBaseMembers_InFunctionLiteral_BindAndRun() {
        const source = `import System
import System.Text.RegularExpressions

class Runner : RegexRunner {
    func Step() string {
        base.runtextpos = 3
        base.runcrawl = []int32{0, 0, 0, 0}
        base.runcrawlpos = 1
        let advance = func () {
            base.runtextpos++
            base.runtrackpos = base.Crawlpos()
        }
        advance()
        return "${base.runtextpos} ${base.runtrackpos}"
    }
}

Console.WriteLine(Runner().Step())`
        AssertRuns(source, "4 3")
    }

    @Fact
    func BaseMethodGroup_InFunctionLiteral_BindsToBaseImplementation() {
        const source = `import System

open class Base {
    open func Name() string { return "base" }
}

class Derived : Base {
    override func Name() string { return "derived" }

    func Go() string {
        let f = func () string {
            let h () -> string = base.Name
            return h()
        }
        return f()
    }
}

Console.WriteLine(Derived().Go())`
        AssertRuns(source, "base")
    }

    @Fact
    func BaseCall_InFunctionLiteral_InsideSharedMember_ReportsGS0383() {
        const source = `open class Base {
    open func Name() string { return "base" }
}

class Derived : Base {
    shared {
        func Go() string {
            let f = () -> base.Name()
            return f()
        }
    }
}`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0383")
    }

    @Fact
    func BaseCall_InTopLevelFunctionLiteral_ReportsGS0383() {
        const source = "let f = () -> base.ToString()"
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0383")
    }

    @Fact
    func BaseCall_InFunctionLiteral_InsideStructMember_ReportsGS0383() {
        const source = `struct Point {
    var x int32
    func Describe() string? {
        let f = () -> base.ToString()
        return f()
    }
}`
        let result = EmittedOracle.Evaluate(source)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0383")
    }

    shared {
        private func AssertRuns(source string, expected string) {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Equal(expected + Environment.NewLine, result.Output)
        }
    }
}
