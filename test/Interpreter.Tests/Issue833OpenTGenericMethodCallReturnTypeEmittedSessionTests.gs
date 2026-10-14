// <copyright file="Issue833OpenTGenericMethodCallReturnTypeEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// Issue #833: Emitted-session coverage for open t generic method call return type.
open class Issue833OpenTGenericMethodCallReturnTypeEmittedSessionTests {
    @Fact
    func EnumerableEmpty_With_OpenT_Roundtrips_Int32() {
        let source = `import System.Linq
import System.Collections.Generic

class Sequences {
    shared {
        func Empty[T]() IEnumerable[T] {
            return Enumerable.Empty[T]()
        }
    }
}

var seq = Sequences.Empty[int32]()
var count = 0
for v in seq {
    count = count + 1
}
Console.WriteLine(count)
Console.WriteLine("done")`
        Assert.Equal("0${Environment.NewLine}done${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func EnumerableEmpty_With_OpenT_TopLevelFunc_Roundtrips_String() {
        let source = `import System.Linq
import System.Collections.Generic

func Empty[T]() IEnumerable[T] {
    return Enumerable.Empty[T]()
}

var seq = Empty[string]()
var count = 0
for v in seq {
    count = count + 1
}
Console.WriteLine(count)`
        Assert.Equal("0${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func ArrayEmpty_With_OpenT_Returns_SliceOfT() {
        let source = `class Sequences {
    shared {
        func Empty[T]() []T {
            return Array.Empty[T]()
        }
    }
}

var arr = Sequences.Empty[int32]()
Console.WriteLine(arr.Length)`
        Assert.Equal("0${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func ToArray_On_OpenT_Slice_Returns_SliceOfT() {
        let source = `import System.Linq

func MakeEmpty[T]() []T {
    return []T{}.ToArray()
}

var arr = MakeEmpty[int32]()
Console.WriteLine(arr.Length)
var arrS = MakeEmpty[string]()
Console.WriteLine(arrS.Length)`
        Assert.Equal("0${Environment.NewLine}0${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func EnumerableRepeat_With_OpenT_Roundtrips_Value() {
        let source = `import System.Linq
import System.Collections.Generic

func Repeat[T](v T, n int32) IEnumerable[T] {
    return Enumerable.Repeat[T](v, n)
}

var seq = Repeat[int32](42, 3)
for v in seq {
    Console.WriteLine(v)
}`
        Assert.Equal("42${Environment.NewLine}42${Environment.NewLine}42${Environment.NewLine}", RunSubmission(source))
    }

    @Fact
    func EnumerableEmpty_Inside_Generic_Extension_Method_Roundtrips() {
        let source = `import System.Linq
import System.Collections.Generic

func (self []T) ReplaceWithEmpty[T]() IEnumerable[T] {
    return Enumerable.Empty[T]()
}

var arr = []int32{1, 2, 3}
var seq = arr.ReplaceWithEmpty()
var count = 0
for v in seq {
    count = count + 1
}
Console.WriteLine(count)`
        Assert.Equal("0${Environment.NewLine}", RunSubmission(source))
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
