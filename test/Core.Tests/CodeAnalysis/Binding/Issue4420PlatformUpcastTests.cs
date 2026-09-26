// <copyright file="Issue4420PlatformUpcastTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;
using GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation;
using GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #4420, ADR-0186 §3 rule 3 through a supertype view: a container
/// with a platform element (<c>List[string!]</c>, <c>[]!string!</c>) does
/// not convert to a supertype that promises non-null elements
/// (<c>IEnumerable[string]</c>, <c>IReadOnlyList[string]</c>). The identity
/// case (<c>List[string!]</c> to <c>List[string]</c>) was already rejected;
/// the upcast was admitted because its two generic definitions differ, and
/// the callee then read a nil element as non-null with no check anywhere.
/// <para>
/// The legal directions stay open: a nilable element
/// (<c>IEnumerable[string?]</c>) and a non-generic supertype. A checked
/// element-wise copy into a <c>List[string]</c> converts and fails at the nil
/// with the attributed message.
/// </para>
/// </summary>
public class Issue4420PlatformUpcastTests
{
    private const string LibrarySource = """
        namespace Issue4420.Library
        {
            using System;
            using System.Collections.Generic;

            public static class Ob
            {
                public static List<string> Strings() { return new List<string> { "a", null }; }

                public static string[] Lines() { return new[] { "a", "b" }; }

                public static IEnumerable<string> Seq() { return new List<string> { "a", null }; }

                public static Func<string> Factory() { return () => null; }
            }

            public interface IChild<T> : IEnumerable<T>
            {
            }

            public class Base<T> : List<T>
            {
            }
        }
        """;

    private const string Prelude = """
        import Issue4420.Library
        import System
        import System.Collections
        import System.Collections.Generic
        import System.Linq

        func TakeEnum(xs IEnumerable[string]) int32 { return xs.Count() }

        func TakeRo(xs IReadOnlyList[string]) int32 { return xs[1].Length }

        func TakeNilable(xs IEnumerable[string?]) int32 { return xs.Count() }

        func TakeUntyped(xs IEnumerable) int32 { return 1 }

        func TakeObjects(xs IEnumerable[object]) int32 { return xs.Count() }

        func TakeNilableObjects(xs IEnumerable[object?]) int32 { return xs.Count() }

        func TakeFactory(f Func[object]) int32 { return 1 }

        // An `IEnumerable[string!]` itself: the same generic definition as the
        // target, reaching `IEnumerable[object]` through covariance.
        func AsEnumerable[T](xs List[T]) IEnumerable[T] { return xs }

        interface IOut[out T] {
            func Get() T;
        }

        class OutRepo[T] : IOut[T] {
            private let value T

            init(value T) {
                this.value = value
            }

            func Get() T -> value
        }

        func TakeOut(x IOut[object]) int32 { return 1 }

        interface IIn[in T] {
            func Put(value T) int32;
        }

        class ObjectSink : IIn[object] {
            func Put(value object) int32 -> 1
        }

        // A sink of `string!` elements: inferred from the list's nested
        // element, so the parameter type is `IIn[string!]`.
        func TakeInPlatformOf[T](xs List[T], sink IIn[T]) int32 { return sink.Put(xs[0]) }

        interface IView[T] : IEnumerable[T] {
        }

        class ViewRepo[T] : IView[T] {
            private let items List[T] = List[T]()

            init(value T) {
                items.Add(value)
            }

            func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
            private func (IEnumerable) GetEnumerator() IEnumerator -> GetEnumerator()
        }

        // Inferred from the list's NESTED element, which keeps `string!` (a
        // top-level `T!` argument would infer `string`, #4443), so this is an
        // `IView[string!]`.
        func ViewOfFirst[T](xs List[T]) IView[T] { return ViewRepo[T](xs[0]) }

        func Keep(s string) string { return s }

        class Repo[T] : IEnumerable[T] {
            private let items List[T] = List[T]()

            init(value T) {
                items.Add(value)
            }

            func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
            private func GetEnumerator() IEnumerator -> GetEnumerator()
        }

        class ChildRepo[T] : IChild[T] {
            private let items List[T] = List[T]()

            init(value T) {
                items.Add(value)
            }

            func GetEnumerator() IEnumerator[T] -> items.GetEnumerator()
            private func GetEnumerator() IEnumerator -> GetEnumerator()
        }

        class BaseRepo[T] : Base[T] {
            init(value T) {
                this.Add(value)
            }
        }

        """;

