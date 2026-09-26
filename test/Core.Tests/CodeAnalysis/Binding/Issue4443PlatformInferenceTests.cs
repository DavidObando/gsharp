// <copyright file="Issue4443PlatformInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Symbols.Display;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4443, ADR-0186 §3 as amended: method type inference never yields
/// <c>T!</c> from an argument's top level. A <c>T!</c> argument contributes
/// <c>T</c>, a <c>T!</c> argument unified with a <c>T</c> one gives <c>T</c>,
/// and each <c>T!</c> argument is then coerced <c>T! → T</c> at the call,
/// which §4 checks. Before the fix, <c>Wrap(x)</c> over a <c>string!</c>
/// inferred <c>List[string!]</c>, which §3 rule 3 does not convert to the
/// <c>List[string]</c> the code declares (GS0155).
/// <para>
/// The rule is top-level only. A platform position nested inside the
/// argument's type (the element of an oblivious <c>List&lt;string&gt;</c>)
/// is part of an invariant container's identity and still infers
/// <c>string!</c>.
/// </para>
/// <para>
/// The platform values here come from an oblivious C# library, so the
/// tests do not depend on how an <c>@Oblivious</c> G# scope reads a nested
/// position (#4442). One test uses an <c>@Oblivious</c> parameter, whose
/// top level is <c>T!</c> under either reading: that is the issue's repro.
/// </para>
/// </summary>
public class Issue4443PlatformInferenceTests
{
    private const string Library = "Issue4443.Library";

    private const string LibrarySource = """
        namespace Issue4443.Library
        {
            using System.Collections.Generic;

            public static class Ob
            {
                public static string Name() { return "n"; }

                public static string Nil() { return null; }

                public static List<string> Strings() { return new List<string> { "a", "b" }; }

                public static List<T> WrapList<T>(T value) { return new List<T> { value }; }

                public static List<T> WrapMany<T>(params T[] values) { return new List<T>(values); }
            }

        #nullable enable
            public static class En
            {
                public static List<string?> NullableStrings() { return new List<string?> { null, "b" }; }
            }
        #nullable restore
        }
        """;

    private const string Prelude = """
        import Issue4443.Library
        import System
        import System.Collections.Generic
        import System.Linq
        import System.Threading

        func Wrap[T](x T) List[T] { return List[T]{ x } }

        func Pair[T](a T, b T) List[T] { return List[T]{ a, b } }

        func First[T](xs List[T]) T { return xs[0] }

        func Get[T](ref x T) T { return x }

        struct Cell[T] { var Value T }

        """;

    /// <summary>
    /// The issue's repro: a single <c>string!</c> argument infers
    /// <c>List[string]</c>, for a G# generic and for a CLR one, from an
    /// imported value and from an <c>@Oblivious</c> parameter.
    /// </summary>
    [Fact]
    public void A_Platform_Argument_Infers_Its_Underlying_Type()
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal("System.Collections.Generic.List[string]", ProbeType(library, "let probe = Wrap(Ob.Name())"));
        Assert.Equal("System.Collections.Generic.IEnumerable[string]", ProbeType(library, "let probe = Enumerable.Repeat(Ob.Name(), 2)"));

        const string program = """
            @Oblivious
            func A1(param string) int32 {
                // Inferred locals: an `@Oblivious` scope's declared
                // containers are a separate question (#4442). The enabled
                // `Count` takes exactly `List[string]`.
                let xs = Wrap(param)
                let ys = Enumerable.Repeat(param, 2).ToList()
                return Count(xs) + Count(ys)
            }

            func Count(xs List[string]) int32 { return xs.Count }

            func Imported() int32 {
                var xs List[string] = Wrap(Ob.Name())
                return xs.Count
            }

            Console.WriteLine(A1("p") + Imported())
            """;

