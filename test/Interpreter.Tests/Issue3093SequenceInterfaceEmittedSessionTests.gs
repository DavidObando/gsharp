// <copyright file="Issue3093SequenceInterfaceEmittedSessionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

class Issue3093SequenceInterfaceEmittedSessionTests {
    @Fact
    func IteratorAndExplicitSequence_DispatchThroughInterface() {
        const Source = `import System.Collections.Generic

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
}`
        Assert.Equal("3${Environment.NewLine}3${Environment.NewLine}", RunSubmission(Source))
    }

    @Fact
    func GenericIterator_DispatchesThroughInterface() {
        const Source = `import System.Collections.Generic

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
}`
        Assert.Equal("3${Environment.NewLine}", RunSubmission(Source))
    }

    shared {
        private func RunSubmission(source string) string {
            using let output = StringWriter()
            let previousOut = Console.Out
            Console.SetOut(output)
            try {
                GSharpRepl().EvaluateSubmission(source)
            } finally {
                Console.SetOut(previousOut)
            }
            return output.ToString().ReplaceLineEndings(Environment.NewLine)
        }
    }
}
