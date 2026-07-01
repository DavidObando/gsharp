// <copyright file="Issue1506PerSegmentNestedTypeBinderTests.cs" company="GSharp">
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
/// Issue #1506: the binder must resolve a nested type named on a
/// <em>constructed</em> generic outer — <c>List[int32].Enumerator</c>,
/// <c>Dictionary[string, int32].Enumerator</c> — against the constructed outer,
/// i.e. to the nested CLR definition (which carries the outer's generic
/// parameters) closed over the outer's type arguments. These tests assert the
/// resolved <see cref="TypeSymbol.ClrType"/> is the expected closed nested type
/// in parameter, return, and field positions (locals are exercised end-to-end
/// by the emit suite), plus resolution of a user-declared generic outer's
/// nested type.
/// </summary>
public class Issue1506PerSegmentNestedTypeBinderTests
{
    [Fact]
    public void ListEnumerator_InParameterPosition_ResolvesToConstructedNestedClrType()
    {
        var scope = BindSource("""
            package p
            import System.Collections.Generic
            func Consume(e List[int32].Enumerator) { }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var consume = scope.Functions.Single(f => f.Name == "Consume");
        var paramType = consume.Parameters.Single().Type;
        AssertClosedNestedType(paramType, "System.Collections.Generic.List`1+Enumerator", "System.Int32");
    }

    [Fact]
    public void ListEnumerator_InReturnPosition_ResolvesToConstructedNestedClrType()
    {
        var scope = BindSource("""
            package p
            import System.Collections.Generic
            func GetIt(source List[int32]) List[int32].Enumerator {
                return source.GetEnumerator()
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var getIt = scope.Functions.Single(f => f.Name == "GetIt");
        AssertClosedNestedType(getIt.Type, "System.Collections.Generic.List`1+Enumerator", "System.Int32");
    }

    [Fact]
    public void ListEnumerator_InFieldPosition_ResolvesToConstructedNestedClrType()
    {
        var scope = BindSource("""
            package p
            import System.Collections.Generic
            struct Holder {
                var slot List[int32].Enumerator
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var holder = (StructSymbol)scope.TypeAliases["Holder"];
        var field = holder.Fields.Single(f => f.Name == "slot");
        AssertClosedNestedType(field.Type, "System.Collections.Generic.List`1+Enumerator", "System.Int32");
    }

    [Fact]
    public void DictionaryEnumerator_WithTwoTypeArguments_ResolvesToConstructedNestedClrType()
    {
        var scope = BindSource("""
            package p
            import System.Collections.Generic
            func Consume(e Dictionary[string, int32].Enumerator) { }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var consume = scope.Functions.Single(f => f.Name == "Consume");
        var paramType = consume.Parameters.Single().Type;

        Assert.NotNull(paramType.ClrType);
        Assert.True(paramType.ClrType.IsGenericType);
        Assert.Equal(
            "System.Collections.Generic.Dictionary`2+Enumerator",
            paramType.ClrType.GetGenericTypeDefinition().FullName);
        var args = paramType.ClrType.GetGenericArguments();
        Assert.Equal(2, args.Length);
        Assert.Equal("System.String", args[0].FullName);
        Assert.Equal("System.Int32", args[1].FullName);
    }

    [Fact]
    public void UserGenericOuter_NestedType_ResolvesAgainstConstructedOuter()
    {
        // A user-declared generic outer's nested type resolves through the
        // enclosing-type chain, validating the outer's arguments. Issue #1521:
        // the nested type is now threaded with the enclosing construction's
        // arguments (`Box[int32].Tag` carries EnclosingTypeArguments=[int32]) so
        // a use-site reference/slot emits `Box`1+Tag`1<int32>` rather than the
        // open self-instantiation `Box`1+Tag`1<!0>`.
        var scope = BindSource("""
            package p
            struct Box[T] {
                var value T
                struct Tag {
                    var label int32
                }
            }
            func Use(t Box[int32].Tag) int32 {
                return t.label
            }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var use = scope.Functions.Single(f => f.Name == "Use");
        var paramType = use.Parameters.Single().Type;

        var tag = (StructSymbol)scope.TypeAliases["Tag"];
        var box = (StructSymbol)scope.TypeAliases["Box`1"];

        // Issue #1521: the resolved parameter type is a constructed-nested
        // reference (distinct from the open Tag definition) closed over the
        // enclosing outer's `int32` argument, but sharing the open definition
        // and the open enclosing type as its ContainingType.
        var paramStruct = Assert.IsType<StructSymbol>(paramType);
        Assert.True(paramStruct.IsConstructedNestedType);
        Assert.Same(tag, paramStruct.Definition);
        Assert.Same(box, paramStruct.ContainingType);
        var enclosingArg = Assert.Single(paramStruct.EnclosingTypeArguments);
        Assert.Equal("int32", enclosingArg.Name);
    }

    [Fact]
    public void UserGenericOuter_WithGenericNestedType_ConstructsDeepestSegment()
    {
        // The deepest segment carries its OWN type arguments: `Box[int32].Pair[string]`
        // must construct `Pair` (the nested generic) — a closed generic symbol,
        // not the open definition.
        var scope = BindSource("""
            package p
            struct Box[T] {
                struct Pair[U] {
                    var second U
                }
            }
            func Use(p Box[int32].Pair[string]) { }
            """);

        Assert.Empty(GetBinderDiagnostics(scope));

        var use = scope.Functions.Single(f => f.Name == "Use");
        var paramType = use.Parameters.Single().Type;

        var pairStruct = Assert.IsType<StructSymbol>(paramType);
        Assert.Equal("Pair", pairStruct.Name);
        Assert.False(pairStruct.IsGenericDefinition);
        Assert.Single(pairStruct.TypeArguments);
        Assert.Equal("string", pairStruct.TypeArguments[0].Name);
    }

    private static void AssertClosedNestedType(TypeSymbol type, string expectedOpenDefFullName, string expectedArgFullName)
    {
        Assert.NotNull(type.ClrType);
        Assert.True(type.ClrType.IsGenericType, "resolved nested type should be a constructed generic");
        Assert.Equal(expectedOpenDefFullName, type.ClrType.GetGenericTypeDefinition().FullName);
        var args = type.ClrType.GetGenericArguments();
        Assert.Single(args);
        Assert.Equal(expectedArgFullName, args[0].FullName);
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
