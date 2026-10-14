// <copyright file="Issue712FlowNarrowingExtensionsEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #712: Emitted-session coverage for flow narrowing extensions.
/// Traceability: ADR-0069.
open class Issue712FlowNarrowingExtensionsEmittedSessionTests {
    @Fact
    func Or_ElseBranch_OfNegatedIsTest_CallsDerivedMethod() {
        let source = AnimalHierarchy + `
func Run(a Animal, flag bool) {
    if !(a is Dog) || flag {
        Console.WriteLine("skipped")
    } else {
        Console.WriteLine(a.Bark())
    }
}

Run(Dog{Name: "Rex"}, false)
Run(Dog{Name: "Rex"}, true)
Run(Cat{Name: "Whiskers"}, false)`
        Assert.Equal(
            "Rex:woof${Environment.NewLine}skipped${Environment.NewLine}skipped${Environment.NewLine}",
            RunSubmission(source)
        )
    }

    @Fact
    func Or_GuardStyle_BangIsTest_LiftsNarrowingAfterExit() {
        let source = AnimalHierarchy + `
func Run(a Animal, force bool) {
    if a !is Dog || force {
        Console.WriteLine("skipped")
        return
    }

    Console.WriteLine(a.Bark())
    Console.WriteLine(a.Describe())
}

Run(Dog{Name: "Rex"}, false)
Run(Dog{Name: "Rex"}, true)`
        Assert.Equal(
            "Rex:woof${Environment.NewLine}Rex (dog)${Environment.NewLine}skipped${Environment.NewLine}",
            RunSubmission(source)
        )
    }

    @Fact
    func Or_RightOperand_OfNegatedIsTest_BindsAtNarrowedType() {
        let source = AnimalHierarchy + `
func Run(a Animal) bool {
    return !(a is Dog) || a.Bark() != ""
}

Console.WriteLine(Run(Dog{Name: "Rex"}))
Console.WriteLine(Run(Cat{Name: "Whiskers"}))`
        Assert.Equal("True${Environment.NewLine}True${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Or_NilGuard_ElseBranch_NarrowsToNonNullable() {
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
    func Switch_TypePattern_CallsDerivedMethodViaDiscriminator() {
        let source = AnimalHierarchy + `
func Run(a Animal) {
    switch a {
        case d is Dog { Console.WriteLine(a.Bark()) }
        case c is Cat { Console.WriteLine(a.Purr()) }
        default { Console.WriteLine("other") }
    }
}

Run(Dog{Name: "Rex"})
Run(Cat{Name: "Whiskers"})`
        Assert.Equal("Rex:woof${Environment.NewLine}Whiskers:purr${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func Switch_PostSwitch_LiftsCommonNarrowing() {
        // Verifies post-switch narrowing lifts cleanly into the
        // enclosing scope: after the switch, `a` is narrowed to `Dog`
        // because the Cat and default arms exit and the Dog arm falls
        // through with `{a → Dog}` — so `a.Bark()` resolves directly.
        //
        // Issue #738: previously the Cat / default arms could not be
        // exercised on the interpreter path because `return` inside a
        // switch arm fell through to the post-switch statements. That
        // bug is fixed, so this test mirrors the emit counterpart and
        // runs both a Dog and a Cat input through the same function.
        let source = AnimalHierarchy + `
func Run(a Animal) {
    switch a {
        case c is Cat {
            Console.WriteLine("matched cat")
            return
        }
        case d is Dog {
            Console.WriteLine("matched dog")
        }
        default {
            Console.WriteLine("default")
            return
        }
    }
    Console.WriteLine(a.Bark())
}

Run(Dog{Name: "Rex"})
Run(Cat{Name: "Whiskers"})`
        Assert.Equal(
            "matched dog${Environment.NewLine}Rex:woof${Environment.NewLine}matched cat${Environment.NewLine}",
            RunSubmission(source)
        )
    }

    shared {
        private const AnimalHierarchy string = `open class Animal {
    var Name string
    open func Describe() string { return Name }
}
class Dog : Animal {
    override func Describe() string { return Name + " (dog)" }
    func Bark() string { return Name + ":woof" }
}
class Cat : Animal {
    override func Describe() string { return Name + " (cat)" }
    func Purr() string { return Name + ":purr" }
}`

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
