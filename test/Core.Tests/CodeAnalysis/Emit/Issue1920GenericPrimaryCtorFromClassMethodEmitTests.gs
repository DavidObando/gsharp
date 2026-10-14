// <copyright file="Issue1920GenericPrimaryCtorFromClassMethodEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #1920: a GENERIC class (or `data struct`) with a primary
/// constructor ICEd at every instantiation with GS9998
/// (`InvalidOperationException: Type '...' has no emitted primary ctor.`)
/// whenever the construction happened from inside another type's method (a
/// `shared`/static method or an instance method) rather than a top-level
/// `func`. Root cause:
/// (cref:GSharp.Core.CodeAnalysis.Emit.ReflectionMetadataEmitter.ResolveUserCtorTokenForPrimary)
/// looked up `ClassPrimaryCtorHandles` keyed by the CONSTRUCTED
/// `StructSymbol` instead of falling back to its open
/// `Definition` — the alias that mirrors the definition's handle onto a
/// specific constructed instantiation
/// (`MethodBodyPlanner.RegisterConstructedTypeAliases`) is only
/// populated for constructions reachable from top-level function/lambda
/// bodies, so any construction from within a class method never gets an
/// alias entry and the lookup failed. These end-to-end emit+run tests prove
/// the primary ctor executes at runtime for constrained, unconstrained,
/// struct-kind, and multi-type-parameter generic types, all invoked from a
/// class's `shared` method (the exact shape that reproduced the ICE).
open class Issue1920GenericPrimaryCtorFromClassMethodEmitTests {
    @Fact
    func ClassConstrainedTypeParameter_ConstructsFromSharedMethod_ReadsField() {
        const Source = `package P
class RefKeeper[T class](_kept T, _tag int32) {
    func Kept() T { return _kept }
    func Tag() int32 { return _tag }
}
class Fixture {
    shared {
        func Run() int32 {
            let keeper = RefKeeper[string]("pinned", 7)
            return keeper.Tag()
        }
    }
}
func main() int32 {
    return Fixture.Run()
}
`
        Assert.Equal(7, RunMain(Source))
    }

    @Fact
    func StructConstrainedTypeParameter_ConstructsFromSharedMethod_ReadsField() {
        const Source = `package P
class ValueCell[T struct](_value T, _tag int32) {
    func Value() T { return _value }
    func Tag() int32 { return _tag }
}
class Fixture {
    shared {
        func Run() int32 {
            let cell = ValueCell[int32](64, 9)
            return cell.Value() + cell.Tag()
        }
    }
}
func main() int32 {
    return Fixture.Run()
}
`
        Assert.Equal(73, RunMain(Source))
    }

    @Fact
    func UnconstrainedTypeParameter_ConstructsFromSharedMethod_ReadsField() {
        const Source = `package P
class Box[T](_item T) {
    func Item() T { return _item }
}
class Fixture {
    shared {
        func Run() int32 {
            let box = Box[int32](21)
            return box.Item()
        }
    }
}
func main() int32 {
    return Fixture.Run()
}
`
        Assert.Equal(21, RunMain(Source))
    }

    @Fact
    func MultiTypeParameter_ConstructsFromSharedMethod_ReadsBothFields() {
        const Source = `package P
class Pair[A, B](_first A, _second B) {
    func First() A { return _first }
    func Second() B { return _second }
}
class Fixture {
    shared {
        func Run() int32 {
            let pair = Pair[int32, string](5, "five")
            if (pair.Second() == "five") {
                return pair.First()
            }
            return -1
        }
    }
}
func main() int32 {
    return Fixture.Run()
}
`
        Assert.Equal(5, RunMain(Source))
    }

    @Fact
    func DataStructGeneric_ConstructsFromSharedMethod_ReadsField() {
        const Source = `package P
data struct Wrapper[T](Value T) { }
class Fixture {
    shared {
        func Run() int32 {
            let w = Wrapper[int32](99)
            return w.Value
        }
    }
}
func main() int32 {
    return Fixture.Run()
}
`
        Assert.Equal(99, RunMain(Source))
    }

    shared {
        private func RunMain(source string) object? {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(
                "Issue1920GenericPrimaryCtorFromClassMethodEmitTests",
                isCollectible: true
            )
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let method MethodInfo? = programType!!.GetMethod(
                    "main",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(method)
                return method!!.Invoke(nil, nil)
            } finally {
                loadContext.Unload()
            }
        }
    }
}
