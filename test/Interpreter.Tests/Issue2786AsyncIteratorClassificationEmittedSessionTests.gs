// <copyright file="Issue2786AsyncIteratorClassificationEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

class Issue2786AsyncIteratorClassificationEmittedSessionTests {
    @Fact
    func ExplicitAsyncIteratorWithoutYield_RemainsAsyncEnumerable() {
        const source = `import System
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

Console.WriteLine(instanceCount.ToString() + ":" + emptyCount.ToString() + ":" + sum.ToString())`
        Assert.Equal("0:0:42${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func ConstrainedStaticAsyncIterator_UsesSharedIteratorClassification() {
        const source = `import System
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

Console.WriteLine(emptyCount.ToString() + ":" + sum.ToString())`
        Assert.Equal("0:42${Environment.NewLine}", RunSubmission(source))
    }

    shared {
        private func RunSubmission(source string) string {
            using let output = StringWriter()
            let previous = Console.Out
            Console.SetOut(output)
            try {
                GSharpRepl().EvaluateSubmission(source)
            } finally {
                Console.SetOut(previous)
            }
            return output.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
