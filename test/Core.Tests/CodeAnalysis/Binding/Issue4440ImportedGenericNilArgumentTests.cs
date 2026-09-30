// <copyright file="Issue4440ImportedGenericNilArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4440: an imported generic member parameter must retain the
/// nullability of the receiver type argument when the argument is converted.
/// </summary>
/// <remarks>
/// <b>Discrimination (ADR-0154).</b> On parent commit
/// <c>dbba5cdb01cbe65e1a9d116a811e209e7934ba56</c>, every rejection row
/// compiles without GS0155. Removing the receiver-aware parameter read
/// restores that failure, while all controls remain green.
/// </remarks>
public sealed class Issue4440ImportedGenericNilArgumentTests
{
    public static TheoryData<string, int> RejectedCases => new()
    {
        {
            """
            import System.Collections.Generic
            let xs = List[string]()
            xs.Add(nil)
            """,
            3
        },
        {
            """
            import System.Collections.Generic
            let xs = List[string]{"a", nil}
            """,
            2
        },
        {
            """
            import System.Collections.Generic
            let xs = List[List[string]]()
            xs.Add(nil)
            """,
            3
        },
    };

    [Theory]
    [MemberData(nameof(RejectedCases))]
    public void NilAtNonNullSubstitutedParameterReportsGs0155(string source, int line)
    {
        var diagnostic = Assert.Single(Errors(Compile(source)));

        Assert.Equal("GS0155", diagnostic.Id);
        Assert.Equal(line, diagnostic.Location.StartLine + 1);
        Assert.Contains("nil", diagnostic.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void NonNullNullableAndValueArgumentsCompile()
    {
        const string source = """
            import System.Collections.Generic

            let strings = List[string]{"a"}
            strings.Add("b")

            let nullableStrings = List[string?]{nil}
            nullableStrings.Add(nil)

            let values = List[int32]{1}
            values.Add(2)
            """;

        Assert.Empty(Errors(Compile(source)));
    }

    [Fact]
    public void ValueTypeInstantiationStillRejectsNil()
    {
        var errors = Errors(Compile(
            """
            import System.Collections.Generic
            let values = List[int32]()
            values.Add(nil)
            """));

        Assert.NotEmpty(errors);
    }

    [Fact]
    public void NullableAndObliviousTargetsStillAcceptNil()
    {
        const string librarySource = """
            #nullable disable
            namespace Issue4440.Library;

            using System.Collections.Generic;

            public static class Ob
            {
                public static List<string> Strings() => new();
            }

            public sealed class LegacySink
            {
                public void Take(string value) { }
            }

            #nullable enable
            public sealed class Box<T>
            {
                public U Echo<U>(U value) => value;
                public void SetMaybe(T? value) { }
            }

            public interface IBox<T>
            {
                void Put(T value);
            }

            public sealed class Sink
            {
                public void Take(string value) { }
            }
            """;
        using var library = new CSharpFixture(librarySource);
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });

        var diagnostics = Compile(
            """
            import Issue4440.Library
            let box = Box[int32]()
            let text string = box.Echo[string]("ok")
            let maybe string? = box.Echo[string?](nil)
            let nullable string? = nil
            Sink().Take(nullable)
            Ob.Strings().Add(nil)
            LegacySink().Take(nil)
            Box[string]().SetMaybe(nil)
            """,
            resolver);

        Assert.Empty(Errors(diagnostics));
    }

