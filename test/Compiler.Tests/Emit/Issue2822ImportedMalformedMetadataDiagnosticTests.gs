// <copyright file="Issue2822ImportedMalformedMetadataDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import System
import System.IO
import Xunit

/// Issue #2822: malformed imported enumerator metadata reports GS0501.
class Issue2822ImportedMalformedMetadataDiagnosticTests {
    @Fact
    func InheritedImportedReturnTypeOnlyGetEnumeratorPair_ReportsStructuredDiagnostic() {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue2822-artifacts", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let librarySourcePath = Path.Combine(directory, "library.gs")
            let libraryPath = Path.Combine(directory, "Issue2822.Library.dll")
            File.WriteAllText(librarySourcePath, `package Issue2822.Library
import System.Collections
import System.Collections.Generic

open class Broken : IEnumerable[int32] {
    func GetEnumerator() IEnumerator[int32] -> List[int32]().GetEnumerator()
    func GetEnumerator() IEnumerator -> GetEnumerator()
}

class Derived : Broken {}`)
            let libraryResult = RunCompiler(
                []string{"/out:" + libraryPath, "/target:library", "/targetframework:net10.0", librarySourcePath}
            )
            Assert.True(libraryResult.ExitCode == 0, (`library compile failed
` + "${libraryResult.Stdout}" + `
` + "${libraryResult.Stderr}"))
            let consumerSourcePath = Path.Combine(directory, "consumer.gs")
            let consumerPath = Path.Combine(directory, "Issue2822.Consumer.dll")
            File.WriteAllText(consumerSourcePath, `package Issue2822.Consumer
import Issue2822.Library

func Consume(value Derived) {
    for item in value {}
}`)
            let consumerResult = RunCompiler(
                []string{
                    "/out:" + consumerPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/reference:" + libraryPath,
                    consumerSourcePath
                }
            )
            let output = consumerResult.Stdout + consumerResult.Stderr
            Assert.NotEqual(0, consumerResult.ExitCode)
            Assert.Contains("consumer.gs(5,", output, StringComparison.Ordinal)
            Assert.Contains("GS0501", output, StringComparison.Ordinal)
            Assert.Contains("Derived", output, StringComparison.Ordinal)
            Assert.Contains("GetEnumerator", output, StringComparison.Ordinal)
            Assert.DoesNotContain("GS9998", output, StringComparison.Ordinal)
            Assert.DoesNotContain("AmbiguousMatchException", output, StringComparison.Ordinal)
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    @Fact
    func ImportedGenericZeroArgOverload_DoesNotObscureNonGenericEnumerator() {
        let directory = Path.Combine(AppContext.BaseDirectory, "issue2822-artifacts", Guid.NewGuid().ToString("N"))
        Directory.CreateDirectory(directory)
        try {
            let consumerSourcePath = Path.Combine(directory, "consumer.gs")
            let consumerPath = Path.Combine(directory, "Issue2822.Consumer.dll")
            File.WriteAllText(consumerSourcePath, `package Issue2822.Consumer
import GSharp.Compiler.Tests.Emit

func Consume(value Issue2822LegalEnumerable) int32 {
    var total = 0
    for item in value {
        total = total + item
    }
    return total
}`)
            let consumerResult = RunCompiler(
                []string{
                    "/out:" + consumerPath,
                    "/target:library",
                    "/targetframework:net10.0",
                    "/reference:" + typeof(Issue2822LegalEnumerable).Assembly.Location,
                    consumerSourcePath
                }
            )
            Assert.True(consumerResult.ExitCode == 0, (`consumer compile failed
` + "${consumerResult.Stdout}" + `
` + "${consumerResult.Stderr}"))
        } finally {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }

    shared {
        private func RunCompiler(args[]string)(ExitCode int32, Stdout string, Stderr string) {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            try {
                return (Program.Main(args), stdout.ToString(), stderr.ToString())
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
        }
    }
}
