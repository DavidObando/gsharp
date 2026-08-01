// <copyright file="Issue2941FlagsEnumExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Repl.Engine;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2941: interpreter parity for name-complete enum switches across
/// flags annotations, symbol origins, and switch forms.
/// </summary>
public class Issue2941FlagsEnumExhaustivenessTests
{
    private const string CatchingUnmatchedSource = """
        import System

        @Flags
        enum Access { None = 0, Read = 1, Write = 2 }

        func F(x Access) int32 {
            return switch x {
                case Access.None: 0
                case Access.Read: 1
                case Access.Write: 2
            }
        }

        try {
            Console.WriteLine(F(Access.Read | Access.Write))
        } catch (e InvalidOperationException) {
            Console.WriteLine("caught-ioe")
        } catch (e Exception) {
            Console.WriteLine("caught-generic")
        }
        Console.WriteLine("after")
        """;

    private const string UnmatchedSource = """
        @Flags
        enum Access { None = 0, Read = 1, Write = 2 }

        func F(x Access) int32 {
            return switch x {
                case Access.None: 0
                case Access.Read: 1
                case Access.Write: 2
            }
        }

        F(Access.Read | Access.Write)
        """;

    [Fact]
    public void NameCompleteEnumSwitches_RunWithExactOutput()
    {
        const string Source = """
            import System

            @Flags
            enum Access { None = 0, Read = 1, Write = 2 }

            enum Plain { None, Read, Write }

            func importedStatement(x StringSplitOptions) int32 {
                switch x {
                    case StringSplitOptions.None { return 10 }
                    case StringSplitOptions.RemoveEmptyEntries { return 11 }
                    case StringSplitOptions.TrimEntries { return 12 }
                }
            }

            func importedExpression(x StringSplitOptions) int32 {
                return switch x {
                    case StringSplitOptions.None: 20
                    case StringSplitOptions.RemoveEmptyEntries: 21
                    case StringSplitOptions.TrimEntries: 22
                }
            }

            func userStatement(x Access) int32 {
                switch x {
                    case Access.None { return 30 }
                    case Access.Read { return 31 }
                    case Access.Write { return 32 }
                }
            }

            func userExpression(x Access) int32 {
                return switch x {
                    case Access.None: 40
                    case Access.Read: 41
                    case Access.Write: 42
                }
            }

            func plainStatement(x Plain) int32 {
                switch x {
                    case Plain.None { return 50 }
                    case Plain.Read { return 51 }
                    case Plain.Write { return 52 }
                }
            }

            func plainExpression(x Plain) int32 {
                return switch x {
                    case Plain.None: 60
                    case Plain.Read: 61
                    case Plain.Write: 62
                }
            }

            Console.WriteLine(importedStatement(StringSplitOptions.RemoveEmptyEntries))
            Console.WriteLine(importedExpression(StringSplitOptions.TrimEntries))
            Console.WriteLine(userStatement(Access.Read))
            Console.WriteLine(userExpression(Access.Write))
            Console.WriteLine(plainStatement(Plain.Read))
            Console.WriteLine(plainExpression(Plain.Write))
            """;

        using var output = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(output);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(Source);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        Assert.Equal(
            "11\n22\n31\n42\n51\n62\n",
            output.ToString().Replace("\r\n", "\n", StringComparison.Ordinal));
    }

    [Fact]
    public void UnmatchedFlagsValue_ReportsRuntimeError()
    {
        var result = new SessionEngine().Evaluate(UnmatchedSource);
        var diagnostic = Assert.Single(result.Diagnostics);

        Assert.True(result.HasError);
        Assert.Equal("GS9999", diagnostic.Id);
        Assert.Equal("Unmatched switch expression value.", diagnostic.Message);
    }

    [Fact]
    public void UnmatchedFlagsValue_PreservesInvalidOperationExceptionType()
    {
        var result = new SessionEngine { CaptureConsole = true }.Evaluate(CatchingUnmatchedSource);

        Assert.False(result.HasError);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(
            "caught-ioe\nafter\n",
            result.Output.Replace("\r\n", "\n", StringComparison.Ordinal));
    }
}
