// <copyright file="Issue1193ConstFoldingOverConstFieldsEmitTests.cs" company="GSharp">
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
/// Issue #1193: a <c>const</c> whose initializer is a constant expression built
/// from other <c>const</c> fields (integer arithmetic, string concatenation)
/// must constant-fold and qualify as a compile-time constant rather than being
/// rejected with GS0376. These end-to-end emit+run tests prove the folded values
/// are correct at runtime, including forward references between consts.
/// </summary>
public class Issue1193ConstFoldingOverConstFieldsEmitTests
{
    [Fact]
    public void IntegerConstComposedOfOtherConsts_FoldsToCorrectValue()
    {
        const string Source = @"package P
class C {
    shared {
        const N int32 = 4
        const M int32 = N + N
    }
}
func main() int32 {
    return C.M
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(IntegerConstComposedOfOtherConsts_FoldsToCorrectValue));
        try
        {
            Assert.Equal(8, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void StringConstConcatenatedFromOtherConst_FoldsToCorrectValue()
    {
        const string Source = @"package P
class C {
    shared {
        const JSON string = "".json""
        const AppSettingsFile string = ""appsettings"" + JSON
    }
}
func getFile() string {
    return C.AppSettingsFile
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(StringConstConcatenatedFromOtherConst_FoldsToCorrectValue));
        try
        {
            Assert.Equal("appsettings.json", GetProgramMethod(asm, "getFile").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ForwardReferenceBetweenConsts_FoldsToCorrectValue()
    {
        // M references N which is declared AFTER it — folding must be order
        // independent (lazy / fixpoint).
        const string Source = @"package P
class C {
    shared {
        const M int32 = N + N
        const N int32 = 4
    }
}
func main() int32 {
    return C.M
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ForwardReferenceBetweenConsts_FoldsToCorrectValue));
        try
        {
            Assert.Equal(8, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ConstReferencingAnotherTypesConstDeclaredLater_FoldsToCorrectValue()
    {
        // Issue #3896: the #1193 fixpoint above runs once PER TYPE, so a const
        // whose value lives in a type bound LATER never folded and was reported
        // GS0376 — order dependence between types that C# does not have, and
        // that took src/Core (and with it six banked self-migration apps) out.
        // The B-before-A order is the failing one; A-before-B always worked.
        const string Source = @"package P
class B {
    shared {
        const Copy string = A.Name
    }
}
class A {
    shared {
        const Name string = ""Gsharp.Concurrency.Chan`1""
    }
}
func getName() string {
    return B.Copy
}
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ConstReferencingAnotherTypesConstDeclaredLater_FoldsToCorrectValue));
        try
        {
            Assert.Equal("Gsharp.Concurrency.Chan`1", GetProgramMethod(asm, "getName").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ConstChainAcrossThreeTypesInReverseOrder_FoldsToCorrectValue()
    {
        // The cross-type retry must be a FIXPOINT, not a single extra pass: C
        // needs B, which needs A, and all three are declared innermost-last.
        const string Source = @"package P
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
";
        var (asm, ctx) = CompileToAssembly(Source, nameof(ConstChainAcrossThreeTypesInReverseOrder_FoldsToCorrectValue));
        try
        {
            Assert.Equal(42, GetProgramMethod(asm, "total").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void GenuinelyNonConstantInitializer_StillReportsGS0376()
    {
        // Anti-vacuity: deferring the report to the compilation-wide pass must
        // not lose it. A call result is not a constant in any pass order.
        const string Source = @"package P
import System
class Q {
    shared {
        const Bad string = Guid.NewGuid().ToString()
    }
}
";
        var tree = SyntaxTree.Parse(SourceText.From(Source));
        var compilation = new Compilation(tree);
        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0376" && d.Message.Contains("Bad", StringComparison.Ordinal));
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
