// <copyright file="Issue4479SupertypeNullabilityInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4479: method type inference through an imported base/interface must
/// project the argument's symbolic element positions rather than its
/// nullability-erased CLR arguments. The exact-definition case is covered by
/// <see cref="Issue4443PlatformInferenceTests"/>; these rows require the
/// <c>List&lt;T&gt; → IEnumerable&lt;T&gt;</c> hierarchy edge.
/// </summary>
public class Issue4479SupertypeNullabilityInferenceTests
{
    private const string LibrarySource = """
        namespace Issue4479.Library
        {
            using System.Collections.Generic;

            public static class Ob
            {
                public static List<string> Strings() { return new List<string> { "a", null }; }

                public static List<string> NilStrings() { return null; }

                public static List<int> Numbers() { return new List<int> { 1, 2 }; }

                public static string[] StringArray() { return new[] { "a", null }; }

                public static Ambiguous Ambiguous() { return new Ambiguous(); }
            }

        #nullable enable
            public static class En
            {
                public static List<string> Strings() { return new List<string> { "a", "b" }; }

                public static List<string?> NullableStrings() { return new List<string?> { null, "b" }; }

                public static List<string?>? MaybeNullableStrings() { return null; }
            }

            public interface IBox<T>
            {
            }

            public sealed class Ambiguous : IBox<string>, IBox<object>
            {
            }

            public static class Generic
            {
                public static T Pick<T>(IBox<T> box) { return default!; }

                public static List<T> Copy<T>(IEnumerable<T>? values) { return new List<T>(); }
            }
        #nullable restore
        }
        """;

    private const string Prelude = """
        import Issue4479.Library
        import System.Collections.Generic
        import System.Linq

        func First[T](xs sequence[T]) T -> xs.First()

        func Pick[T](box IBox[T]) T -> Generic.Pick(box)

        class Item {
        }

        class SourceBox : IBox[Item] {
        }

        """;

    /// <summary>
    /// The reported imported-method path. Replacing the symbolic hierarchy
    /// projection with its CLR-shape equivalent makes the first two assertions
    /// read <c>string</c>; the nullable control reads <c>string</c> as well.
    /// </summary>
    [Fact]
    public void Imported_Select_Preserves_Nested_Platform_And_Nullable_Positions()
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal(
            "System.Collections.Generic.IEnumerable[string!]",
            ProbeType(library, "let probe = Ob.Strings().Select(s -> s)"));
        Assert.Equal(
            "System.Collections.Generic.IEnumerable[string?]",
            ProbeType(library, "let probe = En.NullableStrings().Select(s -> s)"));
        Assert.Equal(
            "System.Collections.Generic.IEnumerable[string!]",
            ProbeType(library, "let probe = Ob.StringArray().Select(s -> s)"));
        Assert.Equal(
            "System.Collections.Generic.List[string?]",
            ProbeType(library, "let probe = Generic.Copy(En.MaybeNullableStrings())"));
    }

    /// <summary>
    /// The same hierarchy projection feeds G# generic inference. The platform
    /// and nullable positions remain distinct, while explicit non-null and
    /// value-type elements are unchanged.
    /// </summary>
    [Theory]
    [InlineData("Ob.Strings()", "string!")]
    [InlineData("Ob.StringArray()", "string!")]
    [InlineData("En.NullableStrings()", "string?")]
    [InlineData("En.Strings()", "string")]
    [InlineData("Ob.Numbers()", "int32")]
    public void Sequence_Generic_Preserves_The_Element_Position(string expression, string expected)
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal(expected, ProbeType(library, "let probe = First(" + expression + ")"));
    }

    /// <summary>
    /// Hierarchy projection must not choose arbitrarily when a source exposes
    /// two different constructions of the same generic interface. Both the G#
    /// and imported generic inference paths reject the ambiguous projection.
    /// </summary>
    [Theory]
    [InlineData("Pick(Ob.Ambiguous())")]
    public void Conflicting_Interface_Projections_Do_Not_Infer(string expression)
    {
        using var library = new CSharpFixture(LibrarySource);

        var diagnostics = CompileErrors(library, "let probe = " + expression);
        Assert.Contains(diagnostics, diagnostic => diagnostic.Id == "GS0151");
    }

    /// <summary>
    /// A same-compilation source type still projects through its imported
    /// interface with its symbolic user type intact.
    /// </summary>
    [Fact]
    public void Source_Type_Projection_Remains_Symbolic()
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal("Item", ProbeType(library, "let probe = Pick(SourceBox())"));
    }

    /// <summary>
    /// Preserving the nested element must not bypass the independent top-level
    /// <c>T! → T</c> boundary check on the container itself.
    /// </summary>
    [Fact]
    public void Platform_Container_Is_Checked_At_The_Sequence_Parameter()
    {
        using var library = new CSharpFixture(LibrarySource);

        var thrown = Assert.Throws<NullReferenceException>(
            () => Run(library, "let value = First(Ob.NilStrings())"));
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal);
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal);
    }

    private static string ProbeType(CSharpFixture library, string globals)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + globals)))
        {
            Nullability = NullabilityMode.PlatformTypes,
        };

        var scope = compilation.GlobalScope;
        Assert.False(
            scope.Diagnostics.Any(diagnostic => diagnostic.IsError),
            string.Join(Environment.NewLine, scope.Diagnostics.Select(diagnostic => diagnostic.Id + ": " + diagnostic.Message)));
        var type = Assert.Single(scope.Variables, variable => variable.Name == "probe").Type;
        return SymbolDisplay.ToTypeDisplayString(type);
    }

    private static ImmutableArray<Diagnostic> CompileErrors(CSharpFixture library, string globals)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + globals)))
        {
            Nullability = NullabilityMode.PlatformTypes,
        };

        return compilation.GlobalScope.Diagnostics.Where(diagnostic => diagnostic.IsError).ToImmutableArray();
    }

    private static string Run(CSharpFixture library, string program)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + program)))
        {
            AssemblyName = "Issue4479",
            Nullability = NullabilityMode.PlatformTypes,
        };
        using var pe = new MemoryStream();
        var emit = compilation.Emit(pe, pdbStream: null, refStream: null, assemblyName: compilation.AssemblyName);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics.Select(diagnostic => $"{diagnostic.Id}: {diagnostic.Message}")));

        var libraryImage = File.ReadAllBytes(library.AssemblyPath);
        var context = new AssemblyLoadContext(nameof(Issue4479SupertypeNullabilityInferenceTests) + Guid.NewGuid().ToString("N"), isCollectible: true);
        context.Resolving += (loadContext, name) =>
            string.Equals(name.Name, Path.GetFileNameWithoutExtension(library.AssemblyPath), StringComparison.Ordinal)
                ? loadContext.LoadFromStream(new MemoryStream(libraryImage))
                : null;
        try
        {
            pe.Position = 0;
            var assembly = context.LoadFromStream(pe);
            var entry = Assert.IsAssignableFrom<MethodInfo>(assembly.EntryPoint);
            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { Array.Empty<string>() });
            }
            catch (TargetInvocationException invocation) when (invocation.InnerException != null)
            {
                ExceptionDispatchInfo.Capture(invocation.InnerException).Throw();
                throw;
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString().Replace("\r\n", "\n", StringComparison.Ordinal);
        }
        finally
        {
            context.Unload();
        }
    }
}