        Assert.Equal("4\n", Run(library, program));
    }

    /// <summary>
    /// A <c>string!</c> argument and a <c>string</c> argument binding the same
    /// type parameter infer <c>string</c>, in either order. A <c>string?</c>
    /// argument still wins over both, since an explicit statement beats the
    /// absence of one (§3).
    /// </summary>
    [Fact]
    public void A_Platform_Argument_With_A_Plain_One_Infers_The_Plain_Type()
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal("System.Collections.Generic.List[string]", ProbeType(library, "let probe = Pair(Ob.Name(), \"x\")"));
        Assert.Equal("System.Collections.Generic.List[string]", ProbeType(library, "let probe = Pair(\"x\", Ob.Name())"));
        Assert.Equal(
            "System.Collections.Generic.List[string?]",
            ProbeType(library, "let nilable string? = nil\nlet probe = Pair(Ob.Name(), nilable)"));
    }

    /// <summary>
    /// The rule stops at the top level. The element of an oblivious
    /// <c>List&lt;string&gt;</c> is a platform position inside an invariant
    /// container, so <c>First(List[string!]!)</c> still infers
    /// <c>string!</c>: the argument's own top level is stripped, its type
    /// argument is not.
    /// </summary>
    [Fact]
    public void A_Nested_Platform_Position_Still_Infers_Platform()
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal("System.Collections.Generic.List[string!]!", ProbeType(library, "let probe = Ob.Strings()"));
        Assert.Equal("string!", ProbeType(library, "let probe = First(Ob.Strings())"));
    }

    /// <summary>
    /// The projection that reads the nested case reads any flags-annotated
    /// argument of the parameter's own generic definition, so an enabled
    /// <c>List&lt;string?&gt;</c> now infers <c>T = string?</c> for
    /// <c>First</c>, as C# does. It used to read the CLR shape and infer
    /// <c>string</c>: a non-null result from a list that holds nils, with no
    /// diagnostic.
    /// </summary>
    [Fact]
    public void An_Annotated_Nullable_Element_Infers_The_Nullable_Type()
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal("string?", ProbeType(library, "let probe = First(En.NullableStrings())"));
    }

    /// <summary>
    /// The coercion the rule adds is checked: a nil <c>string!</c> argument
    /// fails at the call with §4's attributed message, before it can enter the
    /// <c>List[string]</c>.
    /// </summary>
    [Fact]
    public void A_Nil_Platform_Argument_Fails_At_The_Call()
    {
        using var library = new CSharpFixture(LibrarySource);

        const string program = """
            func Build() int32 {
                var xs List[string] = Wrap(Ob.Nil())
                return xs.Count
            }

            Console.WriteLine(Build())
            """;

        var thrown = Assert.Throws<NullReferenceException>(() => Run(library, program));
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal);
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A by-reference argument infers from its exact type in the call that is
    /// actually bound, not only while candidates are ranked: <c>Get(ref a)</c>
    /// over a <c>string!</c> local infers <c>T = string!</c>, so the result
    /// read from a location that may hold nil stays platform-typed. Stripping
    /// it would type that result <c>string</c> with no check anywhere.
    /// </summary>
    [Fact]
    public void A_By_Reference_Argument_Infers_Its_Exact_Type()
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal("string!", ProbeType(library, "var a = Ob.Name()\nlet probe = Get(ref a)"));
    }

    /// <summary>
    /// The amendment covers method type arguments only. A generic struct
    /// literal still infers its type argument from a <c>T!</c> field value
    /// exactly, as before: <c>Cell{Value: Ob.Name()}</c> is a
    /// <c>Cell[string!]</c>.
    /// </summary>
    [Fact]
    public void A_Generic_Struct_Literal_Keeps_The_Platform_Type_Argument()
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal("Cell[string!]", ProbeType(library, "let probe = Cell{Value: Ob.Name()}"));
    }

    /// <summary>
    /// A <c>string!</c> local passed by reference still binds, for a G#
    /// generic and for <c>Interlocked.Exchange</c>. A <c>ref</c> argument
    /// has no coercion to carry §4's check, so the imported-method path keeps
    /// a by-reference argument's exact type rather than stripping it.
    /// </summary>
    [Fact]
    public void A_By_Reference_Platform_Argument_Still_Binds()
    {
        using var library = new CSharpFixture(LibrarySource);

        const string program = """
            func Swap[T](ref a T, ref b T) {
                let t = a
                a = b
                b = t
            }

            @Oblivious
            func Exchange(first string, second string) string {
                var a = first
                var b = second
                Swap(ref a, ref b)
                let old = Interlocked.Exchange(ref a, "z")
                return old + a + b
            }

            Console.WriteLine(Exchange("x", "y"))
            """;

        Assert.Equal("yzx\n", Run(library, program));
    }

    /// <summary>
    /// A slot the callee leaves oblivious keeps the argument's <c>T!</c>. An
    /// oblivious <c>WrapList&lt;T&gt;(T value)</c> reads its parameter as
    /// <c>T!</c> after substitution, so a stripped <c>string</c> would let a
    /// nil in with no check while the <c>List&lt;T&gt;</c> return read as
    /// <c>List[string]</c>. Keeping <c>string!</c> gives a
    /// <c>List[string!]</c>, and the nil fails at the element's first
    /// non-null use with §4's attributed message, not as a bare
    /// <c>NullReferenceException</c> from inside the loop body.
    /// </summary>
    [Fact]
    public void An_Oblivious_Parameter_Slot_Keeps_The_Platform_Argument()
    {
        using var library = new CSharpFixture(LibrarySource);

        // The element is what matters: `string!`, not a stripped `string`.
        Assert.StartsWith(
            "System.Collections.Generic.List[string!]",
            ProbeType(library, "let probe = Ob.WrapList(Ob.Name())"),
            StringComparison.Ordinal);

        // The same for an expanded oblivious `params T[]` element.
        Assert.StartsWith(
            "System.Collections.Generic.List[string!]",
            ProbeType(library, "let probe = Ob.WrapMany(Ob.Name(), Ob.Name())"),
            StringComparison.Ordinal);

        const string program = """
            for s in Ob.WrapList(Ob.Nil()) {
                let n string = s
                Console.WriteLine(n.Length)
            }
            """;

        var thrown = Assert.Throws<NullReferenceException>(() => Run(library, program));
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal);
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
            scope.Diagnostics.Any(d => d.IsError),
            string.Join(Environment.NewLine, scope.Diagnostics.Select(d => d.Id + ": " + d.Message)));
        var type = Assert.Single(scope.Variables, v => v.Name == "probe").Type;

        // Rendered while the resolver is alive: an imported type's display
        // reads its CLR shape.
        return SymbolDisplay.ToTypeDisplayString(type);
    }

    private static string Run(CSharpFixture library, string program)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + program)))
        {
            AssemblyName = "Issue4443",
            Nullability = NullabilityMode.PlatformTypes,
        };
        using var pe = new MemoryStream();
        var emit = compilation.Emit(pe, pdbStream: null, refStream: null, assemblyName: compilation.AssemblyName);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics.Select(d => $"{d.Id}: {d.Message}")));

        var libraryImage = File.ReadAllBytes(library.AssemblyPath);
        var context = new AssemblyLoadContext(nameof(Issue4443PlatformInferenceTests) + Guid.NewGuid().ToString("N"), isCollectible: true);
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
                // Keep the program's own stack trace for a failing assertion.
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
