// <copyright file="Issue656InitAsPrimaryCtorBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import Xunit

/// Issue #656 — binder-level tests confirming that the binder identifies the
/// correct "primary ctor" symbol for each constructor configuration. Validates
/// that `func init(...)` is recognized as a constructor (not a method) and
/// that (cref:StructSymbol.ExplicitConstructor) is populated correctly.
open class Issue656InitAsPrimaryCtorBinderTests {
    @Fact
    func BareInit_Parameterless_SetsExplicitConstructor() {
        let source = `
class Counter {
    var Value int32
    init() {
        Value = 0
    }
}

var c = Counter()
`
        let (diagnostics, structs) = EvaluateAndGetStructs(source)
        Assert.Empty(diagnostics)
        let counter = structs.Single((s StructSymbol) -> s.Name == "Counter")
        Assert.NotNull(counter.ExplicitConstructor)
        Assert.Empty(counter.ExplicitConstructor!!.Parameters)
    }

    @Fact
    func FuncInit_Parameterless_SetsExplicitConstructor() {
        // `func init()` should be treated identically to bare `init()`
        let source = `
class Counter {
    var Value int32
    func init() {
        Value = 0
    }
}

var c = Counter()
`
        let (diagnostics, structs) = EvaluateAndGetStructs(source)
        Assert.Empty(diagnostics)
        let counter = structs.Single((s StructSymbol) -> s.Name == "Counter")
        Assert.NotNull(counter.ExplicitConstructor)
        Assert.Empty(counter.ExplicitConstructor!!.Parameters)
    }

    @Fact
    func FuncInit_WithParameters_SetsExplicitConstructor() {
        let source = `
class Greeting {
    var Message string
    func init(name string) {
        Message = name
    }
}

var g = Greeting("hi")
`
        let (diagnostics, structs) = EvaluateAndGetStructs(source)
        Assert.Empty(diagnostics)
        let greeting = structs.Single((s StructSymbol) -> s.Name == "Greeting")
        Assert.NotNull(greeting.ExplicitConstructor)
        Assert.Single(greeting.ExplicitConstructor!!.Parameters)
        Assert.Equal("name", greeting.ExplicitConstructor!!.Parameters[0].Name)
    }

    @Fact
    func MultipleInits_SetsExplicitConstructors() {
        let source = `
class Color {
    var R int32
    var G int32
    var B int32
    init(r int32, g int32, b int32) {
        R = r
        G = g
        B = b
    }
    init(gray int32) {
        R = gray
        G = gray
        B = gray
    }
}

var c = Color(1, 2, 3)
`
        let (diagnostics, structs) = EvaluateAndGetStructs(source)
        Assert.Empty(diagnostics)
        let color = structs.Single((s StructSymbol) -> s.Name == "Color")
        Assert.NotNull(color.ExplicitConstructor)
        Assert.Equal(2, color.ExplicitConstructors.Length)
        Assert.Equal(3, color.ExplicitConstructors[0].Parameters.Length)
        Assert.Single(color.ExplicitConstructors[1].Parameters)
    }

    @Fact
    func FuncInit_WithDefaultFields_BindsCleanly() {
        let source = `
class Config {
    var Name string = "default"
    var Count int32
    func init() {
        Count = 7
    }
}

var cfg = Config()
`
        let (diagnostics, structs) = EvaluateAndGetStructs(source)
        Assert.Empty(diagnostics)
        let config = structs.Single((s StructSymbol) -> s.Name == "Config")
        Assert.NotNull(config.ExplicitConstructor)
        Assert.False(config.HasPrimaryConstructor)
    }

    @Fact
    func PrimaryCtorAndFuncInit_BothInitializersAvailable() {
        // ADR-0065 §5: primary ctor + explicit `func init(age int32)` with
        // distinct signatures coexist; both are designated initializers.
        let source = `
class Dual(Name string) {
    var Age int32
    func init(age int32) {
        Age = age
    }
}

var d = Dual("x")
`
        let (diagnostics, structs) = EvaluateAndGetStructs(source)
        Assert.Empty(diagnostics)
        let dual = structs.Single((s StructSymbol) -> s.Name == "Dual")
        Assert.True(dual.HasPrimaryConstructor)
        Assert.Equal(2, dual.ExplicitConstructors.Length)
        Assert.True(dual.ExplicitConstructors[0].IsSynthesizedFromPrimaryConstructor)
        Assert.False(dual.ExplicitConstructors[1].IsSynthesizedFromPrimaryConstructor)
    }

    @Fact
    func NoInit_NoPrimaryCtor_HasNoExplicitConstructor() {
        let source = `
class Plain {
    var Value int32
}

var p = Plain()
`
        let (diagnostics, structs) = EvaluateAndGetStructs(source)
        Assert.Empty(diagnostics)
        let plain = structs.Single((s StructSymbol) -> s.Name == "Plain")
        Assert.Null(plain.ExplicitConstructor)
        Assert.False(plain.HasPrimaryConstructor)
    }

    @Fact
    func PrimaryCtor_Only_HasPrimaryConstructor() {
        let source = `
class Box(Value int32) { }

var b = Box(42)
`
        let (diagnostics, structs) = EvaluateAndGetStructs(source)
        Assert.Empty(diagnostics)
        let box = structs.Single((s StructSymbol) -> s.Name == "Box")
        Assert.Null(box.ExplicitConstructor)
        Assert.True(box.HasPrimaryConstructor)
    }

    shared {
        // Binder-inspection helper (issue #3176 Phase 3b.2): bind via
        // EmittedOracle.CompileDiagnostics and inspect this Compilation's bound
        // state; nothing needs to run.
        private func EvaluateAndGetStructs(source string)(
            Diagnostics ImmutableArray[Diagnostic],
            Structs IEnumerable[StructSymbol]
        ) {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let diagnostics = EmittedOracle.CompileDiagnostics(compilation)
            let structs = compilation.GlobalScope.Structs
            return (diagnostics, structs)
        }
    }
}
