// <copyright file="ImportedTypeInteropTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Interpreter
import System
import System.IO
import Xunit

/// End-to-end tests that exercise interop with imported .NET types: importing a
/// namespace, calling a static factory method that returns a non-primitive .NET
/// type, calling an instance method on that value, and converting it to string
/// via `ToString()` (the legacy `string(T)` builtin cast was retired
/// by #3246).
open class ImportedTypeInteropTests {
    @Fact
    func Can_Call_Static_Method_Returning_Imported_Type() {
        let output = RunSubmission("import System\n" + "var x = Guid.NewGuid()\n" + "x\n")
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain("Unable to find", output)
        // A Guid round-trips through ToString as 32 hex chars with 4 dashes.
        Assert.Matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", output)
    }

    @Fact
    func Can_Call_Instance_Method_On_Imported_Type_Value() {
        let output = RunSubmission("import System\n" + "var x = Guid.NewGuid()\n" + "var y = x.ToString()\n" + "y\n")
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain("Unable to find", output)
        Assert.Matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", output)
    }

    @Fact
    func Can_Chain_Static_And_Instance_Method_Calls() {
        let output = RunSubmission("import System\n" + "var x = Guid.NewGuid().ToString()\n" + "x\n")
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain("Unable to find", output)
        Assert.Matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", output)
    }

    @Fact
    func Can_Chain_Multiple_Instance_Calls() {
        let output = RunSubmission("import System\n" + "var x = Guid.NewGuid().ToString().ToUpper()\n" + "x\n")
        Assert.DoesNotContain("ERROR", output, StringComparison.OrdinalIgnoreCase)
        Assert.DoesNotContain("Unable to find", output)
        Assert.Matches("[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}", output)
    }

    shared {
        private func RunSubmission(text string) string {
            using let outWriter = StringWriter()
            using let errWriter = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(outWriter)
            Console.SetError(errWriter)
            try {
                let repl = GSharpRepl()
                repl.EvaluateSubmission(text)
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return outWriter.ToString() + errWriter.ToString()
        }
    }
}
