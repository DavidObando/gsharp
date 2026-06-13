// <copyright file="Issue757BaseInterfaceCallInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// ADR-0091 / issue #757: interpreter parity for the explicit-base
/// interface-call expression <c>base[IFoo].Method(args)</c>. Mirrors the
/// emit-side coverage: a diamond disambiguation that delegates to both
/// inherited defaults works end-to-end through the interpreter, and the
/// non-virtual semantics (do not re-dispatch through the v-table) hold
/// — otherwise an override that called <c>base[IFoo].M()</c> would
/// recurse infinitely.
/// </summary>
public class Issue757BaseInterfaceCallInterpreterTests
{
    [Fact]
    public void DiamondDelegation_ExplicitBase_CombinesBothDefaults()
    {
        var source = """
            interface IA {
                func Tag() string { return "A" }
            }
            interface IB {
                func Tag() string { return "B" }
            }
            class C : IA, IB {
                func Tag() string {
                    return base[IA].Tag() + base[IB].Tag()
                }
            }
            var c = C{}
            Console.WriteLine(c.Tag())
            """;
        var output = RunSubmission(source);
        Assert.Contains("AB", output);
    }

    [Fact]
    public void DiamondDelegation_ExplicitBase_RoutedViaInterfaceTypedReceiver()
    {
        // Interface-typed receiver dispatches through the runtime class's
        // override; the override uses `base[IA].M()` to reach the IA
        // default. Mirrors the emit `call`-not-callvirt semantics.
        var source = """
            interface IA {
                func Value() int32 { return 1 }
            }
            interface IB {
                func Value() int32 { return 2 }
            }
            class C : IA, IB {
                func Value() int32 { return base[IA].Value() + base[IB].Value() * 10 }
            }
            var c = C{}
            var ia IA = c
            var ib IB = c
            Console.WriteLine(c.Value())
            Console.WriteLine(ia.Value())
            Console.WriteLine(ib.Value())
            """;
        var output = RunSubmission(source);
        // 1 + 2 * 10 == 21 — same answer all three ways (virtual dispatch
        // routes back to C.Value through the v-table).
        Assert.Contains("21", output);
    }

    [Fact]
    public void DiamondDelegation_AdditionalLogicAroundBaseCalls()
    {
        // ADR-0091: the override can compose extra logic around the base
        // calls — the canonical "default + extra logic" use case.
        var source = """
            interface IGreeter {
                func Hello() string { return "hi" }
            }
            class Loud : IGreeter {
                func Hello() string { return base[IGreeter].Hello() + "!" }
            }
            var l = Loud{}
            Console.WriteLine(l.Hello())
            """;
        var output = RunSubmission(source);
        Assert.Contains("hi!", output);
    }

    [Fact]
    public void DiamondDelegation_NonVirtualCall_DoesNotRecurse()
    {
        // ADR-0091: if `base[IGreeter].Hello()` re-dispatched through the
        // v-table it would re-enter `Loud.Hello` and recurse forever.
        // This test pins that the non-virtual semantics hold on the
        // interpreter path.
        var source = """
            interface IGreeter {
                func Hello() string { return "default" }
            }
            class Loud : IGreeter {
                func Hello() string { return base[IGreeter].Hello() }
            }
            var l = Loud{}
            Console.WriteLine(l.Hello())
            """;
        var output = RunSubmission(source);
        Assert.Contains("default", output);
    }

    [Fact]
    public void BaseInterfaceCall_InsidePrivateMember_Works()
    {
        var source = """
            interface IFoo {
                func Greet() string { return "hi" }
            }
            class C : IFoo {
                func Greet() string { return Inner() }
                private func Inner() string { return base[IFoo].Greet() + "!" }
            }
            var c = C{}
            Console.WriteLine(c.Greet())
            """;
        var output = RunSubmission(source);
        Assert.Contains("hi!", output);
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

        return outWriter.ToString();
    }
}