    /// <summary>
    /// Each upcast that promises non-null elements is rejected at compile
    /// time. Before the fix all four compiled, and <c>TakeRo</c> read the
    /// list's nil element as a non-null <c>string</c>.
    /// </summary>
    /// <param name="call">The call to compile.</param>
    [Theory]
    [InlineData("TakeEnum(Ob.Strings())")]
    [InlineData("TakeRo(Ob.Strings())")]
    [InlineData("TakeEnum(Ob.Lines())")]
    [InlineData("TakeRo(Ob.Lines())")]
    [InlineData("TakeEnum(Repo(Ob.Strings()[0]))")]
    [InlineData("TakeEnum(ChildRepo(Ob.Strings()[0]))")]
    [InlineData("TakeEnum(BaseRepo(Ob.Strings()[0]))")]
    [InlineData("TakeObjects(Ob.Strings())")]
    [InlineData("TakeObjects(Ob.Lines())")]
    [InlineData("TakeObjects(AsEnumerable(Ob.Strings()))")]
    [InlineData("TakeOut(OutRepo(Ob.Strings()[0]))")]
    [InlineData("TakeEnum(ViewOfFirst(Ob.Strings()))")]
    [InlineData("TakeObjects(Ob.Seq())")]
    [InlineData("TakeInPlatformOf(Ob.Strings(), ObjectSink())")]
    public void An_Upcast_To_A_NonNull_Element_Supertype_Is_Rejected(string call)
    {
        using var library = new CSharpFixture(LibrarySource);

        var diagnostics = CompileErrors(library, "Console.WriteLine(" + call + ")");
        Assert.True(diagnostics.Any(d => d.StartsWith("GS0154", StringComparison.Ordinal) || d.StartsWith("GS0155", StringComparison.Ordinal)), string.Join(" / ", diagnostics));
    }

    /// <summary>
    /// The legal directions still convert: a nilable element and a
    /// non-generic supertype. A checked element-wise copy is the bridge to a
    /// non-null view; it fails at the nil element with the attributed message,
    /// not later inside the callee.
    /// </summary>
    [Fact]
    public void The_Legal_Directions_Still_Convert()
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal(
            "2\n1\n2\n",
            Run(library, "Console.WriteLine(TakeNilable(Ob.Strings()))\nConsole.WriteLine(TakeUntyped(Ob.Strings()))\nConsole.WriteLine(TakeNilableObjects(Ob.Strings()))"));

        const string bridge = """
            let checked = List[string]()
            for s in Ob.Strings() {
                checked.Add(Keep(s))
            }
            Console.WriteLine(TakeRo(checked))
            """;
        var thrown = Assert.Throws<NullReferenceException>(() => Run(library, bridge));
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// ADR-0186 open question 13 deliberately leaves delegate conversion as a
    /// conformance boundary: CLR covariance converts the imported
    /// <c>Func[string!]</c> to <c>Func[object]</c>, with no nested check point.
    /// </summary>
    [Fact]
    public void Imported_Delegate_Variance_Remains_A_Conformance_Boundary()
    {
        using var library = new CSharpFixture(LibrarySource);

        Assert.Equal("1\n", Run(library, "Console.WriteLine(TakeFactory(Ob.Factory()))"));
    }

    private static string[] CompileErrors(CSharpFixture library, string program)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + program)))
        {
            Nullability = NullabilityMode.PlatformTypes,
        };
        return compilation.GlobalScope.Diagnostics.Concat(compilation.BoundProgram.Diagnostics).Where(d => d.IsError).Select(d => d.Id + ": " + d.Message).ToArray();
    }

    private static string Run(CSharpFixture library, string program)
    {
        using var resolver = ReferenceResolver.WithReferences(new[] { library.AssemblyPath });
        var compilation = new GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + program)))
        {
            AssemblyName = "Issue4420",
            Nullability = NullabilityMode.PlatformTypes,
        };
        using var pe = new MemoryStream();
        var emit = compilation.Emit(pe, pdbStream: null, refStream: null, assemblyName: compilation.AssemblyName);
        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics.Select(d => $"{d.Id}: {d.Message}")));

        var libraryImage = File.ReadAllBytes(library.AssemblyPath);
        var context = new AssemblyLoadContext(nameof(Issue4420PlatformUpcastTests) + Guid.NewGuid().ToString("N"), isCollectible: true);
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