    [Fact]
    public void ConstrainedImportedGenericParameterAlsoRejectsNil()
    {
        const string librarySource = """
            #nullable enable
            namespace Issue4440.Library;

            public interface IBox<T>
            {
                void Put(T value);
            }

            public sealed class Box<T>
            {
                public void Put<U>(T value, U marker) { }
            }
            """;
        using var library = new CSharpFixture(librarySource);
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });

        var diagnostics = Errors(Compile(
            """
            import Issue4440.Library
            func PutNil[B IBox[string]](box B) {
                box.Put(nil)
            }

            Box[string]().Put[int32](nil, 0)
            """,
            resolver));

        Assert.Equal(new[] { "GS0155", "GS0155" }, diagnostics.Select(diagnostic => diagnostic.Id));
        Assert.Equal(
            new[] { 3, 6 },
            diagnostics.Select(diagnostic => diagnostic.Location.StartLine + 1).Order());
    }

    [Fact]
    public void ImportedExtensionProjectsUserArgumentAfterReceiver()
    {
        const string librarySource = """
            #nullable enable
            namespace Issue4440.Library;

            using System;
            using System.Collections.Generic;

            public static class Extensions
            {
                public static void Put<T>(this List<T> values, T value) { }
                public static void PutMade<T, U>(
                    this List<T> values,
                    U value,
                    Func<U> factory) { }
            }
            """;
        using var library = new CSharpFixture(librarySource);
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });

        var diagnostics = Errors(Compile(
            """
            import System.Collections.Generic
            import Issue4440.Library
            func Text() string -> "x"
            List[string]().Put(nil)
            List[int32]().PutMade(nil, Text)
            """,
            resolver));

        Assert.Equal(new[] { "GS0155", "GS0155" }, diagnostics.Select(diagnostic => diagnostic.Id));
        Assert.Equal(
            new[] { 4, 5 },
            diagnostics.Select(diagnostic => diagnostic.Location.StartLine + 1).Order());
    }

    [Fact]
    public void ImportedExtensionPreservesExplicitNullableMethodTypeArgument()
    {
        const string librarySource = """
            #nullable enable
            namespace Issue4440.Library;

            public static class Extensions
            {
                public static void Put<T>(this T? receiver, T value) { }
            }
            """;
        using var library = new CSharpFixture(librarySource);
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });

        Assert.Empty(Errors(Compile(
            """
            import Issue4440.Library
            "x".Put[string?](nil)
            """,
            resolver)));
    }

    [Fact]
    public void ImportedExtensionExplicitNonNullMethodTypeArgumentStillRejectsNil()
    {
        const string librarySource = """
            #nullable enable
            namespace Issue4440.Library;

            public static class Extensions
            {
                public static void Put<T>(this T? receiver, T value) { }
            }
            """;
        using var library = new CSharpFixture(librarySource);
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });

        var diagnostic = Assert.Single(Errors(Compile(
            """
            import Issue4440.Library
            "x".Put[string](nil)
            """,
            resolver)));

        Assert.Equal("GS0155", diagnostic.Id);
        Assert.Equal(2, diagnostic.Location.StartLine + 1);
    }

    [Fact]
    public void ImportedStaticCallsProjectGenericArguments()
    {
        const string librarySource = """
            #nullable enable
            namespace Issue4440.Library;

            using System.Collections.Generic;

            public static class StaticSink
            {
                public static void Put<T>(T value) { }
            }

            public sealed class StaticBox<T>
            {
                public static void Put(T value) { }
            }

            public class StaticOuter<T>
            {
                public sealed class Nested
                {
                    public static void Put(T value) { }
                }

                public sealed class Middle
                {
                    public sealed class Inner
                    {
                        public static void Put(T value) { }
                    }
                }
            }

            public static class Extensions
            {
                public static void Put<T>(this List<T> values, T value) { }
            }
            """;
        using var library = new CSharpFixture(librarySource);
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });

        var diagnostics = Errors(Compile(
            """
            import System.Collections.Generic
            import Issue4440.Library
            class NullableDerived : StaticOuter[string?] { }
            StaticSink.Put[string](nil)
            StaticBox[string].Put(nil)
            StaticOuter[string].Nested.Put(nil)
            StaticOuter[string].Middle.Inner.Put(nil)
            NullableDerived.Nested.Put(nil)
            Extensions.Put[string](List[string](), nil)
            """,
            resolver));

        Assert.Equal(
            new[] { "GS0155", "GS0155", "GS0155", "GS0155", "GS0155" },
            diagnostics.Select(diagnostic => diagnostic.Id));
        Assert.Equal(
            new[] { 4, 5, 6, 7, 9 },
            diagnostics.Select(diagnostic => diagnostic.Location.StartLine + 1).Order());
    }

    [Fact]
    public void ImportedInParametersProjectGenericNilTargets()
    {
        const string librarySource = """
            #nullable enable
            namespace Issue4440.Library;

            public sealed class InBox<T>
            {
                public void Take(in T value) { }
                public void TakeMethod<U>(in U value) { }
            }

            public static class InSink
            {
                public static void Take<T>(in T value) { }
            }
            """;
        using var library = new CSharpFixture(librarySource);
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });

        var diagnostics = Errors(Compile(
            """
            import Issue4440.Library
            InBox[string]().Take(nil)
            InBox[string]().TakeMethod[string](nil)
            InSink.Take[string](nil)
            InBox[string]().TakeMethod[string?](nil)
            InSink.Take[string?](nil)
            """,
            resolver));

        Assert.Equal(
            new[] { 2, 3, 4 },
            diagnostics.Select(diagnostic => diagnostic.Location.StartLine + 1).Order());
        Assert.Equal(new[] { "GS0155", "GS0155", "GS0155" }, diagnostics.Select(diagnostic => diagnostic.Id));
    }

    private static ImmutableArray<Diagnostic> Compile(string source)
    {
        using var resolver = ReferenceResolver.Default();
        return Compile(source, resolver);
    }

    private static ImmutableArray<Diagnostic> Compile(
        string source,
        ReferenceResolver resolver)
    {
        var compilation = new Compilation(
            resolver,
            SyntaxTree.Parse(SourceText.From(source)))
        {
            Nullability = NullabilityMode.PlatformTypes,
        };
        return compilation.GlobalScope.Diagnostics.AddRange(compilation.BoundProgram.Diagnostics);
    }

    private static ImmutableArray<Diagnostic> Errors(ImmutableArray<Diagnostic> diagnostics)
        => diagnostics.Where(diagnostic => diagnostic.IsError).ToImmutableArray();
}
