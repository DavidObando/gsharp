// <copyright file="Issue750ConstraintOverloadEmittedOracleTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #750: Emitted-oracle coverage for constraint overload.
/// Traceability: ADR-0088.
open class Issue750ConstraintOverloadEmittedOracleTests {
    @Fact
    func OrElse_DisjointConstraints_BindCorrectlyForBothReceiverShapes() {
        let source = `import System
import Gsharp.Extensions.Optional

let s string? = nil
let n int32? = nil

Console.WriteLine(s.OrElse("default"))
Console.WriteLine(n.OrElse(99).ToString())`
        Assert.Equal("default${Environment.NewLine}99${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func OrElse_DisjointConstraints_PresentReceiver_ReturnsValue() {
        let source = `import System
import Gsharp.Extensions.Optional

let s string? = "ada"
let n int32? = 7

Console.WriteLine(s.OrElse("default"))
Console.WriteLine(n.OrElse(99).ToString())`
        Assert.Equal("ada${Environment.NewLine}7${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func FirstOrNil_SequenceTerminals_BindBothClassAndStructOverloads() {
        let source = `import System
import Gsharp.Extensions.Optional
import Gsharp.Extensions.Sequences

let names = Sequences.Of("alpha", "beta")
let nums = Sequences.Of(11, 22, 33)

Console.WriteLine(names.FirstOrNil() ?? "<none>")
Console.WriteLine(nums.FirstOrNil().OrElse(-1).ToString())`
        Assert.Equal("alpha${Environment.NewLine}11${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func LastOrNil_AndSingleOrNil_SequenceTerminals_BindBothOverloads() {
        let source = `import System
import Gsharp.Extensions.Optional
import Gsharp.Extensions.Sequences

let names = Sequences.Of("alpha", "beta")
let nums = Sequences.Of(11, 22, 33)
let solo = Sequences.Of(42)

Console.WriteLine(names.LastOrNil() ?? "<none>")
Console.WriteLine(nums.LastOrNil().OrElse(-1).ToString())
Console.WriteLine(solo.SingleOrNil().OrElse(-1).ToString())`
        Assert.Equal("beta${Environment.NewLine}33${Environment.NewLine}42${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func FlatMap_NullableReturningLambdaWithIf_RunsInEmittedOracle() {
        // Issue #2995: the nullable-returning FlatMap lambda contains the
        // control flow that previously reached the evaluator unlowered.
        let source = `import System
import Gsharp.Extensions.Optional

let name string? = "ada"
let first = name.FlatMap(func(s string) string? {
    if s.Length > 0 {
        return s.Substring(0, 1)
    }
    return nil
})

Console.WriteLine(first ?? "<none>")`
        Assert.Equal("a${Environment.NewLine}", Evaluate(source))
    }

    shared {
        private func Evaluate(source string) string {
            let extPath string? = LocateGsharpExtensionsAssembly()
            if extPath != nil {
                try {
                    Assembly.LoadFrom(extPath)
                } catch { }
            }
            let result = EmittedOracle.Evaluate(source)
            let errors = result.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError).ToList()
            Assert.True(
                errors.Count == 0,
                "evaluation failed:\n" + string.Join(
                    "\n",
                    errors.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString())
                )
            )
            return result.Output.ReplaceLineEndings(Environment.NewLine)
        }

        private func LocateGsharpExtensionsAssembly() string? {
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(Issue750ConstraintOverloadEmittedOracleTests).Assembly.Location)!!
            )
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    for cfg in[]string{"Debug", "Release"} {
                        let candidate = Path.Combine(
                            dir.FullName,
                            "out",
                            "bin",
                            cfg,
                            "Gsharp.Extensions",
                            "Gsharp.Extensions.dll"
                        )
                        if File.Exists(candidate) {
                            return candidate
                        }
                    }
                    return nil
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}
