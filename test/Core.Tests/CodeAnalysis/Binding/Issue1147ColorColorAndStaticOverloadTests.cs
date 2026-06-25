// <copyright file="Issue1147ColorColorAndStaticOverloadTests.cs" company="GSharp">
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
/// Issue #1147: unified instance + static (<c>shared</c>) overload resolution in
/// two member-access scenarios.
///
/// <list type="bullet">
/// <item><description>
/// Facet A — the C# "Color Color" rule (ECMA-334 §12.8.7.1): a member-access
/// receiver simple-name that binds to BOTH an in-scope value AND a same-named
/// type prefers the VALUE (instance access) when an instance overload is
/// applicable, instead of always doing static member resolution against the
/// type.
/// </description></item>
/// <item><description>
/// Facet B — a bare unqualified call inside an instance method resolves against
/// the COMBINED instance + static overload set of the enclosing type, not only
/// the instance overloads.
/// </description></item>
/// </list>
/// </summary>
public class Issue1147ColorColorAndStaticOverloadTests
{
    [Fact]
    public void FacetA_ColorColor_InstanceOverloadApplicable_BindsInstanceCall()
    {
        // The receiver `AppleListBox` binds to both the property value and the
        // same-named type. The string argument is applicable to the INSTANCE
        // overload `GetTagString(string)`, not the static `GetTagString(Tag?)`,
        // so the instance interpretation must win (no GS0155).
        var source = """
            package p
            class Tag { }
            class AppleListBox {
                func GetTagString(name string) string? { return nil }
                shared {
                    func GetTagString(tagBox Tag?) string? { return nil }
                }
            }
            class Owner {
                prop AppleListBox AppleListBox {
                    get { return AppleListBox() }
                }
                func Title() string? {
                    return AppleListBox.GetTagString("title")
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void FacetA_ColorColor_OnlyStaticOverloadApplicable_BindsStaticCall()
    {
        // Same Color-Color receiver, but the argument (a `Tag?`) is applicable
        // only to the STATIC overload `GetTagString(Tag?)`, so unified
        // resolution must select the static overload and the call compiles.
        var source = """
            package p
            class Tag { }
            class AppleListBox {
                func GetTagString(name string) string? { return nil }
                shared {
                    func GetTagString(tagBox Tag?) string? { return nil }
                }
            }
            class Owner {
                prop AppleListBox AppleListBox {
                    get { return AppleListBox() }
                }
                func GetTag() Tag? { return nil }
                func Title() string? {
                    return AppleListBox.GetTagString(GetTag())
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void FacetA_ColorColor_InstanceOnlyMethod_StillBindsInstance()
    {
        // The method exists ONLY as an instance overload (no `shared` sibling).
        // The Color-Color receiver must keep binding the value/instance call.
        var source = """
            package p
            class AppleListBox {
                func GetTagString(name string) string? { return nil }
            }
            class Owner {
                prop AppleListBox AppleListBox {
                    get { return AppleListBox() }
                }
                func Title() string? {
                    return AppleListBox.GetTagString("title")
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void FacetB_UnqualifiedCall_SelectsStaticOverload()
    {
        // The bare unqualified call `GetTagString(GetTagBox(name))` passes a
        // `Tag?` which is applicable only to the static overload. Unified
        // instance + static resolution must select the static one (no GS0155).
        var source = """
            package p
            class Tag { }
            class Box {
                func GetTagString(name string) string? {
                    return GetTagString(GetTagBox(name))
                }
                func GetTagBox(name string) Tag? { return nil }
                shared {
                    func GetTagString(tagBox Tag?) string? { return nil }
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void FacetB_UnqualifiedCall_SelectsInstanceOverload()
    {
        // The same combined group, but a `string` argument is applicable only to
        // the instance overload — it must still bind the instance call.
        var source = """
            package p
            class Tag { }
            class Box {
                func Probe() string? {
                    return GetTagString("name")
                }
                func GetTagString(name string) string? { return nil }
                shared {
                    func GetTagString(tagBox Tag?) string? { return nil }
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void FacetB_UnqualifiedCall_StaticOnlySibling_Resolves()
    {
        // A bare unqualified call inside an instance method that names a method
        // declared ONLY as a `shared` sibling resolves against the static
        // overload (mirrors C# resolving the combined set).
        var source = """
            package p
            class Box {
                func Probe() string? {
                    return Helper("x")
                }
                shared {
                    func Helper(name string) string? { return nil }
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Guardrail_StaticNotReachableThroughOrdinaryInstance()
    {
        // `box` is an ordinary parameter whose name is NOT also a type, so the
        // Color-Color rule does not apply. The static overload
        // `GetTagString(Tag?)` must remain unreachable: the only candidate is the
        // instance `GetTagString(string)`, so passing a `Tag?` fails to convert.
        var source = """
            package p
            class Tag { }
            class AppleListBox {
                func GetTagString(name string) string? { return nil }
                shared {
                    func GetTagString(tagBox Tag?) string? { return nil }
                }
            }
            class Owner {
                func GetTag() Tag? { return nil }
                func Title(box AppleListBox) string? {
                    return box.GetTagString(GetTag())
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Message.Contains("Tag?") || d.Message.Contains("Tag"));
    }

    [Fact]
    public void Guardrail_UndefinedUnqualifiedName_ReportsUndefinedFunction()
    {
        var source = """
            package p
            class Box {
                func M() string? {
                    return TotallyUndefined("x")
                }
            }
            """;

        var diagnostics = Bind(source);
        Assert.Contains(diagnostics, d => d.Message.Contains("TotallyUndefined"));
    }

    [Fact]
    public void Guardrail_UnqualifiedCall_ArgMatchesNeitherOverload_Errors()
    {
        // The argument `42` is applicable to neither the instance
        // `GetTagString(string)` nor the static `GetTagString(Tag?)` overload —
        // the call must be rejected, never silently mis-bound.
        var source = """
            package p
            class Tag { }
            class Box {
                func GetTagString(name string) string? {
                    return GetTagString(42)
                }
                shared {
                    func GetTagString(tagBox Tag?) string? { return nil }
                }
            }
            """;

        Assert.NotEmpty(Bind(source));
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
