// <copyright file="ManagedReferenceInitializationPlanReviewTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Tests
import Gsharp.Concurrency
import Gsharp.Values
import System
import System.IO
import Xunit

class ManagedReferenceInitializationPlanReviewTests {
    @Fact
    func PlannedPrimaryExplicitAndConvenienceConstructorsDiscoverGoStatements() {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(GoSource + `
func Main() { Console.WriteLine(Probe.Run()) }
`, "PlannedConstructorGo", executable: true)
        IlVerifier.Verify(dll)
        Assert.Equal("6\n", fixture.Run(dll))
    }

    @Theory
    @InlineData(`package PlannedConstructorGo
import System
class Primary {
    var Result chan[int32] = {
        var value = 1
        let saved = managed(value)
        let result = chan[int32](1)
        go func () { result <- *saved }()
        result
    }
}
class Explicit {
    var Result chan[int32] = chan[int32](1)
    init() {
        var value = 2
        let saved = managed(value)
        go func () { Result <- *saved }()
    }
}
class Convenience {
    var Result chan[int32] = chan[int32](1)
    init(marker int32) { }
    convenience init() {
        init(0)
        var value = 3
        let saved = managed(value)
        go func () { Result <- *saved }()
    }
}
class Probe {
    shared {
        func Run() int32 {
            let primary = Primary()
            let explicit = Explicit()
            let convenience = Convenience()
            return <-primary.Result + <-explicit.Result + <-convenience.Result
        }
    }
}`, int32(0), false)
    @InlineData(`package MixedConstructorInitializers
class Holder {
    var Reader () -> int32 = func () int32 { return 40 }
    init(marker int32) { }
    convenience init() {
        init(0)
        var value = 1
        let saved = managed(value)
    }
    shared {
        var StaticReader () -> int32 = func () int32 { return 2 }
    }
}
class Probe {
    shared {
        func Run() int32 { return Holder(1).Reader() + Holder.StaticReader() }
    }
}`, int32(42), true)
    @InlineData(`package MixedConstructorInitializers
struct Holder[T](Value T) {
    public let Copy T = Value
}
class Probe {
    shared {
        func Run() int32 { return Holder[int32](42).Copy }
    }
}`, int32(42), true)
    func InitializationPlansRemainCompleteAcrossRepeatedEmitAndRefout(source string, expected int32, execute bool) {
        using let references = ReferenceResolver.WithRuntimeReferences(
            []string{typeof(ManagedRef[_]).Assembly.Location, typeof(Chan[_]).Assembly.Location}
        )
        let compilation = Compilation(references, SyntaxTree.Parse(source)){IsLibrary = true}
        Assert.Empty(compilation.BoundProgram.Diagnostics)
        for refout in[]bool{false, true} {
            using let pe = MemoryStream()
            using let reference = MemoryStream()
            let result = compilation.Emit(
                pe,
                nil,
                if refout {
                    reference
                } else {
                    default(MemoryStream?)
                }
            )
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
            if execute {
                let assembly = EmittedFixture.Load(pe.ToArray())
                Assert.Equal(
                    expected,
                    assembly.GetType("MixedConstructorInitializers.Probe")!!.GetMethod("Run")!!.Invoke(nil, nil)
                )
            }
            if refout {
                Assert.True(reference.Length > int64(0))
            }
        }
    }

    shared {
        private const GoSource string = `package PlannedConstructorGo
import System
class Primary {
    var Result chan[int32] = {
        var value = 1
        let saved = managed(value)
        let result = chan[int32](1)
        go func () { result <- *saved }()
        result
    }
}
class Explicit {
    var Result chan[int32] = chan[int32](1)
    init() {
        var value = 2
        let saved = managed(value)
        go func () { Result <- *saved }()
    }
}
class Convenience {
    var Result chan[int32] = chan[int32](1)
    init(marker int32) { }
    convenience init() {
        init(0)
        var value = 3
        let saved = managed(value)
        go func () { Result <- *saved }()
    }
}
class Probe {
    shared {
        func Run() int32 {
            let primary = Primary()
            let explicit = Explicit()
            let convenience = Convenience()
            return <-primary.Result + <-explicit.Result + <-convenience.Result
        }
    }
}`

        private const LambdaSource string = `package MixedConstructorInitializers
class Holder {
    var Reader () -> int32 = func () int32 { return 40 }
    init(marker int32) { }
    convenience init() {
        init(0)
        var value = 1
        let saved = managed(value)
    }
    shared {
        var StaticReader () -> int32 = func () int32 { return 2 }
    }
}
class Probe {
    shared {
        func Run() int32 { return Holder(1).Reader() + Holder.StaticReader() }
    }
}`

        private const ValuePrimarySource string = `package MixedConstructorInitializers
struct Holder[T](Value T) {
    public let Copy T = Value
}
class Probe {
    shared {
        func Run() int32 { return Holder[int32](42).Copy }
    }
}`
    }
}
