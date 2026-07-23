// <copyright file="Issue2786AsyncIteratorClassificationInterpreterTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using Xunit;

namespace GSharp.Interpreter.Tests;

public sealed class Issue2786AsyncIteratorClassificationInterpreterTests
{
    [Fact]
    public void ExplicitAsyncIteratorWithoutYield_RemainsAsyncEnumerable()
    {
        const string source = """
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            class Streams {
                async func InstanceEmpty() IAsyncEnumerable[int32] {
                    await Task.CompletedTask
                }

                shared {
                    async func Empty() IAsyncEnumerable[int32] {
                        await Task.CompletedTask
                    }

                    async func One() IAsyncEnumerable[int32] {
                        await Task.CompletedTask
                        yield 42
                    }
                }
            }

            func Pick(value IAsyncEnumerable[int32]?) IAsyncEnumerable[int32] -> value ?? Streams.Empty()

            var instanceCount = 0
            let instance = Streams().InstanceEmpty().GetAsyncEnumerator()
            for instance.MoveNextAsync().AsTask().Result {
                instanceCount += 1
            }

            var emptyCount = 0
            let empty = Pick(nil).GetAsyncEnumerator()
            for empty.MoveNextAsync().AsTask().Result {
                emptyCount += 1
            }

            var sum = 0
            let one = Pick(Streams.One()).GetAsyncEnumerator()
            for one.MoveNextAsync().AsTask().Result {
                sum += one.Current
            }

            Console.WriteLine(instanceCount.ToString() + ":" + emptyCount.ToString() + ":" + sum.ToString())
            """;

        Assert.Equal("0:0:42\n", RunSubmission(source));
    }

    [Fact]
    public void ConstrainedStaticAsyncIterator_UsesSharedIteratorClassification()
    {
        const string source = """
            import System
            import System.Collections.Generic
            import System.Threading.Tasks

            sealed interface IStreams {
                shared {
                    func Empty() IAsyncEnumerable[int32];
                    func Values() IAsyncEnumerable[int32];
                }
            }

            class Streams : IStreams {
                shared {
                    async func Empty() IAsyncEnumerable[int32] {
                        await Task.CompletedTask
                    }

                    async func Values() IAsyncEnumerable[int32] {
                        await Task.CompletedTask
                        yield 42
                    }
                }
            }

            func GetEmpty[T IStreams](witness T) IAsyncEnumerable[int32] -> T.Empty()
            func GetValues[T IStreams](witness T) IAsyncEnumerable[int32] -> T.Values()

            var emptyCount = 0
            let empty = GetEmpty(Streams{}).GetAsyncEnumerator()
            for empty.MoveNextAsync().AsTask().Result {
                emptyCount += 1
            }

            var sum = 0
            let values = GetValues(Streams{}).GetAsyncEnumerator()
            for values.MoveNextAsync().AsTask().Result {
                sum += values.Current
            }

            Console.WriteLine(emptyCount.ToString() + ":" + sum.ToString())
            """;

        Assert.Equal("0:42\n", RunSubmission(source));
    }

    private static string RunSubmission(string source)
    {
        using var output = new StringWriter();
        var previous = Console.Out;
        Console.SetOut(output);
        try
        {
            new GSharpRepl().EvaluateSubmission(source);
        }
        finally
        {
            Console.SetOut(previous);
        }

        return output.ToString().Replace("\r\n", "\n");
    }
}
