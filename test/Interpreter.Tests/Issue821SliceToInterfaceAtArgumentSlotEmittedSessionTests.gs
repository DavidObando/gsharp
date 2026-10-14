// <copyright file="Issue821SliceToInterfaceAtArgumentSlotEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #821: Emitted-session coverage for slice to interface at argument slot.
open class Issue821SliceToInterfaceAtArgumentSlotEmittedSessionTests {
    @Fact
    func StaticGeneric_IEnumerableOfT_AcceptsSliceLiteral_Int32() {
        // The literal issue repro at the static-call argument slot.
        let source = `import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T](source IEnumerable[T]) sequence[(int32, T)] {
            var index = 0
            for v in source {
                yield (index, v)
                index = index + 1
            }
        }
    }
}

var sumIdx = 0
var sumVal = 0
for p in Sequences.Indexed[int32]([]int32{10, 20, 30}) {
    sumIdx = sumIdx + p.Item1
    sumVal = sumVal + p.Item2
}
Console.WriteLine(sumIdx)
Console.WriteLine(sumVal)`
        Assert.Equal("3${Environment.NewLine}60${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func StaticGeneric_IEnumerableOfT_AcceptsSliceLiteral_String() {
        // String closure of the same shape.
        let source = `import System.Collections.Generic

class Sequences {
    shared {
        func Indexed[T](source IEnumerable[T]) sequence[(int32, T)] {
            var index = 0
            for v in source {
                yield (index, v)
                index = index + 1
            }
        }
    }
}

var sumIdx = 0
var concat = ""
for p in Sequences.Indexed[string]([]string{"a", "b", "c"}) {
    sumIdx = sumIdx + p.Item1
    concat = concat + p.Item2
}
Console.WriteLine(sumIdx)
Console.WriteLine(concat)`
        Assert.Equal("3${Environment.NewLine}abc${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func FreeFunctionArgSlot_IEnumerableOfT_AcceptsSliceLiteral() {
        // Free-function call slot.
        let source = `import System.Collections.Generic

func Count[T](source IEnumerable[T]) int32 {
    var n = 0
    for _ in source {
        n = n + 1
    }
    return n
}

Console.WriteLine(Count[int32]([]int32{10, 20, 30}))`
        Assert.Equal("3${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func StaticGeneric_IListOfT_AcceptsSliceLiteral() {
        // `IList[T]` parameter — slice satisfies via backing CLR array.
        let source = `import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source IList[T]) int32 { return source.Count }
    }
}

Console.WriteLine(Sink.Take[int32]([]int32{1, 2, 3}))`
        Assert.Equal("3${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func StaticGeneric_ICollectionOfT_AcceptsSliceLiteral() {
        // `ICollection[T]` parameter.
        let source = `import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source ICollection[T]) int32 { return source.Count }
    }
}

Console.WriteLine(Sink.Take[int32]([]int32{1, 2, 3, 4}))`
        Assert.Equal("4${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func StaticGeneric_IReadOnlyListOfT_AcceptsSliceLiteral() {
        // `IReadOnlyList[T]` parameter — slice satisfies via backing CLR
        // array. Returns `int32` to stay on the conversion path.
        let source = `import System.Collections.Generic

class Sink {
    shared {
        func Take[T](source IReadOnlyList[T]) int32 { return source.Count }
    }
}

Console.WriteLine(Sink.Take[int32]([]int32{7, 8, 9}))`
        Assert.Equal("3${Environment.NewLine}", RunSubmission(source))
    }

    shared {
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
