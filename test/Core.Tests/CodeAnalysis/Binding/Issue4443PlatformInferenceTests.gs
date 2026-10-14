// <copyright file="Issue4443PlatformInferenceTests.cs" company="GSharp">
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
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.ExceptionServices
import System.Runtime.Loader
import Xunit

/// Issue #4443, ADR-0186 §3 as amended: method type inference never yields
/// `T!` from an argument's top level. A `T!` argument contributes
/// `T`, a `T!` argument unified with a `T` one gives `T`,
/// and each `T!` argument is then coerced `T! → T` at the call,
/// which §4 checks. Before the fix, `Wrap(x)` over a `string!`
/// inferred `List[string!]`, which §3 rule 3 does not convert to the
/// `List[string]` the code declares (GS0155).
///
/// The rule is top-level only. A platform position nested inside the
/// argument's type (the element of an oblivious `List<string>`)
/// is part of an invariant container's identity and still infers
/// `string!`.
///
/// The platform values here come from an oblivious C# library, so the
/// tests do not depend on how an `@Oblivious` G# scope reads a nested
/// position (#4442). One test uses an `@Oblivious` parameter, whose
/// top level is `T!` under either reading: that is the issue's repro.
open class Issue4443PlatformInferenceTests {
    /// The issue's repro: a single `string!` argument infers
    /// `List[string]`, for a G# generic and for a CLR one, from an
    /// imported value and from an `@Oblivious` parameter.
    @Fact
    func A_Platform_Argument_Infers_Its_Underlying_Type() {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal("System.Collections.Generic.List[string]", ProbeType(library, "let probe = Wrap(Ob.Name())"))
        Assert.Equal(
            "System.Collections.Generic.IEnumerable[string]",
            ProbeType(library, "let probe = Enumerable.Repeat(Ob.Name(), 2)")
        )
        const program = (`@Oblivious
func A1(param string) int32 {
    // Inferred locals: an ` + "`" + `@Oblivious` + "`" + ` scope's declared
    // containers are a separate question (#4442). The enabled
    // ` + "`" + `Count` + "`" + ` takes exactly ` + "`" + `List[string]` + "`" + `.
    let xs = Wrap(param)
    let ys = Enumerable.Repeat(param, 2).ToList()
    return Count(xs) + Count(ys)
}

func Count(xs List[string]) int32 { return xs.Count }

func Imported() int32 {
    var xs List[string] = Wrap(Ob.Name())
    return xs.Count
}

Console.WriteLine(A1("p") + Imported())`)
        Assert.Equal("4\n", Run(library, program))
    }

    /// A `string!` argument and a `string` argument binding the same
    /// type parameter infer `string`, in either order. A `string?`
    /// argument still wins over both, since an explicit statement beats the
    /// absence of one (§3).
    @Fact
    func A_Platform_Argument_With_A_Plain_One_Infers_The_Plain_Type() {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal(
            "System.Collections.Generic.List[string]",
            ProbeType(library, "let probe = Pair(Ob.Name(), \"x\")")
        )
        Assert.Equal(
            "System.Collections.Generic.List[string]",
            ProbeType(library, "let probe = Pair(\"x\", Ob.Name())")
        )
        Assert.Equal(
            "System.Collections.Generic.List[string?]",
            ProbeType(library, "let nilable string? = nil\nlet probe = Pair(Ob.Name(), nilable)")
        )
    }

    /// The rule stops at the top level. The element of an oblivious
    /// `List<string>` is a platform position inside an invariant
    /// container, so `First(List[string!]!)` still infers
    /// `string!`: the argument's own top level is stripped, its type
    /// argument is not.
    @Fact
    func A_Nested_Platform_Position_Still_Infers_Platform() {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal("System.Collections.Generic.List[string!]!", ProbeType(library, "let probe = Ob.Strings()"))
        Assert.Equal("string!", ProbeType(library, "let probe = First(Ob.Strings())"))
    }

    /// The projection that reads the nested case reads any flags-annotated
    /// argument of the parameter's own generic definition, so an enabled
    /// `List<string?>` now infers `T = string?` for
    /// `First`, as C# does. It used to read the CLR shape and infer
    /// `string`: a non-null result from a list that holds nils, with no
    /// diagnostic.
    @Fact
    func An_Annotated_Nullable_Element_Infers_The_Nullable_Type() {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal("string?", ProbeType(library, "let probe = First(En.NullableStrings())"))
    }

