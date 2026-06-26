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
