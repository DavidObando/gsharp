// <copyright file="Issue712FlowNarrowingExtensionsInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #712 / ADR-0069 addendum — interpreter parity for flow-narrowing
/// extensions across <c>||</c> short-circuit (De Morgan dual of
/// <c>&amp;&amp;</c>) and <c>switch</c> arm discriminator narrowing
/// (in-arm and post-switch). The interpreter shares the binder with the
/// emit pipeline; this file pins down the REPL/evaluator execution
/// semantics for the same shapes covered by the binder and emit suites.
/// </summary>
public class Issue712FlowNarrowingExtensionsInterpreterTests
{
    private const string AnimalHierarchy = """
        open class Animal {
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
        }
        """;

    [Fact]
    public void Or_ElseBranch_OfNegatedIsTest_CallsDerivedMethod()
    {
        var source = AnimalHierarchy + """

            func Run(a Animal, flag bool) {
                if !(a is Dog) || flag {
                    Console.WriteLine("skipped")
                } else {
                    Console.WriteLine(a.Bark())
                }
            }

            Run(Dog{Name: "Rex"}, false)
            Run(Dog{Name: "Rex"}, true)
            Run(Cat{Name: "Whiskers"}, false)
            """;

        Assert.Equal("Rex:woof\nskipped\nskipped\n", RunSubmission(source));
    }

    [Fact]
    public void Or_GuardStyle_BangIsTest_LiftsNarrowingAfterExit()
    {
        var source = AnimalHierarchy + """

            func Run(a Animal, force bool) {
                if a !is Dog || force {
                    Console.WriteLine("skipped")
                    return
                }

                Console.WriteLine(a.Bark())
                Console.WriteLine(a.Describe())
            }

            Run(Dog{Name: "Rex"}, false)
            Run(Dog{Name: "Rex"}, true)
            """;

        Assert.Equal("Rex:woof\nRex (dog)\nskipped\n", RunSubmission(source));
    }

    [Fact]
    public void Or_RightOperand_OfNegatedIsTest_BindsAtNarrowedType()
    {
        var source = AnimalHierarchy + """

            func Run(a Animal) bool {
                return !(a is Dog) || a.Bark() != ""
            }

            Console.WriteLine(Run(Dog{Name: "Rex"}))
            Console.WriteLine(Run(Cat{Name: "Whiskers"}))
            """;

        Assert.Equal("True\nTrue\n", RunSubmission(source));
    }

    [Fact]
    public void Or_NilGuard_ElseBranch_NarrowsToNonNullable()
    {
        var source = """
            func Length(s string?, force bool) int32 {
                if s == nil || force {
                    return -1
                } else {
                    return s.Length
                }
            }

            Console.WriteLine(Length("hello", false))
            Console.WriteLine(Length("hello", true))
            Console.WriteLine(Length(nil, false))
            """;

        Assert.Equal("5\n-1\n-1\n", RunSubmission(source));
    }

    [Fact]
    public void Switch_TypePattern_CallsDerivedMethodViaDiscriminator()
    {
        var source = AnimalHierarchy + """

            func Run(a Animal) {
                switch a {
                    case d is Dog { Console.WriteLine(a.Bark()) }
                    case c is Cat { Console.WriteLine(a.Purr()) }
                    default { Console.WriteLine("other") }
                }
            }

            Run(Dog{Name: "Rex"})
            Run(Cat{Name: "Whiskers"})
            """;

        Assert.Equal("Rex:woof\nWhiskers:purr\n", RunSubmission(source));
    }

    [Fact]
    public void Switch_PostSwitch_LiftsCommonNarrowing()
    {
        // Verifies post-switch narrowing lifts cleanly into the
        // enclosing scope: after the switch, `a` is narrowed to `Dog`
        // because the Cat and default arms exit and the Dog arm falls
        // through with `{a → Dog}` — so `a.Bark()` resolves directly.
        var source = AnimalHierarchy + """

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
            """;

        Assert.Equal("matched dog\nRex:woof\n", RunSubmission(source));
    }

    private static string RunSubmission(string text)
    {
        using var outWriter = new StringWriter();
        var prevOut = Console.Out;
        Console.SetOut(outWriter);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(text);
        }
        finally
        {
            Console.SetOut(prevOut);
        }

        return outWriter.ToString().Replace("\r\n", "\n");
    }
}
