// <copyright file="Issue2965ChannelElementSlotTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

/// <summary>
/// Issue #2965: Emitted-session coverage for channel element slot.
/// </summary>
public class Issue2965ChannelElementSlotTests
{
    [Fact]
    public void UserStructChannelsRemainCorrectInEmittedSession()
    {
        const string Source = """
            import System
            import Gsharp.Extensions.Go

            data struct Pair(Value int32)

            let plain = make(chan Pair, 1)
            plain <- Pair(41)
            Console.WriteLine((<-plain).Value)

            let selected = make(chan Pair, 1)
            select {
                case selected <- Pair(42) {
                    Console.Write("")
                }
            }
            select {
                case let value = <-selected { Console.WriteLine(value.Value) }
            }
            """;

        Assert.Equal($"41{Environment.NewLine}42{Environment.NewLine}", RunSubmission(Source));
    }

    private static string RunSubmission(string source)
    {
        using var output = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(output);
        try
        {
            var repl = new GSharpRepl();
            repl.EvaluateSubmission(source);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return output.ToString().ReplaceLineEndings(Environment.NewLine);
    }
}
