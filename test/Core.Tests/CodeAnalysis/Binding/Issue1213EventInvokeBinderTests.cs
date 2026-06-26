// <copyright file="Issue1213EventInvokeBinderTests.cs" company="GSharp">
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
/// Issue #1213: an <c>event</c> member can be declared on a class but could not
/// be referenced or invoked in expression position. A bare reference reported
/// <c>GS0125</c> ("Variable 'X' doesn't exist") and a <c>this.</c>-qualified
/// reference reported <c>GS0158</c> ("Cannot find member"). Inside the declaring
/// type, an event must bind to its private backing delegate field so the
/// canonical raise pattern <c>MyEvent?.Invoke(args)</c> resolves and emits.
/// </summary>
public class Issue1213EventInvokeBinderTests
{
    [Fact]
    public void BareEventReference_NullConditionalInvoke_Binds()
    {
        const string source = """
            package p
            class C {
                event ChapterRead (object?, int32) -> void
                func Fire(x int32) { ChapterRead?.Invoke(this, x) }
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0158");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void QualifiedEventReference_NullConditionalInvoke_Binds()
    {
        const string source = """
            package p
            class C {
                event ChapterRead (object?, int32) -> void
                func Fire(x int32) { this.ChapterRead?.Invoke(this, x) }
            }
            """;

        var diagnostics = Bind(source);
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0125");
        Assert.DoesNotContain(diagnostics, d => d.Id == "GS0158");
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void EventReference_DirectInvoke_AfterNilCheck_Binds()
    {
        const string source = """
            package p
            class C {
                event ChapterRead (object?, int32) -> void
                func Fire(x int32) {
                    if ChapterRead != nil {
                        ChapterRead.Invoke(this, x)
                    }
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void VoidDelegateEvent_NoArgs_Binds()
    {
        const string source = """
            package p
            class C {
                event Ping () -> void
                func FirePing() { Ping?.Invoke() }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    [Fact]
    public void MultiArgEvent_NullConditionalInvoke_Binds()
    {
        const string source = """
            package p
            class C {
                event Multi (int32, string, bool) -> void
                func FireMulti(n int32, s string, b bool) { this.Multi?.Invoke(n, s, b) }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Empty(diagnostics);
    }

    private static ImmutableArray<GSharp.Core.CodeAnalysis.Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
