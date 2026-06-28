// <copyright file="Issue1397InterfaceMethodGroupTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1397: accessing an instance method as a method group (for delegate
/// conversion, without calling it) on a receiver whose static type is an
/// interface must bind — just as it does for a class receiver. Member lookup
/// for an interface CALL already worked; only the method-group path was broken
/// because it never consulted the interface's member set (including inherited
/// base-interface members).
/// </summary>
public class Issue1397InterfaceMethodGroupTests
{
    [Fact]
    public void InterfaceMethodGroup_ToDelegateLocal_BindsClean()
    {
        const string source = """
            package p
            interface IReader { func Run(x int32) int32; }
            class Reader : IReader { func Run(x int32) int32 -> x }
            class C { func F(reader IReader) { let d (int32) -> int32 = reader.Run } }
            """;
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void InterfaceMethodGroup_AsDelegateArgument_BindsClean()
    {
        const string source = """
            package p
            import System.Threading
            import System.Threading.Tasks
            interface IReader { func RunAsync(cts CancellationTokenSource) Task; }
            class Op { init(start async (CancellationTokenSource) -> void) {} }
            class C { func F(reader IReader) { let op = Op(reader.RunAsync) } }
            """;
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void InheritedInterfaceMethodGroup_ToDelegateLocal_BindsClean()
    {
        const string source = """
            package p
            interface IBase { func Run(x int32) int32; }
            interface IReader : IBase {}
            class Reader : IReader { func Run(x int32) int32 -> x }
            class C { func F(reader IReader) { let d (int32) -> int32 = reader.Run } }
            """;
        Assert.Empty(GetDiagnostics(source));
    }

    [Fact]
    public void ClassReceiverMethodGroup_StillBindsClean()
    {
        const string source = """
            package p
            interface IReader { func Run(x int32) int32; }
            class Reader : IReader { func Run(x int32) int32 -> x }
            class C { func F(reader Reader) { let d (int32) -> int32 = reader.Run } }
            """;
        Assert.Empty(GetDiagnostics(source));
    }

    private static IReadOnlyList<Diagnostic> GetDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.GlobalScope.Diagnostics.ToList();
    }
}
