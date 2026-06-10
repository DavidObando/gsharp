// <copyright file="Issue671UserTypeAsClrGenericArgTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Regression tests for issue #671: user-defined G# class or interface used as a
/// type argument to a CLR generic (<c>List[MyType]</c>, <c>Task[MyType]</c>,
/// <c>Dictionary[string, MyType]</c>) in field-type, method return-type, or
/// method parameter-type position must bind without error.
/// <para>
/// Previously the declaration-position generic-construction path rejected types
/// whose <see cref="TypeSymbol.ClrType"/> was <c>null</c> (always the case for
/// user-defined types before emit) by surfacing GS0149 "Type 'X' is not generic".
/// The fix projects such types onto <c>System.Object</c> for the closed CLR shape
/// (same as type parameters under the type-erased model) while preserving the
/// real symbolic argument via <see cref="ImportedTypeSymbol.GetConstructed"/>.
/// </para>
/// </summary>
public class Issue671UserTypeAsClrGenericArgTests
{
    private static ImmutableArray<Diagnostic> Bind(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }

    private static ImmutableArray<Diagnostic> BindMultiFile(params string[] sources)
    {
        var trees = sources
            .Select(s => SyntaxTree.Parse(SourceText.From(s)))
            .ToArray();
        var compilation = new Compilation(trees);
        var result = compilation.Evaluate(new Dictionary<VariableSymbol, object>());
        return result.Diagnostics;
    }

    // ─── Field type position ─────────────────────────────────────────────

    [Fact]
    public void Field_ListOfUserClass_Binds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                items List[MyType]
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Field_ListOfUserInterface_Binds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type IMyType interface {
                func GetName() string
            }

            type Container class {
                items List[IMyType]
            }
            """;

        Assert.Empty(Bind(source));
    }

    // ─── Method return-type position ─────────────────────────────────────

    [Fact]
    public void MethodReturn_ListOfUserClass_Binds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                items List[MyType]

                func getItems() List[MyType] {
                    return items
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    // ─── Method parameter-type position ──────────────────────────────────

    [Fact]
    public void MethodParam_ListOfUserClass_Binds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                func addAll(xs List[MyType]) {
                }
            }
            """;

        Assert.Empty(Bind(source));
    }

    // ─── IReadOnlyList / IEnumerable / Task ──────────────────────────────

    [Fact]
    public void Field_IReadOnlyListOfUserClass_Binds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type MyType class {
                Value int32
            }

            type Container class {
                items IReadOnlyList[MyType]
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Field_IEnumerableOfUserClass_Binds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type MyType class {
                Value int32
            }

            type Container class {
                items IEnumerable[MyType]
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Field_TaskOfUserClass_Binds()
    {
        var source = """
            package App
            import System.Threading.Tasks

            type MyType class {
                Value int32
            }

            type Container class {
                pending Task[MyType]
            }
            """;

        Assert.Empty(Bind(source));
    }

    // ─── Multi-arg generics ──────────────────────────────────────────────

    [Fact]
    public void Field_DictionaryStringAndUserClass_Binds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                items Dictionary[string, MyType]
            }
            """;

        Assert.Empty(Bind(source));
    }

    // ─── Cross-file (same package) ───────────────────────────────────────

    [Fact]
    public void CrossFile_ListOfUserClass_Binds()
    {
        var fileA = """
            package App
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }
            """;

        var fileB = """
            package App
            import System.Collections.Generic

            type Container class {
                items List[MyType]
            }
            """;

        Assert.Empty(BindMultiFile(fileA, fileB));
    }

    // ─── Regression guards ───────────────────────────────────────────────

    [Fact]
    public void Regression_Field_ListOfString_StillBinds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type Container class {
                items List[string]
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Regression_Field_DictionaryOfClrTypes_StillBinds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type Container class {
                items Dictionary[string, int32]
            }
            """;

        Assert.Empty(Bind(source));
    }

    [Fact]
    public void Regression_BodyPosition_ListOfUserClass_StillBinds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                items List[MyType]
            }

            func main() {
                var c = Container()
            }
            """;

        Assert.Empty(Bind(source));
    }

    // ─── MLC (MetadataLoadContext) path ──────────────────────────────────

    private static ReferenceResolver MetadataLoadContextResolver()
    {
        var paths = new[]
        {
            typeof(object).Assembly.Location,
            typeof(System.Collections.Generic.List<>).Assembly.Location,
            typeof(System.Collections.Generic.Dictionary<,>).Assembly.Location,
            typeof(System.Threading.Tasks.Task<>).Assembly.Location,
            typeof(System.Console).Assembly.Location,
            typeof(System.Linq.Enumerable).Assembly.Location,
        }
        .Where(p => !string.IsNullOrEmpty(p))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .ToArray();

        return ReferenceResolver.WithReferences(paths);
    }

    private static ImmutableArray<Diagnostic> BindWithReferences(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var globalScope = Binder.BindGlobalScope(
            previous: null,
            ImmutableArray.Create(tree),
            MetadataLoadContextResolver());
        var program = Binder.BindProgram(globalScope, MetadataLoadContextResolver());
        return globalScope.Diagnostics.AddRange(program.Diagnostics);
    }

    [Fact]
    public void MLC_Field_ListOfUserClass_Binds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                items List[MyType]
            }
            """;

        Assert.Empty(BindWithReferences(source));
    }

    [Fact]
    public void MLC_Field_DictionaryStringAndUserClass_Binds()
    {
        var source = """
            package App
            import System.Collections.Generic

            type MyType class {
                Name string = ""
            }

            type Container class {
                items Dictionary[string, MyType]
            }
            """;

        Assert.Empty(BindWithReferences(source));
    }
}
