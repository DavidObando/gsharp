// <copyright file="Issue2956InterpreterBoundaryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Repl
import System
import System.IO
import Xunit

/// Issue #2956 / ADR-0153 / ADR-0156 Phase 1: script-mode `gsi` executes
/// the compiled storage model natively. The constructs the interpreting driver
/// used to reject with self-contained boundary diagnostics (`fixed`,
/// `stackalloc`, `sizeof` on user structs, function pointers) now
/// compile through the real emitter and run in-process, so each case asserts
/// the construct's observable result instead of a refusal. Since Phase 3c
/// (#3176) the tree-walking evaluator is deleted, so the ADR-0153 boundary is
/// gone everywhere — emitted execution is the only execution.
@Collection("ConsoleIo")
open class Issue2956InterpreterBoundaryTests {
    @Fact
    func FixedArrayPinsAndExecutes() {
        let result = RunGsi("FixedArrayPinsAndExecutes", `import System

unsafe {
    let values = []int32{1, 2}
    fixed p *int32 = values {
        Console.WriteLine(values.Length)
    }
}`)
        AssertRan(result, "2\n")
    }

    @Fact
    func FixedStringPinsAndDereferences() {
        let result = RunGsi("FixedStringPinsAndDereferences", `import System

unsafe {
    fixed p *uint16 = "A" {
        Console.WriteLine(*p)
    }
}`)
        AssertRan(result, "65\n")
    }

    @Fact
    func FixedEmptySpanPinsNil() {
        let result = RunGsi("FixedEmptySpanPinsNil", `import System

unsafe {
    fixed p *int32 = Span[int32].Empty {
        if p == nil {
            Console.WriteLine("empty-span-pins-nil")
        }
    }
}`)
        AssertRan(result, "empty-span-pins-nil\n")
    }

    @Fact
    func StackAllocExecutes() {
        let result = RunGsi("StackAllocExecutes", `import System

func run() int32 {
    let values = stackalloc [2]int32
    return values.Length
}

Console.WriteLine(run())`)
        AssertRan(result, "2\n")
    }

    @Fact
    func SizeOfUserStructExecutes() {
        let result = RunGsi("SizeOfUserStructExecutes", `import System

struct Pair {
    var Left int32
    var Right int32
}

unsafe {
    Console.WriteLine(sizeof(Pair))
}`)
        AssertRan(result, "8\n")
    }

    @Fact
    func FunctionPointerAddressExecutes() {
        let result = RunGsi("FunctionPointerAddressExecutes", `import System

unsafe func identity(value int32) int32 {
    return value
}

unsafe {
    let pointer *func(int32) int32 = &identity
    Console.WriteLine("took-address")
}`)
        AssertRan(result, "took-address\n")
    }

    @Fact
    func FunctionPointerInvocationExecutes() {
        let result = RunGsi("FunctionPointerInvocationExecutes", `import System

unsafe func identity(value int32) int32 {
    return value
}

unsafe {
    let pointer *func(int32) int32 = &identity
    Console.WriteLine(pointer(41) + 1)
}`)
        AssertRan(result, "42\n")
    }

    @Fact
    func FunctionPointerNilComparisonsExecute() {
        let result = RunGsi("FunctionPointerNilComparisonsExecute", `import System

unsafe {
    let pointer *func(int32) int32 = nil
    Console.WriteLine(pointer == nil)
    Console.WriteLine(nil == pointer)
    Console.WriteLine(pointer != nil)
    Console.WriteLine(nil != pointer)
}`)
        AssertRan(result, `True
True
False
False
`)
    }

    @Fact
    func UnsafeBlockWithoutStorageOnlyConstructEvaluatesNormally() {
        let result = RunGsi("UnsafeBlockWithoutStorageOnlyConstructEvaluatesNormally", `import System

unsafe {
    Console.WriteLine(42)
}`)
        AssertRan(result, "42\n")
    }

    shared {
        private func AssertRan(
            result(ExitCode int32, StandardOutput string, StandardError string),
            expectedOutput string
        ) {
            Assert.Equal(0, result.ExitCode)
            Assert.Equal(expectedOutput, result.StandardOutput)
            Assert.Equal(string.Empty, result.StandardError)
        }

        private func RunGsi(name string, source string)(ExitCode int32, StandardOutput string, StandardError string) {
            let directory = Path.Combine(AppContext.BaseDirectory, "Issue2956InterpreterBoundaryTests", name)
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "test.gs")
            File.WriteAllText(sourcePath, source)
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            var exitCode int32
            try {
                Console.SetOut(stdout)
                Console.SetError(stderr)
                exitCode = GSharp.Repl.Program.Main([]string{sourcePath})
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (
                exitCode,
                stdout.ToString().ReplaceLineEndings(Environment.NewLine),
                stderr.ToString().ReplaceLineEndings(Environment.NewLine)
            )
        }
    }
}
