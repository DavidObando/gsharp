// <copyright file="Issue1640DuplicateMemberKindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #1640: duplicate-member detection must reject a name collision
/// across DIFFERENT member kinds (field/method/property/event), not just
/// within the same kind. Legitimate method overloads (same name, different
/// signature — including an instance/shared pair per issue #1147) must keep
/// binding clean.
/// </summary>
public class Issue1640DuplicateMemberKindTests
{
    [Fact]
    public void PropertyDuplicatingMethodName_IsReported()
    {
        var source = """
            package p
            class C {
                func Foo() int32 { return 1 }
                prop Foo int32 { get { return 1 } }
            }
            """;

        Assert.Contains(Bind(source), d => d.Message.Contains("Foo"));
    }

    [Fact]
    public void MethodDuplicatingPropertyName_IsReported()
    {
        var source = """
            package p
            class C {
                prop Foo int32 { get { return 1 } }
                func Foo() int32 { return 1 }
            }
            """;

        Assert.Contains(Bind(source), d => d.Message.Contains("Foo"));
    }

    [Fact]
    public void EventDuplicatingMethodName_IsReported()
    {
        var source = """
            package p
            class C {
                func Foo() int32 { return 1 }
                event Foo () -> void
            }
            """;

        Assert.Contains(Bind(source), d => d.Message.Contains("Foo"));
    }

    [Fact]
    public void SharedFieldDuplicatingInstanceMethodName_IsReported()
    {
        var source = """
            package p
            class C {
                func Foo() int32 { return 1 }
                shared {
                    var Foo int32 = 0
                }
            }
            """;

        Assert.Contains(Bind(source), d => d.Message.Contains("Foo"));
    }

    [Fact]
    public void SharedPropertyDuplicatingSharedMethodName_IsReported()
    {
        var source = """
            package p
            class C {
                shared {
                    func Foo() int32 { return 1 }
                    prop Foo int32 { get { return 1 } }
                }
            }
            """;

        Assert.Contains(Bind(source), d => d.Message.Contains("Foo"));
    }

    [Fact]
    public void InstanceAndSharedMethodOverload_SameName_BindsClean()
    {
        // Issue #1147: an instance method and a `shared` (static) method may
        // legitimately share a name — this is an overload, not a duplicate.
        var source = """
            package p
            class C {
                func Foo(x int32) int32 { return x }
                shared {
                    func Foo(x string) int32 { return 0 }
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void DistinctMemberNames_BindClean()
    {
        var source = """
            package p
            class C {
                var Field int32 = 0
                prop Prop int32 { get { return 1 } }
                func Method() int32 { return 1 }
                event Evt () -> void
            }
            """;

        Assert.Empty(Bind(source));
    }

    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        if (tree.Diagnostics.Any())
        {
            return tree.Diagnostics;
        }

        var globalScope = Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
        if (globalScope.Diagnostics.Any())
        {
            return globalScope.Diagnostics;
        }

        var program = Binder.BindProgram(globalScope);
        return program.Diagnostics.ToImmutableArray();
    }
}
