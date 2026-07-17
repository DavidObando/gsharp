// <copyright file="Issue2419QualifiedSourceTypeNamespaceShadowTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Linq;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2419: <c>TryBindQualifiedSourceTypeConstruction</c> (and the
/// sibling <c>PeelNamespacePrefix</c> used for constructed-generic-type
/// assignment targets) peel a redundant package prefix off a fully-qualified,
/// same-compilation source-type construction one dotted segment at a time via
/// <c>IsNamespacePrefixSegment</c>. That helper required EVERY peeled segment
/// — not just the first — to fail lookup as an in-scope value/type/import.
/// When an unrelated in-scope value (e.g. a <c>const</c> field on the
/// enclosing type) happened to share its simple name with a middle or trailing
/// segment of the qualified package path (e.g. <c>Oahu.Audible.Json.Author</c>
/// where the enclosing <c>AaxExporter</c> class also declares
/// <c>private const Json string = ".json"</c>), peeling stopped one segment
/// short of the construction terminal, and the whole qualified name failed to
/// bind — reported as GS0157 "Cannot find type" against the leftmost segment.
/// <para>
/// The fix restricts the in-scope-value shadow check to the FIRST peeled
/// segment (which is what correctly protects a genuine value-access chain,
/// e.g. <c>myValue.Foo.Ctor()</c>, from being misinterpreted as a namespace
/// prefix) and ignores value shadowing for later segments, since once the
/// first segment has been accepted as a namespace component the chain can no
/// longer be a value-access chain at all. The type-alias/import/imported-class
/// checks are unchanged and still gate every segment, so this does not affect
/// disambiguation between same-simple-name types declared in different
/// packages — the terminal type is still resolved exactly as it was for the
/// already-supported unshadowed case.
/// </para>
/// </summary>
public class Issue2419QualifiedSourceTypeNamespaceShadowTests
{
    [Fact]
    public void QualifiedStructLiteral_ShadowedByConstFieldOnEnclosingType_Binds()
    {
        // Mirrors the exact real-world shape: AaxExporter declares
        // `private const Json string = ".json"`, and separately constructs
        // `Oahu.Audible.Json.Author{...}` — the const's simple name ("Json")
        // collides with the namespace's terminal package segment.
        const string source = """
            package Oahu.Core
            import Oahu.Audible.Json

            class Author {
                prop Asin string
                prop Name string
            }
            """;

        const string consumer = """
            package Oahu.Core
            import Oahu.Audible.Json

            class AaxExporter {
                func Make() Oahu.Audible.Json.Author {
                    return Oahu.Audible.Json.Author{Asin: "x", Name: "y"}
                }

                private const Json string = ".json"
            }
            """;

        var compilation = Compile(source, consumer);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void QualifiedConstructorCall_ShadowedByConstFieldOnEnclosingType_Binds()
    {
        const string source = """
            package Oahu.Audible.Json

            class ChapterInfo {
                func Hello() int32 -> 42
            }
            """;

        const string consumer = """
            package Oahu.Core
            import Oahu.Audible.Json

            class AaxExporter {
                func Make() int32 {
                    let ci = Oahu.Audible.Json.ChapterInfo()
                    return ci.Hello()
                }

                private const Json string = ".json"
            }
            """;

        var compilation = Compile(source, consumer);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void QualifiedStructLiteral_ShadowedByLocalVariableInSameMethod_Binds()
    {
        // The shadow does not have to be a class-level field — an ordinary
        // local variable earlier in the same method whose name matches a
        // middle namespace segment must not stop peeling either.
        const string source = """
            package App.Models

            class Foo {
                prop X int32
            }
            """;

        const string consumer = """
            package App
            import App.Models

            func Make() int32 {
                let Models = 7
                let f = App.Models.Foo{X: Models}
                return f.X
            }
            """;

        var compilation = Compile(source, consumer);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void QualifiedGenericTypeArgument_ShadowedByConstFieldOnEnclosingType_Binds()
    {
        // Type clauses and generic type arguments already went through a
        // separate, unaffected binding path — this pins that they remain
        // unaffected by the fix (and were never broken by the shadow).
        const string source = """
            package App.Models

            class Foo {
                prop X int32
            }
            """;

        const string consumer = """
            package App
            import App.Models
            import System.Collections.Generic

            class Widget {
                func Make() int32 {
                    let list = List[App.Models.Foo]()
                    list.Add(App.Models.Foo{X: 9})
                    return list[0].X
                }

                private const Models string = ".models"
            }
            """;

        var compilation = Compile(source, consumer);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void QualifiedTypeClauseAnnotation_ShadowedByConstFieldOnEnclosingType_Binds()
    {
        const string source = """
            package App.Models

            class Foo {
                prop X int32
            }
            """;

        const string consumer = """
            package App
            import App.Models

            class Widget {
                func Make() int32 {
                    let f App.Models.Foo = App.Models.Foo{X: 5}
                    return f.X
                }

                private const Models string = ".models"
            }
            """;

        var compilation = Compile(source, consumer);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void QualifiedStructLiteral_AsParameterAndReturn_ShadowedByConstField_Binds()
    {
        const string source = """
            package App.Models

            class Foo {
                prop X int32
            }
            """;

        const string consumer = """
            package App
            import App.Models

            class Widget {
                func Echo(f App.Models.Foo) App.Models.Foo {
                    return f
                }

                func Make() int32 {
                    return this.Echo(App.Models.Foo{X: 11}).X
                }

                private const Models string = ".models"
            }
            """;

        var compilation = Compile(source, consumer);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void QualifiedStructLiteral_InArrayInitializer_ShadowedByConstField_Binds()
    {
        const string source = """
            package App.Models

            class Foo {
                prop X int32
            }
            """;

        const string consumer = """
            package App
            import App.Models

            class Widget {
                func Make() int32 {
                    let items = []App.Models.Foo{App.Models.Foo{X: 1}, App.Models.Foo{X: 2}}
                    return items[0].X + items[1].X
                }

                private const Models string = ".models"
            }
            """;

        var compilation = Compile(source, consumer);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void QualifiedStructLiteral_ShadowedByConstField_DisambiguatesFromSameSimpleNameInSiblingPackage()
    {
        // Combines the shadow with a genuine same-simple-name collision across
        // sibling packages (the real Oahu.Audible.Json.Author vs.
        // Oahu.BooksDatabase.Author shape) to prove the fix does not fall back
        // to a flat/ambiguous simple-name resolution: the qualified
        // construction must still bind to the SPECIFIC package's type, not
        // whichever same-named type happens to resolve first.
        const string source = """
            package Oahu.Audible.Json

            class Author {
                prop Asin string
                prop Name string
            }
            """;

        const string other = """
            package Oahu.BooksDatabase

            class Author {
                prop Id int32
            }
            """;

        const string consumer = """
            package Oahu.Core
            import Oahu.Audible.Json
            import Oahu.BooksDatabase

            class AaxExporter {
                func Make() string {
                    let a = Oahu.Audible.Json.Author{Asin: "x", Name: "y"}
                    return a.Name
                }

                private const Json string = ".json"
            }
            """;

        var compilation = Compile(source, other, consumer);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    [Fact]
    public void UnqualifiedValueAccessChain_WithGenuineFirstSegmentValue_IsNotMisboundAsNamespace()
    {
        // Negative/ambiguity control: when the FIRST segment of a dotted chain
        // genuinely is an in-scope value, the chain must still be bound as an
        // ordinary member-access/call on that value — never reinterpreted as a
        // namespace-prefixed type construction. This protects the existing,
        // unchanged first-segment shadow check.
        const string source = """
            package App

            class Holder {
                prop Value int32
            }

            func Make() int32 {
                let Holder = App.Holder{Value: 3}
                return Holder.Value
            }
            """;

        var compilation = Compile(source);
        Assert.Empty(compilation.BoundProgram.Diagnostics.Where(d => d.IsError));
    }

    private static Compilation Compile(params string[] sources)
    {
        var trees = sources.Select(s => GSharp.Core.CodeAnalysis.Syntax.SyntaxTree.Parse(SourceText.From(s))).ToArray();
        return new Compilation(trees) { IsLibrary = true };
    }
}
