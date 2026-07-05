// <copyright file="Issue2130ExpressionTreeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

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
/// Issue #2130: end-to-end emit coverage for lambda-to-expression-tree
/// conversions.
/// </summary>
public class Issue2130ExpressionTreeEmitTests
{
    [Fact]
    public void ExpressionTree_CompilesAndExecutesSimplePropertySelector()
    {
        const string Source = @"package ExprSimple
import System
import System.Linq.Expressions

class Book(Id int32)

func main() int32 {
    let selector Expression[Func[Book, int32]] = (b Book) -> b.Id + 1
    let compiled = selector.Compile()
    return compiled(Book(41))
}
";

        var (asm, ctx) = CompileToAssembly(Source, nameof(ExpressionTree_CompilesAndExecutesSimplePropertySelector));
        try
        {
            Assert.Equal(42, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ExpressionTree_CapturedLocalSeesLatestValueThroughBox()
    {
        const string Source = @"package ExprCapture
import System
import System.Linq.Expressions

func main() int32 {
    var factor = 2
    let expr Expression[Func[int32, int32]] = (x int32) -> x * factor
    factor = 3
    let compiled = expr.Compile()
    return compiled(14)
}
";

        var (asm, ctx) = CompileToAssembly(Source, nameof(ExpressionTree_CapturedLocalSeesLatestValueThroughBox));
        try
        {
            Assert.Equal(42, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ExpressionTree_GenericHelperAcceptsBookSelector()
    {
        const string Source = @"package ExprCallArg
import System
import System.Linq.Expressions

func useSelector(selector Expression[Func[int32, int32]], value int32) int32 {
    let compiled = selector.Compile()
    let result = compiled(value)
    return result
}

func main() int32 {
    let selector Expression[Func[int32, int32]] = (x int32) -> x + 1
    return useSelector(selector, 41)
}
";

        var (asm, ctx) = CompileToAssembly(Source, nameof(ExpressionTree_GenericHelperAcceptsBookSelector));
        try
        {
            Assert.Equal(42, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ExpressionTree_MethodParameter_AcceptsDirectBookLambda()
    {
        const string Source = @"package ExprDirectBookArg
import System
import System.Linq.Expressions

class Book(Id int32)

func selectValue(selector Expression[Func[Book, int32]], value Book) int32 {
    let compiled = selector.Compile()
    return compiled(value)
}

func main() int32 {
    return selectValue((b Book) -> b.Id, Book(42))
}
";

        var (asm, ctx) = CompileToAssembly(Source, nameof(ExpressionTree_MethodParameter_AcceptsDirectBookLambda));
        try
        {
            Assert.Equal(42, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    [Fact]
    public void ExpressionTree_ImportedMethodCalls_AreRepresentedAndExecuted()
    {
        const string Source = @"package ExprImportedCall
import System
import System.Linq.Expressions

func main() int32 {
    let expr Expression[Func[string, int32]] = (s string) -> s.Trim().Length
    let compiled = expr.Compile()
    return compiled(""  hi  "")
}
";

        var (asm, ctx) = CompileToAssembly(Source, nameof(ExpressionTree_ImportedMethodCalls_AreRepresentedAndExecuted));
        try
        {
            Assert.Equal(2, GetProgramMethod(asm, "main").Invoke(null, null));
        }
        finally
        {
            ctx.Unload();
        }
    }

    private static MethodInfo GetProgramMethod(Assembly asm, string name)
    {
        var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
        Assert.NotNull(programType);
        var method = programType!.GetMethod(name, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        Assert.NotNull(method);
        return method!;
    }

    private static (Assembly asm, AssemblyLoadContext ctx) CompileToAssembly(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Emit(peStream);

        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Id + ":" + d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        var asm = loadContext.LoadFromStream(peStream);
        return (asm, loadContext);
    }
}
