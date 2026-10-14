// <copyright file="Issue1232ConstShiftFoldingEmitTests.cs" company="GSharp">
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

/// Issue #1232: compile-time constant folding of `<<`/`>>`
/// must match the C#/CLR runtime shift semantics the same change aligned the
/// emitter to (bare `shl`/`shr`, i.e. the count is masked by the LEFT
/// operand's width — 32-bit types mask the count with 0x1F, 64-bit types with
/// 0x3F — and right-shift uses the operand's actual signedness). These
/// end-to-end emit+run tests prove the folded compile-time values equal what C#
/// produces at runtime, rather than the previous Int64-only fold that masked
/// every shift count with 0x3F and lost the operand width.
open class Issue1232ConstShiftFoldingEmitTests {
    @Fact
    func Int32ConstShiftLeft_CountExceeds32_MasksWith0x1F() {
        // C#: `(int)(1 << 33)` == `1 << (33 & 0x1F)` == `1 << 1` == 2.
        // The old Int64 fold produced `1L << 33` == 8589934592 (masked 0x3F).
        const Source = `package P
class C {
    shared {
        const X int32 = 1 << 33
    }
}
func main() int32 {
    return C.X
}
`
        let (asm, ctx) = CompileToAssembly(Source, "Int32ConstShiftLeft_CountExceeds32_MasksWith0x1F")
        try {
            Assert.Equal(2, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func Int64ConstShiftLeft_CountExceeds64_MasksWith0x3F() {
        // C#: `1L << 100` == `1L << (100 & 0x3F)` == `1L << 36` == 68719476736.
        const Source = `package P
class C {
    shared {
        const X int64 = 1L << 100
    }
}
func main() int64 {
    return C.X
}
`
        let (asm, ctx) = CompileToAssembly(Source, "Int64ConstShiftLeft_CountExceeds64_MasksWith0x3F")
        try {
            Assert.Equal(68719476736L, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func UInt32ConstShiftRight_LogicalShift_FoldsToCorrectValue() {
        // C#: `0xFFFFFFFFu >> 1` (logical) == 0x7FFFFFFF == 2147483647.
        const Source = `package P
class C {
    shared {
        const X uint32 = 0xFFFFFFFFu >> 1
    }
}
func main() uint32 {
    return C.X
}
`
        let (asm, ctx) = CompileToAssembly(Source, "UInt32ConstShiftRight_LogicalShift_FoldsToCorrectValue")
        try {
            Assert.Equal(0x7FFFFFFFu, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func UInt64ConstShiftRight_LogicalShift_FoldsToCorrectValue() {
        // C#: `0xFFFFFFFFFFFFFFFFul >> 1` (logical) == 0x7FFFFFFFFFFFFFFF.
        const Source = `package P
class C {
    shared {
        const X uint64 = 0xFFFFFFFFFFFFFFFFul >> 1
    }
}
func main() uint64 {
    return C.X
}
`
        let (asm, ctx) = CompileToAssembly(Source, "UInt64ConstShiftRight_LogicalShift_FoldsToCorrectValue")
        try {
            Assert.Equal(0x7FFFFFFFFFFFFFFFUL, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
    }

    @Fact
    func Int32ConstShiftRight_NegativeArithmetic_MasksWith0x1F() {
        // C#: `(int)(-8 >> 33)` == `-8 >> (33 & 0x1F)` == `-8 >> 1` == -4
        // (arithmetic, sign-extending). The old Int64 fold produced
        // `-8L >> 33` == -1.
        const Source = `package P
class C {
    shared {
        const X int32 = -8 >> 33
    }
}
func main() int32 {
    return C.X
}
`
        let (asm, ctx) = CompileToAssembly(Source, "Int32ConstShiftRight_NegativeArithmetic_MasksWith0x1F")
        try {
            Assert.Equal(-4, GetProgramMethod(asm, "main").Invoke(nil, nil))
        } finally {
            ctx.Unload()
        }
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
