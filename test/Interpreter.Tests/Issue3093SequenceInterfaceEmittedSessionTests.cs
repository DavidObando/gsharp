// <copyright file="Issue3093SequenceInterfaceEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

public sealed class Issue3093SequenceInterfaceEmittedSessionTests
{
    [Fact]
    public void IteratorAndExplicitSequence_DispatchThroughInterface()
    {
        const string Source = """
            import System.Collections.Generic

            func One(value int32) sequence[int32] {
                yield value
            }

            interface IDetector {
                func Detect(text string) IEnumerable[int32];
                func DetectExplicit(text string) IEnumerable[int32];
            }

            class Detector : IDetector {
                func Detect(text string) sequence[int32] {
                    yield text.Length
                }

                func DetectExplicit(text string) sequence[int32] {
                    return One(text.Length)
                }
            }

            var detector IDetector = Detector{}
            for value in detector.Detect("abc") {
                Console.WriteLine(value)
            }
            for value in detector.DetectExplicit("abc") {
                Console.WriteLine(value)
            }
            """;

        Assert.Equal($"3{Environment.NewLine}3{Environment.NewLine}", RunSubmission(Source));
    }

    [Fact]
    public void GenericIterator_DispatchesThroughInterface()
    {
        const string Source = """
            import System.Collections.Generic

            interface IDetector {
                func Detect[T](value T) IEnumerable[T];
            }

            class Detector : IDetector {
                func Detect[T](value T) sequence[T] {
                    yield value
                }
            }

            var detector IDetector = Detector{}
            for value in detector.Detect[int32](3) {
                Console.WriteLine(value)
            }
            """;

        Assert.Equal($"3{Environment.NewLine}", RunSubmission(Source));
    }

    private static string RunSubmission(string source)
    {
        using var output = new StringWriter();
        var previousOut = Console.Out;
        Console.SetOut(output);
        try
        {
            new GSharpRepl().EvaluateSubmission(source);
        }
        finally
        {
            Console.SetOut(previousOut);
        }

        return output.ToString().ReplaceLineEndings(Environment.NewLine);
    }
}
