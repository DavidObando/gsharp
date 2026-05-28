// <copyright file="AsyncEmitPrecheckTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>
/// Verifies the pre-emit gate that converts the historical
/// <c>InvalidProgramException</c>-at-runtime failure for async functions
/// into a clean compile-time diagnostic until the state-machine emitter
/// lands.
/// </summary>
public class AsyncEmitPrecheckTests
{
    [Fact]
    public void Check_NullProgram_ReturnsEmpty()
    {
        Assert.Empty(AsyncEmitPrecheck.Check(null));
    }

    [Fact]
    public void Check_NoAsyncFunctions_ReturnsEmpty()
    {
        var source = "package main\nimport System\nConsole.WriteLine(\"hi\")\n";
        var program = Bind(source);
        Assert.Empty(AsyncEmitPrecheck.Check(program));
    }

    [Fact]
    public void Check_AsyncFunction_ReportsDiagnostic_WithExpectedMessage()
    {
        var source = "package main\nasync func doIt() {}\n";
        var program = Bind(source);

        var diagnostics = AsyncEmitPrecheck.Check(program);
        var d = Assert.Single(diagnostics);
        Assert.Equal(AsyncEmitPrecheck.AsyncStateMachineUnavailableMessage, d.Message);
    }

    [Fact]
    public void Check_MultipleAsyncFunctions_OneDiagnosticEach()
    {
        var source =
            "package main\n" +
            "async func a() {}\n" +
            "async func b() int32 { return 1 }\n" +
            "func c() {}\n";
        var program = Bind(source);

        var diagnostics = AsyncEmitPrecheck.Check(program);
        Assert.Equal(2, diagnostics.Length);
    }

    [Fact]
    public void Compile_AsyncFunction_EmitsSuccessfully()
    {
        // Now that the kickoff body emitter is implemented, simple async
        // functions should compile without the precheck blocking them.
        var source = "package main\nasync func doIt() {}\n";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select(d => d.Message)));
    }

    [Fact]
    public void Compile_NonAsyncProgram_StillSucceeds()
    {
        var source = "package HelloWorld\nimport System\nConsole.WriteLine(\"hi\")\n";
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);

        using var peStream = new MemoryStream();
        var result = compilation.Emit(peStream);

        Assert.True(result.Success, "non-async compilation must still succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));
    }

    private static BoundProgram Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return Binder.BindProgram(compilation.GlobalScope);
    }
}
