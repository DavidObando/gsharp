// <copyright file="Issue910NestedTypeBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #910 / ADR-0110: binder coverage for nested type declarations. A
/// nested type is registered as a member of the enclosing type (its
/// <see cref="StructSymbol.ContainingType"/> / <see cref="EnumSymbol.ContainingType"/>
/// / <see cref="InterfaceSymbol.ContainingType"/> is set) and resolves by simple
/// name from the enclosing type's members, for every nested kind (class, struct,
/// interface, enum) in either encloser (class or struct).
/// </summary>
public class Issue910NestedTypeBinderTests
{
    [Fact]
    public void NestedClassInClass_BindsWithoutDiagnostics_AndSetsContainingType()
    {
        var scope = BindSource("""
            class Outer {
                class Inner {
                    func Hello() string {
                        return "hi"
                    }
                }

                func Make() string {
                    let i = Inner()
                    return i.Hello()
                }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var inner = (StructSymbol)scope.TypeAliases["Inner"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, inner.ContainingType);
    }

    [Fact]
    public void NestedStructInStruct_BindsWithoutDiagnostics_AndSetsContainingType()
    {
        var scope = BindSource("""
            struct Outer {
                struct Inner {
                    var X int32
                }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var inner = (StructSymbol)scope.TypeAliases["Inner"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, inner.ContainingType);
        Assert.False(inner.IsClass);
    }

    [Fact]
    public void NestedEnumInClass_BindsWithoutDiagnostics_AndSetsContainingType()
    {
        var scope = BindSource("""
            class Outer {
                enum Color {
                    Red,
                    Green,
                }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var color = (EnumSymbol)scope.TypeAliases["Color"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, color.ContainingType);
    }

    [Fact]
    public void RecursivelyNestedClass_AllLevelsBind_AndContainingTypesChain()
    {
        var scope = BindSource("""
            class Outer {
                class Middle {
                    class Inner {
                        func N() int32 {
                            return 7
                        }
                    }
                }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        var middle = (StructSymbol)scope.TypeAliases["Middle"];
        var inner = (StructSymbol)scope.TypeAliases["Inner"];
        Assert.Same(outer, middle.ContainingType);
        Assert.Same(middle, inner.ContainingType);
    }

    [Fact]
    public void NestedClassInStruct_BindsWithoutDiagnostics_AndSetsContainingType()
    {
        var scope = BindSource("""
            struct Outer {
                class Inner {
                    func Hello() string {
                        return "hi"
                    }
                }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var inner = (StructSymbol)scope.TypeAliases["Inner"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, inner.ContainingType);
        Assert.True(inner.IsClass);
        Assert.False(outer.IsClass);
    }

    [Fact]
    public void NestedInterfaceInClass_BindsWithoutDiagnostics_AndSetsContainingType()
    {
        var scope = BindSource("""
            class Outer {
                interface IInner {
                    func Hello() string;
                }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var inner = (InterfaceSymbol)scope.TypeAliases["IInner"];
        var outer = (StructSymbol)scope.TypeAliases["Outer"];
        Assert.Same(outer, inner.ContainingType);
    }

    [Fact]
    public void NestedClassInClass_WithInitConstructor_BindsExplicitConstructor()
    {
        // Issue #920: a nested class that declares an `init()` constructor must
        // bind that constructor onto the nested StructSymbol just like a
        // top-level class, so the emitter can record its ctor handle.
        var scope = BindSource("""
            class Outer920 {
                class Inner920 {
                    prop X int32
                    init() {
                        X = 5
                    }
                }
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var inner = (StructSymbol)scope.TypeAliases["Inner920"];
        var outer = (StructSymbol)scope.TypeAliases["Outer920"];
        Assert.Same(outer, inner.ContainingType);
        Assert.True(inner.IsClass);
        Assert.NotNull(inner.ExplicitConstructor);
        Assert.Single(inner.ExplicitConstructors);
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static System.Collections.Generic.IEnumerable<GSharp.Core.CodeAnalysis.Diagnostic> GetBinderDiagnostics(BoundGlobalScope scope)
    {
        return scope.Diagnostics;
    }
}
