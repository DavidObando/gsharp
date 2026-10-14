// <copyright file="Issue1193ConstFoldingOverConstFieldsEmitTests.cs" company="GSharp">
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

/// Issue #1193: a `const` whose initializer is a constant expression built
/// from other `const` fields (integer arithmetic, string concatenation)
/// must constant-fold and qualify as a compile-time constant rather than being
/// rejected with GS0376. These end-to-end emit+run tests prove the folded values
/// are correct at runtime, including forward references between consts.
open class Issue1193ConstFoldingOverConstFieldsEmitTests {
    @Fact
    func IntegerConstComposedOfOtherConsts_FoldsToCorrectValue() {
        const Source = `package P
class C {
    shared {
        const N int32 = 4
        const M int32 = N + N
    }
}
func main() int32 {
    return C.M
}
`
        let (asm, ctx) = CompileToAssembly(Source, "IntegerConstComposedOfOtherConsts_FoldsToCorrectValue")
        try {
            Assert.Equal(8, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func StringConstConcatenatedFromOtherConst_FoldsToCorrectValue() {
        const Source = `package P
class C {
    shared {
        const JSON string = ".json"
        const AppSettingsFile string = "appsettings" + JSON
    }
}
func getFile() string {
    return C.AppSettingsFile
}
`
        let (asm, ctx) = CompileToAssembly(Source, "StringConstConcatenatedFromOtherConst_FoldsToCorrectValue")
        try {
            Assert.Equal("appsettings.json", GetProgramMethod(asm, "getFile").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ForwardReferenceBetweenConsts_FoldsToCorrectValue() {
        // M references N which is declared AFTER it — folding must be order
        // independent (lazy / fixpoint).
        const Source = `package P
class C {
    shared {
        const M int32 = N + N
        const N int32 = 4
    }
}
func main() int32 {
    return C.M
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ForwardReferenceBetweenConsts_FoldsToCorrectValue")
        try {
            Assert.Equal(8, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ConstReferencingAnotherTypesConstDeclaredLater_FoldsToCorrectValue() {
        // Issue #3896: the #1193 fixpoint above runs once PER TYPE, so a const
        // whose value lives in a type bound LATER never folded and was reported
        // GS0376 — order dependence between types that C# does not have, and
        // that took src/Core (and with it six banked self-migration apps) out.
        // The B-before-A order is the failing one; A-before-B always worked.
        const Source = (`package P
class B {
    shared {
        const Copy string = A.Name
    }
}
class A {
    shared {
        const Name string = "Gsharp.Concurrency.Chan` + "`" + `1"
    }
}
func getName() string {
    return B.Copy
}
`)
        let (asm, ctx) = CompileToAssembly(Source, "ConstReferencingAnotherTypesConstDeclaredLater_FoldsToCorrectValue")
        try {
            Assert.Equal("Gsharp.Concurrency.Chan`1", GetProgramMethod(asm, "getName").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func ConstChainAcrossThreeTypesInReverseOrder_FoldsToCorrectValue() {
        // The cross-type retry must be a FIXPOINT, not a single extra pass: C
        // needs B, which needs A, and all three are declared innermost-last.
        const Source = `package P
class C {
    shared {
        const Value int32 = B.Value + 1
    }
}
class B {
    shared {
        const Value int32 = A.Value + 1
    }
}
class A {
    shared {
        const Value int32 = 40
    }
}
func total() int32 {
    return C.Value
}
`
        let (asm, ctx) = CompileToAssembly(Source, "ConstChainAcrossThreeTypesInReverseOrder_FoldsToCorrectValue")
        try {
            Assert.Equal(42, GetProgramMethod(asm, "total").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func GenuinelyNonConstantInitializer_StillReportsGS0376() {
        // Anti-vacuity: deferring the report to the compilation-wide pass must
        // not lose it. A call result is not a constant in any pass order.
        const Source = `package P
import System
class Q {
    shared {
        const Bad string = Guid.NewGuid().ToString()
    }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(Source))
        let compilation = Compilation(tree)
        using let peStream = MemoryStream()
        let result = compilation.Emit(peStream)
        Assert.False(result.Success)
        Assert.Contains(
            result.Diagnostics,
            (d Diagnostic) -> d.Id == "GS0376" && d.Message.Contains("Bad", StringComparison.Ordinal)
        )
    }

    shared {
        private func CompileToAssembly(source string, contextName string)(asm Assembly, ctx AssemblyLoadContext) {
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
