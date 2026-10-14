// <copyright file="Issue1030InterfaceStaticMembersEmittedOracleTests.cs" company="GSharp">
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

/// Issue #1030: Emitted-oracle coverage for interface static members.
/// Traceability: ADR-0089; issue #1019.
open class Issue1030InterfaceStaticMembersEmittedOracleTests {
    @Fact
    func InterfaceStaticState_ReadWrite_And_Const_AreSharedState() {
        let source = `import System

interface ICounter {
    shared {
        var Count int32
        const Max int32 = 100
    }
}

ICounter.Count = ICounter.Count + 7
Console.WriteLine(ICounter.Count)
Console.WriteLine(ICounter.Max)`
        Assert.Equal("7${Environment.NewLine}100${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func InterfaceStaticState_SharedAcrossConstraintDispatch() {
        let source = `import System

sealed interface ICounter {
    shared {
        var Count int32
        func Bump() {
            Count = Count + 1
        }
        func Get() int32 {
            return Count
        }
    }
}

struct C : ICounter {
}

func Run[T ICounter](witness T) int32 {
    T.Bump()
    T.Bump()
    return T.Get()
}

Console.WriteLine(Run(C{}))
Console.WriteLine(ICounter.Count)`
        Assert.Equal("2${Environment.NewLine}2${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func DefaultBodiedStaticProperty_UsesInterfaceDefault() {
        let source = `import System

sealed interface IData {
    shared {
        prop Name string { get { return "default-name" } }
    }
}

struct Apple : IData {
}

func Describe[T IData](witness T) string {
    return T.Name
}

Console.WriteLine(Describe(Apple{}))`
        Assert.Equal("default-name${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func GenericInterfaceStaticState_IndependentStoragePerConstruction() {
        // Issue #1030 (deferred work): a generic interface owns one set of
        // static fields per closed construction, so IBox[int32] and IBox[string]
        // have independent storage. const reads are inlined.
        let source = `import System

interface IBox[T] {
    shared {
        var Count int32
        const Max int32 = 50
    }
}

IBox[int32].Count = IBox[int32].Count + 7
IBox[string].Count = IBox[string].Count + 100
Console.WriteLine(IBox[int32].Count)
Console.WriteLine(IBox[string].Count)
Console.WriteLine(IBox[int32].Max)`
        Assert.Equal("7${Environment.NewLine}100${Environment.NewLine}50${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func GenericInterfaceStaticState_CompoundAssignment() {
        // Issue #1030 (deferred work): compound assignment on a generic
        // interface static field, per construction.
        let source = `import System

interface IBox[T] {
    shared {
        var Count int32
    }
}

IBox[int32].Count += 7
IBox[int32].Count -= 2
IBox[string].Count += 1
Console.WriteLine(IBox[int32].Count)
Console.WriteLine(IBox[string].Count)`
        Assert.Equal("5${Environment.NewLine}1${Environment.NewLine}", Evaluate(source))
    }

    @Fact
    func InterfaceStaticField_CompoundAssignment() {
        // Issue #1030 (deferred work): compound `+=` / `-=` on a non-generic
        // interface static field.
        let source = `import System

interface ICounter {
    shared {
        var Count int32
    }
}

ICounter.Count += 9
ICounter.Count -= 4
Console.WriteLine(ICounter.Count)`
        Assert.Equal("5${Environment.NewLine}", Evaluate(source))
    }

    shared {
        private func Evaluate(source string) string {
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
    }
}
