// <copyright file="Issue2993StructLiteralConstructionTests.cs" company="GSharp">
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
import Xunit

/// Issues #2993 and #2996: class literals must run construction before applying
/// their explicit member initializers.
open class Issue2993StructLiteralConstructionTests {
    @Fact
    func ClassLiteral_RunsConstructorBeforeExplicitInitializers() {
        const Source = `import System

class Counter {
    prop N int32 { get; init; }
    prop M int32 { get; set; }

    init() {
        Console.WriteLine("ctor-ran")
        N = 7
        M = 9
    }
}

var c = Counter{ M: 1 }
Console.WriteLine(c.N)
Console.WriteLine(c.M)`
        Assert.Equal("ctor-ran${Environment.NewLine}7${Environment.NewLine}1${Environment.NewLine}", Evaluate(Source))
    }

    @Fact
    func ClassLiteral_PreservesConstructorInitializedCollection() {
        const Source = `import System
import System.Collections.Generic

class Bag {
    prop Items IList[int32] { get; init; }

    init() {
        Items = List[int32]()
    }
}

var b = Bag{ Items: {} }
Console.WriteLine(b.Items.Count)`
        Assert.Equal("0${Environment.NewLine}", Evaluate(Source))
    }

    @Fact
    func ClassLiteral_AllocatesImportedBaseBacking() {
        const Source = `import System
import System.IO

class Buffer : MemoryStream {
    func Describe(label string) string {
        return label
    }
}

var b = Buffer{}
Console.WriteLine(b.CanRead)`
        Assert.Equal("True${Environment.NewLine}", Evaluate(Source))
    }

    @Fact
    func ClassLiteral_WithPrimaryConstructor_AllocatesImportedBaseBacking() {
        const Source = `import System
import System.IO

class Buffer(Label string) : MemoryStream {
}

var b = Buffer{ Label: "primary" }
Console.WriteLine(b.CanRead)`
        Assert.Equal("True${Environment.NewLine}", Evaluate(Source))
    }

    shared {
        private func Evaluate(source string) string {
            let result = EmittedOracle.Evaluate(source)
            let errors = result.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError).ToArray()
            Assert.True(
                errors.Length == 0,
                "evaluation failed:\n" + string.Join(
                    "\n",
                    errors.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString())
                )
            )
            return result.Output.ReplaceLineEndings(Environment.NewLine)
        }
    }
}
