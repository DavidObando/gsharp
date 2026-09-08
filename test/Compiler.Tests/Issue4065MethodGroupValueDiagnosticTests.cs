// <copyright file="Issue4065MethodGroupValueDiagnosticTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>Emit-path regressions for issue #4065.</summary>
public sealed class Issue4065MethodGroupValueDiagnosticTests
{
    [Fact]
    public void OriginalRepro_StopsAtPublicDiagnosticBeforeEmit()
    {
        var result = Emit(
            """
            package Demo
            import System
            import System.Collections.Generic

            func main2() {
                let values = List[int32]()
                Console.WriteLine(values.Add.ToString())
            }

            main2()
            """);

        var diagnostic = Assert.Single(result.Diagnostics.Where(item => item.IsError));
        Assert.Equal("GS0582", diagnostic.Id);
        Assert.Equal("Add", diagnostic.Location.Text!.ToString(diagnostic.Location.Span));
        Assert.DoesNotContain(result.Diagnostics, item => item.Id == "GS9998");
    }

    [Fact]
    public void CallsAndTargetTypedMethodGroups_EmitSuccessfully()
    {
        var result = Emit(
            """
            package Demo
            import System
            import System.Collections.Generic
            import System.Linq

            func Use(action Action[int32]) {
                action.Invoke(3)
            }

            func Pick(values List[int32]) Action[int32] {
                return values.Add
            }

            func main2() {
                let values = List[int32]()
                values.Add(1)
                Use(values.Add)
                let add Action[int32] = values.Add
                add.Invoke(4)
                let selected Action[int32] = true ? values.Add : values.Add
                selected.Invoke(5)

                let maybeValues List[int32]? = values
                let count Func[int32] = maybeValues.Count
                Console.WriteLine(maybeValues.Count())
                Console.WriteLine(count.Invoke())
                Pick(values).Invoke(6)
                Console.WriteLine(values.Count)
            }

            main2()
            """);

        Assert.Empty(result.Diagnostics);
        Assert.True(result.Success);
    }

    private static EmitResult Emit(string source)
    {
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source)));
        using var output = new MemoryStream();
        return compilation.Emit(output);
    }
}
