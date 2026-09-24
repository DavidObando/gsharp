// <copyright file="Issue4331BaseMemberPostfixChainBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Linq;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4331: a postfix chain after a base member (<c>base.f.ToString()</c>,
/// <c>base.arr[0] = v</c>, <c>base.obj.Field = v</c>).
/// <para>
/// The parser took everything after <c>base.</c> as one right-associated
/// member continuation, so <c>base.f.ToString()</c> became
/// <c>base . (f.ToString())</c> and <c>base</c> was left to bind alone as a
/// type name (GS0157 "Cannot find type base"). <c>base.Member</c> now takes
/// only the member name, and the rest of the chain applies to it, as in C#.
/// </para>
/// </summary>
public class Issue4331BaseMemberPostfixChainBinderTests
{
    [Fact]
    public void SourceBase_PostfixChains_ReadAndWrite_DirectAndInFunctionLiteral()
    {
        // The override of P returns an 11-character string; the base
        // property's value has length 5, so `base.P.Length` must be 5.
        const string source = """
            import System
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

            Console.WriteLine(Derived().Go())
            """;

        AssertRuns(source, "1 5 2 9 8 | 1 5 2 6 3");
    }

    [Fact]
    public void ImportedBase_PostfixChains_ReadAndWrite_DirectAndInFunctionLiteral()
    {
        const string source = """
            import System
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
                    // `runcrawl` is `int[]?`, so the chain reads through `?[`
                    // and `?.`.
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
            Console.WriteLine(Mem().Go())
            """;

        AssertRuns(source, "4 4", "5 3 0", "12");
    }

    [Fact]
    public void ValueNamedBase_PostfixChain_KeepsOrdinaryMeaning()
    {
        const string source = """
            import System

            class Inner {
                var n int32 = 41
            }

            class Outer {
                var inner Inner = Inner()
            }

            var base = Outer()
            base.inner.n++
            Console.WriteLine(base.inner.n.ToString())
            """;

        AssertRuns(source, "42");
    }

    private static void AssertRuns(string source, params string[] expectedLines)
    {
        var result = EmittedOracle.Evaluate(source);
        Assert.Empty(result.Diagnostics.Where(d => d.IsError));
        Assert.Equal(
            string.Concat(expectedLines.Select(line => line + Environment.NewLine)),
            result.Output);
    }
}
