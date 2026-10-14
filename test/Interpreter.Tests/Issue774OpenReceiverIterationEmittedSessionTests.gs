// <copyright file="Issue774OpenReceiverIterationEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #774: Emitted-session coverage for open receiver iteration.
/// @remarks The Dictionary[K, V] case is intentionally omitted — the
/// emitted session covers the supported closed-instantiation branch of the
/// erased self parameter for Dictionary receivers (documented in
/// `Issue773GenericReceiverEmittedSessionTests.DictionaryKV_Receiver_Dispatches`),
/// which is independent of the iteration fix here. End-to-end IL
/// coverage for the Dictionary case lives in the emit suite.
open class Issue774OpenReceiverIterationEmittedSessionTests {
    @Fact
    func IEnumerableT_Receiver_ForIn_Returns_First_Element_As_T() {
        // This emitted-session case uses a reference-typed element; value-type
        // receiver substitution is covered in the IL-verified emit suite.
        let source = `import System.Collections.Generic

func (self IEnumerable[T]) MyFirst[T any](fb T) T {
    for v in self {
        return v
    }
    return fb
}

var arr = []string{"alpha", "beta"}
Console.WriteLine(arr.MyFirst(""))`
        Assert.Equal("alpha${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IEnumerableT_Receiver_ForIn_Counts_Elements() {
        let source = `import System.Collections.Generic

func (self IEnumerable[T]) MyCount[T](seed T) int32 {
    var n = 0
    for v in self {
        n = n + 1
    }
    return n
}

var arr = []string{"a", "b", "c", "d"}
Console.WriteLine(arr.MyCount(""))`
        Assert.Equal("4${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func SequenceT_Receiver_ForIn_Forwards_Element_As_T() {
        // See note above: this emitted-session case uses a reference-typed
        // element.
        let source = `func passthrough[T](x T) T {
    return x
}

func (self sequence[T]) FirstOr[T](fb T) T {
    for v in self {
        return passthrough(v)
    }
    return fb
}

var arr = []string{"x", "y"}
Console.WriteLine(arr.FirstOr(""))`
        Assert.Equal("x${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func SliceT_Receiver_ForIn_Returns_First_Element() {
        let source = `func (self []T) Head[T](fb T) T {
    for v in self {
        return v
    }
    return fb
}

var arr = []int32{7, 8, 9}
Console.WriteLine(arr.Head(0))`
        Assert.Equal("7${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func IEnumerableT_Receiver_ForIn_Roundtrips_StringElement() {
        let source = `import System.Collections.Generic

func (self IEnumerable[T]) MyFirst[T](fb T) T {
    for v in self {
        return v
    }
    return fb
}

var arr = []string{"hello", "world"}
Console.WriteLine(arr.MyFirst(""))`
        Assert.Equal("hello${Environment.NewLine}", RunSubmission(source))
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