    /// The coercion the rule adds is checked: a nil `string!` argument
    /// fails at the call with §4's attributed message, before it can enter the
    /// `List[string]`.
    @Fact
    func A_Nil_Platform_Argument_Fails_At_The_Call() {
        using let library = CSharpFixture(LibrarySource)
        const program = `func Build() int32 {
    var xs List[string] = Wrap(Ob.Nil())
    return xs.Count
}

Console.WriteLine(Build())`
        let thrown = Assert.Throws[NullReferenceException](
            func () object? {
                return Run(library, program)
            }
        )
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal)
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal)
    }

    /// A platform slice passed to a variadic `...T` slot is still a
    /// pass-through carrier: `Of(values)` over an `@Oblivious`
    /// `[]string` (`[]string` with a platform top level) infers
    /// `T = string` and returns the two elements, as it does for a plain
    /// slice, for a free function and for an instance method. Deciding the
    /// carrier shape before stripping the top-level `!` inferred
    /// `T = []string` and wrapped the slice as one element.
    @Fact
    func A_Platform_Slice_Passes_Through_A_Variadic_Slot() {
        using let library = CSharpFixture(LibrarySource)
        const program = `func Of[T](values ...T) []T { return values }

class Maker {
    func Of[T](values ...T) []T { return values }
}

@Oblivious
func Pass(values []string) int32 {
    let free = Of(values)
    let member = Maker().Of(values)
    return free.Length * 10 + member.Length
}

Console.WriteLine(Pass([]string{"a", "b"}))`
        Assert.Equal("22\n", Run(library, program))
    }

    /// A by-reference argument infers from its exact type in the call that is
    /// actually bound, not only while candidates are ranked: `Get(ref a)`
    /// over a `string!` local infers `T = string!`, so the result
    /// read from a location that may hold nil stays platform-typed. Stripping
    /// it would type that result `string` with no check anywhere.
    @Fact
    func A_By_Reference_Argument_Infers_Its_Exact_Type() {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal("string!", ProbeType(library, "var a = Ob.Name()\nlet probe = Get(ref a)"))
    }

    /// The amendment covers method type arguments only. A generic struct
    /// literal still infers its type argument from a `T!` field value
    /// exactly, as before: `Cell{Value: Ob.Name()}` is a
    /// `Cell[string!]`.
    @Fact
    func A_Generic_Struct_Literal_Keeps_The_Platform_Type_Argument() {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal("Cell[string!]", ProbeType(library, "let probe = Cell{Value: Ob.Name()}"))
    }

    /// A `string!` local passed by reference still binds, for a G#
    /// generic and for `Interlocked.Exchange`. A `ref` argument
    /// has no coercion to carry §4's check, so the imported-method path keeps
    /// a by-reference argument's exact type rather than stripping it.
    @Fact
    func A_By_Reference_Platform_Argument_Still_Binds() {
        using let library = CSharpFixture(LibrarySource)
        const program = `func Swap[T](ref a T, ref b T) {
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

Console.WriteLine(Exchange("x", "y"))`
        Assert.Equal("yzx\n", Run(library, program))
    }

    /// A slot the callee leaves oblivious keeps the argument's `T!`. An
    /// oblivious `WrapList<T>(T value)` reads its parameter as
    /// `T!` after substitution, so a stripped `string` would let a
    /// nil in with no check while the `List<T>` return read as
    /// `List[string]`. Keeping `string!` gives a
    /// `List[string!]`, and the nil fails at the element's first
    /// non-null use with §4's attributed message, not as a bare
    /// `NullReferenceException` from inside the loop body.
    @Fact
    func An_Oblivious_Parameter_Slot_Keeps_The_Platform_Argument() {
        using let library = CSharpFixture(LibrarySource)
        // The element is what matters: `string!`, not a stripped `string`.
        Assert.StartsWith(
            "System.Collections.Generic.List[string!]",
            ProbeType(library, "let probe = Ob.WrapList(Ob.Name())"),
            StringComparison.Ordinal
        )
        // The same for an expanded oblivious `params T[]` element.
        Assert.StartsWith(
            "System.Collections.Generic.List[string!]",
            ProbeType(library, "let probe = Ob.WrapMany(Ob.Name(), Ob.Name())"),
            StringComparison.Ordinal
        )
        const program = `for s in Ob.WrapList(Ob.Nil()) {
    let n string = s
    Console.WriteLine(n.Length)
}`
        let thrown = Assert.Throws[NullReferenceException](
            func () object? {
                return Run(library, program)
            }
        )
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal)
    }

    shared {
        private const Library string = "Issue4443.Library"

        private const LibrarySource string = `namespace Issue4443.Library
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
}`

        private const Prelude string = `import Issue4443.Library
import System
import System.Collections.Generic
import System.Linq
import System.Threading

func Wrap[T](x T) List[T] { return List[T]{ x } }

func Pair[T](a T, b T) List[T] { return List[T]{ a, b } }

func First[T](xs List[T]) T { return xs[0] }

func Get[T](ref x T) T { return x }

struct Cell[T] { var Value T }
`

        private func ProbeType(library CSharpFixture, globals string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + globals))){
                Nullability = NullabilityMode.PlatformTypes
            }
            let scope_ = compilation.GlobalScope
            Assert.False(
                scope_.Diagnostics.Any((d Diagnostic) -> d.IsError),
                string.Join(Environment.NewLine, scope_.Diagnostics.Select((d Diagnostic) -> d.Id + ": " + d.Message))
            )
            let type = Assert.Single(scope_.Variables, (v VariableSymbol) -> v.Name == "probe").Type
            // Rendered while the resolver is alive: an imported type's display
            // reads its CLR shape.
            return SymbolDisplay.ToTypeDisplayString(type)
        }

        private func Run(library CSharpFixture, program string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + program))){
                AssemblyName = "Issue4443",
                Nullability = NullabilityMode.PlatformTypes
            }
            using let pe = MemoryStream()
            let emit = compilation.Emit(pe, pdbStream: nil, refStream: nil, assemblyName: compilation.AssemblyName)
            Assert.True(
                emit.Success,
                string.Join(Environment.NewLine, emit.Diagnostics.Select((d Diagnostic) -> "${d.Id}: ${d.Message}"))
            )
            let libraryImage = File.ReadAllBytes(library.AssemblyPath)
            let context = AssemblyLoadContext(
                "Issue4443PlatformInferenceTests" + Guid.NewGuid().ToString("N"),
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
                    // Keep the program's own stack trace for a failing assertion.
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
