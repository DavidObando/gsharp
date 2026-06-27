// <copyright file="Issue1232ConstShiftFoldingEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #1232: compile-time constant folding of <c>&lt;&lt;</c>/<c>&gt;&gt;</c>
/// must match the C#/CLR runtime shift semantics the same change aligned the
/// emitter to (bare <c>shl</c>/<c>shr</c>, i.e. the count is masked by the LEFT
/// operand's width — 32-bit types mask the count with 0x1F, 64-bit types with
/// 0x3F — and right-shift uses the operand's actual signedness). These
/// end-to-end emit+run tests prove the folded compile-time values equal what C#
/// produces at runtime, rather than the previous Int64-only fold that masked
/// every shift count with 0x3F and lost the operand width.
/// </summary>
public class Issue1232ConstShiftFoldingEmitTests
{
    [Fact]
    public void Int32ConstShiftLeft_CountExceeds32_MasksWith0x1F()
    {
        // C#: `(int)(1 << 33)` == `1 << (33 & 0x1F)` == `1 << 1` == 2.
        // The old Int64 fold produced `1L << 33` == 8589934592 (masked 0x3F).
        const string Source = @"package P
class C {
    shared {
        const X int32 = 1 << 33
    }
}
func main() int32 {
    return C.X
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(Int32ConstShiftLeft_CountExceeds32_MasksWith0x1F));
        try
        {
            Assert.Equal(2, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void Int64ConstShiftLeft_CountExceeds64_MasksWith0x3F()
    {
        // C#: `1L << 100` == `1L << (100 & 0x3F)` == `1L << 36` == 68719476736.
        const string Source = @"package P
class C {
    shared {
        const X int64 = 1L << 100
    }
}
func main() int64 {
    return C.X
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(Int64ConstShiftLeft_CountExceeds64_MasksWith0x3F));
        try
        {
            Assert.Equal(68719476736L, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void UInt32ConstShiftRight_LogicalShift_FoldsToCorrectValue()
    {
        // C#: `0xFFFFFFFFu >> 1` (logical) == 0x7FFFFFFF == 2147483647.
        const string Source = @"package P
class C {
    shared {
        const X uint32 = 0xFFFFFFFFu >> 1
    }
}
func main() uint32 {
    return C.X
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(UInt32ConstShiftRight_LogicalShift_FoldsToCorrectValue));
        try
        {
            Assert.Equal(0x7FFFFFFFu, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void UInt64ConstShiftRight_LogicalShift_FoldsToCorrectValue()
    {
        // C#: `0xFFFFFFFFFFFFFFFFul >> 1` (logical) == 0x7FFFFFFFFFFFFFFF.
        const string Source = @"package P
class C {
    shared {
        const X uint64 = 0xFFFFFFFFFFFFFFFFul >> 1
    }
}
func main() uint64 {
    return C.X
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(UInt64ConstShiftRight_LogicalShift_FoldsToCorrectValue));
        try
        {
            Assert.Equal(0x7FFFFFFFFFFFFFFFUL, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void Int32ConstShiftRight_NegativeArithmetic_MasksWith0x1F()
    {
        // C#: `(int)(-8 >> 33)` == `-8 >> (33 & 0x1F)` == `-8 >> 1` == -4
        // (arithmetic, sign-extending). The old Int64 fold produced
        // `-8L >> 33` == -1.
        const string Source = @"package P
class C {
    shared {
        const X int32 = -8 >> 33
    }
}
func main() int32 {
    return C.X
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(Int32ConstShiftRight_NegativeArithmetic_MasksWith0x1F));
        try
        {
            Assert.Equal(-4, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    private static (Assembly asm, AssemblyLoadContext ctx) CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        var asm = loadContext.LoadFromStream(peStream);
        return (asm, loadContext);
    }

    private static MethodInfo GetProgramMethod(Assembly asm, string name)
    {
        var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(programType);
        var method = programType!.GetMethod(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!;
    }
}
