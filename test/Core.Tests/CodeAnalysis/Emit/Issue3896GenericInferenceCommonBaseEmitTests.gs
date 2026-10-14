// <copyright file="Issue3896GenericInferenceCommonBaseEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #3896: inferring an imported generic method's type argument from
/// several SAME-COMPILATION class arguments fixed the parameter at whichever
/// bound arrived first instead of at their common base.
/// `ImmutableArray.Create(derived, base)` therefore inferred
/// `ImmutableArray[Derived]` and failed to convert (GS0154), while the
/// argument-swapped `Create(base, derived)` inferred
/// `ImmutableArray[Base]` and compiled — an argument-order dependence C#
/// does not have. Imported types were already widened by the CLR-side
/// unification; a same-compilation class is erased to `object` in the
/// closed CLR method, so its bounds only ever meet on the symbolic path.
///
/// These run the emitted code: fixing the parameter at the wrong bound
/// can also produce a silently mistyped array rather than an error.
open class Issue3896GenericInferenceCommonBaseEmitTests {
    @Fact
    func DerivedArgumentBeforeBaseArgument_InfersCommonBase() {
        const Source = `package P
import System.Collections.Immutable

open class Base {
    func tag() int32 { return 1 }
}

class Derived : Base {
}

func count(items ImmutableArray[Base]) int32 {
    return items.Length
}

func run(b Base) int32 {
    return count(ImmutableArray.Create(Derived(), b))
}

func main() int32 {
    return run(Base())
}
`
        let (asm, ctx) = CompileToAssembly(Source, "DerivedArgumentBeforeBaseArgument_InfersCommonBase")
        try {
            Assert.Equal(2, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func InferredElementTypeIsTheBase_NotTheFirstArgumentsType() {
        // The count above would also pass if T were fixed at `Derived` and the
        // conversion silently accepted, so assert the RUNTIME element type of
        // the array the call actually built.
        const Source = `package P
import System.Collections.Immutable

open class Base {
}

class Derived : Base {
}

func build(b Base) ImmutableArray[Base] {
    return ImmutableArray.Create(Derived(), b)
}

func elementTypeName() string {
    let built = build(Base())
    return built.GetType().GetGenericArguments()[0].Name
}
`
        let (asm, ctx) = CompileToAssembly(Source, "InferredElementTypeIsTheBase_NotTheFirstArgumentsType")
        try {
            Assert.Equal("Base", GetProgramMethod(asm, "elementTypeName").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ThreeLevelHierarchy_InfersTheSharedBase() {
        const Source = `package P
import System.Collections.Immutable

open class Root {
}

open class Middle : Root {
}

class Leaf : Middle {
}

func count(items ImmutableArray[Root]) int32 {
    return items.Length
}

func main() int32 {
    return count(ImmutableArray.Create(Leaf(), Middle(), Root()))
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ThreeLevelHierarchy_InfersTheSharedBase")
        try {
            Assert.Equal(3, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func DelegateParameterBound_DoesNotWidenTheReceiverBound() {
        // Precision guard, and the first thing the widening got wrong: a
        // DELEGATE PARAMETER constrains the type argument from above, so it is
        // not a candidate to widen to. `ImmutableArray[Derived].Where(pred)`
        // with `pred : func(Base) bool` must stay `Where[Derived]`. Widening it
        // to `Base` binds cleanly and emits a MethodSpec whose receiver no
        // longer matches it — IL that gsc accepts and ILVerify rejects
        // (StackUnexpected in ReflectionMetadataEmitter, observed on the real
        // corpus). This runs the code, so a mistyped instantiation shows up as
        // a runtime failure rather than only as a verifier complaint.
        const Source = `package P
import System.Collections.Immutable
import System.Linq

open class Base {
}

class Derived : Base {
}

func countKept(items ImmutableArray[Derived]) int32 {
    let keep = func (b Base) bool { return b != nil }
    return items.Where(keep).ToList().Count
}

func main() int32 {
    return countKept(ImmutableArray.Create(Derived(), Derived()))
}
`
        let (asm, ctx) = CompileToAssembly(Source, "DelegateParameterBound_DoesNotWidenTheReceiverBound")
        try {
            Assert.Equal(2, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func UnrelatedClassArguments_StillFailToInfer() {
        // Precision guard: widening must follow a real base-class chain, not
        // collapse any two class bounds onto something that compiles.
        const Source = `package P
import System.Collections.Immutable

class Left {
}

class Right {
}

func count(items ImmutableArray[Left]) int32 {
    return items.Length
}

func main() int32 {
    return count(ImmutableArray.Create(Left(), Right()))
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
    }

    shared {
        private func CompileToAssembly(source string, contextName string)(Asm Assembly, Ctx AssemblyLoadContext) {
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
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            let asm = loadContext.LoadFromStream(peStream)
            return (asm, loadContext)
        }

        private func GetProgramMethod(asm Assembly, name string) MethodInfo {
            let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
            Assert.NotNull(programType)
            let method MethodInfo? = programType!!.GetMethod(
                name,
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
            )
            Assert.NotNull(method)
            return method!!
        }
    }
}
