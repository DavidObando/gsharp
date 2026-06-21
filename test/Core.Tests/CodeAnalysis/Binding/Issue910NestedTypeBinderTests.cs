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
/// is set), resolves by simple name from the enclosing type's members, and the
/// two deferred kind/encloser combinations (nested interface; nested class in a
/// struct) report the dedicated GS0369 diagnostic instead of a parse cascade.
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
    public void NestedClassInStruct_ReportsGs0369()
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

        Assert.Contains(GetBinderDiagnostics(scope), d => d.Id == "GS0369");
    }

    [Fact]
    public void NestedInterfaceInClass_ReportsGs0369()
    {
        var scope = BindSource("""
            class Outer {
                interface IInner {
                    func Hello() string;
                }
            }
            """);

        Assert.Contains(GetBinderDiagnostics(scope), d => d.Id == "GS0369");
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
