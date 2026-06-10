// <copyright file="Issue662ValueTaskGetResultWarningTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #662: warn when calling .GetAwaiter().GetResult() directly on a
/// ValueTask or ValueTask&lt;T&gt;.
/// </summary>
public class Issue662ValueTaskGetResultWarningTests
{
    [Fact]
    public void GetAwaiter_GetResult_On_ValueTask_Of_Bool_Warns_GS0275()
    {
        var source = """
            import System.Threading.Tasks

            let vt = ValueTask[bool](true)
            let r = vt.GetAwaiter().GetResult()
            """;

        var diags = BindAndGetDiagnostics(source);
        Assert.Contains(diags, d => d.Id == "GS0275");
    }

    [Fact]
    public void GetAwaiter_GetResult_On_NonGeneric_ValueTask_Warns_GS0275()
    {
        var source = """
            import System.Threading.Tasks

            let vt = ValueTask(Task.CompletedTask)
            vt.GetAwaiter().GetResult()
            """;

        var diags = BindAndGetDiagnostics(source);
        Assert.Contains(diags, d => d.Id == "GS0275");
    }

    [Fact]
    public void AsTask_GetAwaiter_GetResult_On_ValueTask_Does_Not_Warn()
    {
        var source = """
            import System.Threading.Tasks

            let vt = ValueTask[bool](true)
            let r = vt.AsTask().GetAwaiter().GetResult()
            """;

        var diags = BindAndGetDiagnostics(source);
        Assert.DoesNotContain(diags, d => d.Id == "GS0275");
    }

    [Fact]
    public void GetAwaiter_GetResult_On_Task_Of_T_Does_Not_Warn()
    {
        var source = """
            import System.Threading.Tasks

            let t = Task.FromResult(42)
            let r = t.GetAwaiter().GetResult()
            """;

        var diags = BindAndGetDiagnostics(source);
        Assert.DoesNotContain(diags, d => d.Id == "GS0275");
    }

    [Fact]
    public void GetAwaiter_GetResult_On_Task_Does_Not_Warn()
    {
        var source = """
            import System.Threading.Tasks

            let t = Task.CompletedTask
            t.GetAwaiter().GetResult()
            """;

        var diags = BindAndGetDiagnostics(source);
        Assert.DoesNotContain(diags, d => d.Id == "GS0275");
    }

    [Fact]
    public void ValueTask_Captured_In_Local_Then_GetAwaiter_GetResult_Warns()
    {
        var source = """
            import System.Threading.Tasks

            let vt ValueTask[bool] = ValueTask[bool](true)
            let r = vt.GetAwaiter().GetResult()
            """;

        var diags = BindAndGetDiagnostics(source);
        Assert.Contains(diags, d => d.Id == "GS0275");
    }

    [Fact]
    public void Await_On_ValueTask_Does_Not_Warn()
    {
        var source = """
            import System.Threading.Tasks

            async func doWork() bool {
                let vt = ValueTask[bool](true)
                let r = await vt
                return r
            }
            """;

        var diags = BindAndGetDiagnostics(source);
        Assert.DoesNotContain(diags, d => d.Id == "GS0275");
    }

    [Fact]
    public void Warning_Message_Mentions_AsTask()
    {
        var source = """
            import System.Threading.Tasks

            let vt = ValueTask[bool](true)
            let r = vt.GetAwaiter().GetResult()
            """;

        var diags = BindAndGetDiagnostics(source);
        var warning = diags.First(d => d.Id == "GS0275");
        Assert.Contains("AsTask", warning.Message);
    }

    private static System.Collections.Generic.List<GSharp.Core.CodeAnalysis.Diagnostic> BindAndGetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        return globalScope.Diagnostics.ToList();
    }
}
