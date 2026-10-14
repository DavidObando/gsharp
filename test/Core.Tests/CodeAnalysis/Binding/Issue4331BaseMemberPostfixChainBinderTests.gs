// <copyright file="Issue4331BaseMemberPostfixChainBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Linq
import Xunit

/// Issue #4331: a postfix chain after a base member (`base.f.ToString()`,
/// `base.arr[0] = v`, `base.obj.Field = v`).
///
/// The parser took everything after `base.` as one right-associated
/// member continuation, so `base.f.ToString()` became
/// `base . (f.ToString())` and `base` was left to bind alone as a
/// type name (GS0157 "Cannot find type base"). `base.Member` now takes
/// only the member name, and the rest of the chain applies to it, as in C#.
open class Issue4331BaseMemberPostfixChainBinderTests {
    @Fact
    func SourceBase_PostfixChains_ReadAndWrite_DirectAndInFunctionLiteral() {
        // The override of P returns an 11-character string; the base
        // property's value has length 5, so `base.P.Length` must be 5.
        const source = `import System
import System.Text

class Box {
    var Field int32
    func M() StringBuilder -> StringBuilder("sb")
}

open class Base {
    protected var f int32 = 1
    protected var arr []int32 = []int32{4, 5}
    protected var obj Box = Box()
    var p string = "hello"
    open prop P string {
        get -> p
        set { p = value }
    }
}

class Derived : Base {
    override prop P string {
        get -> "overridden!"
        set { }
    }

    func Go() string {
        base.arr[0] = 9
        base.obj.Field = 7
        base.obj.Field += 1
        let direct = "${base.f.ToString()} ${base.P.Length} ${base.obj.M().Length} ${base.arr[0]} ${base.obj.Field}"
        let inLiteral = func () string {
            base.arr[1] = 6
            base.obj.Field = 3
            return "${base.f.ToString()} ${base.P.Length} ${base.obj.M().Length} ${base.arr[1]} ${base.obj.Field}"
        }
        return direct + " | " + inLiteral()
    }
}

Console.WriteLine(Derived().Go())`
        AssertRuns(source, "1 5 2 9 8 | 1 5 2 6 3")
    }

    @Fact
    func ImportedBase_PostfixChains_ReadAndWrite_DirectAndInFunctionLiteral() {
        const source = (`import System
import System.IO
import System.Text.RegularExpressions

class Pattern : Regex {
    init() : base("abcd") { }

    func Go() string {
        let inLiteral = () -> base.pattern?.Length ?? -1
        return "${base.pattern?.Length ?? -1} ${inLiteral()}"
    }
}

class Runner : RegexRunner {
    func Go() string {
        // ` + "`" + `runcrawl` + "`" + ` is ` + "`" + `int[]?` + "`" + `, so the chain reads through ` + "`" + `?[` + "`" + `
        // and ` + "`" + `?.` + "`" + `.
        base.runcrawl = []int32{5, 0, 0}
        let inLiteral = () -> base.runcrawl?.Length ?? -1
        return "${base.runcrawl?[0] ?? -1} ${inLiteral()} ${base.runcrawl?[1] ?? -1}"
    }
}

class Mem : MemoryStream {
    func Go() string {
        base.SetLength(12)
        return base.Length.ToString()
    }
}

Console.WriteLine(Pattern().Go())
Console.WriteLine(Runner().Go())
Console.WriteLine(Mem().Go())`)
        AssertRuns(source, "4 4", "5 3 0", "12")
    }

    @Fact
    func ValueNamedBase_PostfixChain_KeepsOrdinaryMeaning() {
        const source = `import System

class Inner {
    var n int32 = 41
}

class Outer {
    var inner Inner = Inner()
}

var base = Outer()
base.inner.n++
Console.WriteLine(base.inner.n.ToString())`
        AssertRuns(source, "42")
    }

    @Fact
    func NestedTypeAndLocalNamedBase_MemberCalls_KeepOrdinaryMeaning() {
        // `base` is contextual: a nested type or a local named `base` keeps
        // its ordinary meaning in `base.M(args)`, directly and in a function
        // literal.
        const source = `import System

class Helper {
    func M() string -> "helper.M"
}

class Outer {
    class base {
        shared { func N() string -> "nested.N" }
    }

    func Go() string {
        let f = () -> base.N()
        return base.N() + " " + f()
    }
}

func Run() string {
    let base = Helper()
    let f = () -> base.M()
    return base.M() + " " + f()
}

Console.WriteLine(Run())
Console.WriteLine(Outer().Go())`
        AssertRuns(source, "helper.M helper.M", "nested.N nested.N")
    }

    @Fact
    func FunctionNamedBase_CallResultMemberCall_Binds() {
        const source = `import System

class Helper {
    func M() string -> "helper.M"
}

func base() Helper -> Helper()

Console.WriteLine(base().M())`
        AssertRuns(source, "helper.M")
    }

    @Fact
    func SourceTypeNamedBase_StaticCalls_BindAndRun() {
        const source = `import System

class base {
    shared {
        func M() string -> "base.M"
        func Twice(x int32) int32 -> x * 2
    }
}

func Run() string {
    let f = () -> base.M()
    return base.M() + " " + base.Twice(4).ToString() + " " + f()
}

Console.WriteLine(Run())`
        AssertRuns(source, "base.M 8 base.M")
    }

    @Fact
    func ImportAliasNamedBase_StaticCall_Binds() {
        const source = `import System
import base = System.Math

Console.WriteLine(base.Max(1, 2).ToString())`
        AssertRuns(source, "2")
    }

    shared {
        private func AssertRuns(source string, expectedLines ...string) {
            let result = EmittedOracle.Evaluate(source)
            Assert.Empty(result.Diagnostics.Where((d Diagnostic) -> d.IsError))
            Assert.Equal(
                string.Concat(expectedLines.Select((line string) -> line + Environment.NewLine)),
                result.Output
            )
        }
    }
}
