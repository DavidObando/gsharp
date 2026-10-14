// <copyright file="Issue4479SupertypeNullabilityInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import System
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.ExceptionServices
import System.Runtime.Loader
import Xunit

/// Issue #4479: method type inference through an imported base/interface must
/// project the argument's symbolic element positions rather than its
/// nullability-erased CLR arguments. The exact-definition case is covered by
/// (cref:Issue4443PlatformInferenceTests); these rows require the
/// `List<T> → IEnumerable<T>` hierarchy edge.
open class Issue4479SupertypeNullabilityInferenceTests {
    /// The reported imported-method path. Replacing the symbolic hierarchy
    /// projection with its CLR-shape equivalent makes the first two assertions
    /// read `string`; the nullable control reads `string` as well.
    @Fact
    func Imported_Select_Preserves_Nested_Platform_And_Nullable_Positions() {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal(
            "System.Collections.Generic.IEnumerable[string!]",
            ProbeType(library, "let probe = Ob.Strings().Select(s -> s)")
        )
        Assert.Equal(
            "System.Collections.Generic.IEnumerable[string?]",
            ProbeType(library, "let probe = En.NullableStrings().Select(s -> s)")
        )
        Assert.Equal(
            "System.Collections.Generic.IEnumerable[string!]",
            ProbeType(library, "let probe = Ob.StringArray().Select(s -> s)")
        )
        Assert.Equal(
            "System.Collections.Generic.List[string?]",
            ProbeType(library, "let probe = Generic.Copy(En.MaybeNullableStrings())")
        )
    }

    /// The same hierarchy projection feeds G# generic inference. The platform
    /// and nullable positions remain distinct, while explicit non-null and
    /// value-type elements are unchanged.
    @Theory
    @InlineData("Ob.Strings()", "string!")
    @InlineData("Ob.StringArray()", "string!")
    @InlineData("En.NullableStrings()", "string?")
    @InlineData("En.Strings()", "string")
    @InlineData("Ob.Numbers()", "int32")
    func Sequence_Generic_Preserves_The_Element_Position(expression string, expected string) {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal(expected, ProbeType(library, "let probe = First(" + expression + ")"))
    }

    /// Hierarchy projection must not choose arbitrarily when a source exposes
    /// two different constructions of the same generic interface. Both the G#
    /// and imported generic inference paths reject the ambiguous projection.
    @Theory
    @InlineData("Pick(Ob.Ambiguous())")
    @InlineData("Generic.Pick(Ob.Ambiguous())")
    func Conflicting_Interface_Projections_Do_Not_Infer(expression string) {
        using let library = CSharpFixture(LibrarySource)
        let diagnostics = CompileErrors(library, "let probe = " + expression)
        Assert.Contains(diagnostics, (diagnostic Diagnostic) -> (diagnostic.Id is "GS0151" or "GS0159"))
    }

    /// A same-compilation source type still projects through its imported
    /// interface with its symbolic user type intact.
    @Fact
    func Source_Type_Projection_Remains_Symbolic() {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal("Item", ProbeType(library, "let probe = Pick(SourceBox())"))
    }

    /// Preserving the nested element must not bypass the independent top-level
    /// `T! → T` boundary check on the container itself.
    @Fact
    func Platform_Container_Is_Checked_At_The_Sequence_Parameter() {
        using let library = CSharpFixture(LibrarySource)
        let thrown = Assert.Throws[NullReferenceException](
            func () object? {
                return Run(library, "let value = First(Ob.NilStrings())")
            }
        )
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal)
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal)
    }

    shared {
        private const LibrarySource string = `namespace Issue4479.Library
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
}`

        private const Prelude string = `import Issue4479.Library
import System.Collections.Generic
import System.Linq

func First[T](xs sequence[T]) T -> xs.First()

func Pick[T](box IBox[T]) T -> Generic.Pick(box)

class Item {
}

class SourceBox : IBox[Item] {
}
`

        private func ProbeType(library CSharpFixture, globals string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + globals))){
                Nullability = NullabilityMode.PlatformTypes
            }
            let scope_ = compilation.GlobalScope
            Assert.False(
                scope_.Diagnostics.Any((diagnostic Diagnostic) -> diagnostic.IsError),
                string.Join(
                    Environment.NewLine,
                    scope_.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Id + ": " + diagnostic.Message)
                )
            )
            let type = Assert.Single(scope_.Variables, (variable VariableSymbol) -> variable.Name == "probe").Type
            return SymbolDisplay.ToTypeDisplayString(type)
        }

        private func CompileErrors(library CSharpFixture, globals string) ImmutableArray[Diagnostic] {
            using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + globals))){
                Nullability = NullabilityMode.PlatformTypes
            }
            return compilation
                .GlobalScope
                .Diagnostics
                .Where((diagnostic Diagnostic) -> diagnostic.IsError)
                .ToImmutableArray()
        }

        private func Run(library CSharpFixture, program string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + program))){
                AssemblyName = "Issue4479",
                Nullability = NullabilityMode.PlatformTypes
            }
            using let pe = MemoryStream()
            let emit = compilation.Emit(pe, pdbStream: nil, refStream: nil, assemblyName: compilation.AssemblyName)
            Assert.True(
                emit.Success,
                string.Join(
                    Environment.NewLine,
                    emit.Diagnostics.Select((diagnostic Diagnostic) -> "${diagnostic.Id}: ${diagnostic.Message}")
                )
            )
            let libraryImage = File.ReadAllBytes(library.AssemblyPath)
            let context = AssemblyLoadContext(
                "Issue4479SupertypeNullabilityInferenceTests" + Guid.NewGuid().ToString("N"),
                isCollectible: true
            )
            context.Resolving += (loadContext AssemblyLoadContext, name AssemblyName) -> if string.Equals(
                name.Name,
                Path.GetFileNameWithoutExtension(library.AssemblyPath),
                StringComparison.Ordinal
            ) {
                loadContext.LoadFromStream(MemoryStream(libraryImage))
            } else {
                default(Assembly?)
            }
            try {
                pe.Position = 0
                let assembly = context.LoadFromStream(pe)
                let entry = Assert.IsAssignableFrom[MethodInfo](assembly.EntryPoint)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry.Invoke(
                        nil,
                        if entry.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } catch (invocation TargetInvocationException) when invocation.InnerException != nil {
                    ExceptionDispatchInfo.Capture(invocation.InnerException!!).Throw()
                    rethrow
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString().Replace("\r\n", "\n", StringComparison.Ordinal)
            } finally {
                context.Unload()
            }
        }
    }
}
