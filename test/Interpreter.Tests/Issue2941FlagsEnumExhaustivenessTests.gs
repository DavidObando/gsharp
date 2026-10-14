// <copyright file="Issue2941FlagsEnumExhaustivenessTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import GSharp.Repl.Engine
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import Xunit

/// Issue #2941 emitted-execution coverage for name-complete enum switches
/// across flags annotations, symbol origins, and switch forms.
open class Issue2941FlagsEnumExhaustivenessTests {
    @Fact
    func NameCompleteEnumSwitches_RunWithExactOutput() {
        const Source = `import System

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
Console.WriteLine(plainExpression(Plain.Write))`
        using let output = StringWriter()
        let previousOut = Console.Out
        Console.SetOut(output)
        try {
            let repl = GSharpRepl()
            repl.EvaluateSubmission(Source)
        } finally {
            Console.SetOut(previousOut)
        }
        Assert.Equal(
            "11${Environment.NewLine}22${Environment.NewLine}31${Environment.NewLine}42${Environment.NewLine}51${Environment.NewLine}62${Environment.NewLine}",
            output.ToString().ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func UnmatchedFlagsValue_ReportsRuntimeError() {
        // EmittedOracle preserves the historical uncaught-exception protocol
        // (a GS9999 error diagnostic carrying the exception message), so the
        // assertions survive the evaluator retirement verbatim
        // (ADR-0156 Phase 3c, #3176).
        let result = EmittedOracle.Evaluate(UnmatchedSource)
        let diagnostic = Assert.Single(result.Diagnostics)
        Assert.True(diagnostic.IsError)
        Assert.Equal("GS9999", diagnostic.Id)
        Assert.Equal("Unmatched switch expression value.", diagnostic.Message)
    }

    @Fact
    func UnmatchedFlagsValue_PreservesInvalidOperationExceptionType() {
        using let engine = EmittedSessionEngine(default(IReadOnlyList[string])){CaptureConsole = true}
        let result = engine.Evaluate(CatchingUnmatchedSource)
        Assert.False(result.HasError)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(
            "caught-ioe${Environment.NewLine}after${Environment.NewLine}",
            result.Output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    shared {
        private const CatchingUnmatchedSource string = `import System

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
Console.WriteLine("after")`

        private const UnmatchedSource string = `@Flags
enum Access { None = 0, Read = 1, Write = 2 }

func F(x Access) int32 {
    return switch x {
        case Access.None: 0
        case Access.Read: 1
        case Access.Write: 2
    }
}

F(Access.Read | Access.Write)`
    }
}
