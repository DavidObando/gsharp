// <copyright file="Issue4420PlatformUpcastTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
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

/// Issue #4420, ADR-0186 §3 rule 3 through a supertype view: a container
/// with a platform element (`List[string!]`, `[]!string!`) does
/// not convert to a supertype that promises non-null elements
/// (`IEnumerable[string]`, `IReadOnlyList[string]`). The identity
/// case (`List[string!]` to `List[string]`) was already rejected;
/// the upcast was admitted because its two generic definitions differ, and
/// the callee then read a nil element as non-null with no check anywhere.
///
/// The legal directions stay open: a nilable element
/// (`IEnumerable[string?]`) and a non-generic supertype. A checked
/// element-wise copy into a `List[string]` converts and fails at the nil
/// with the attributed message.
open class Issue4420PlatformUpcastTests {
    /// Each upcast that promises non-null elements is rejected at compile
    /// time. Before the fix all four compiled, and `TakeRo` read the
    /// list's nil element as a non-null `string`.
    /// @param call The call to compile.
    @Theory
    @InlineData("TakeEnum(Ob.Strings())")
    @InlineData("TakeRo(Ob.Strings())")
    @InlineData("TakeEnum(Ob.Lines())")
    @InlineData("TakeRo(Ob.Lines())")
    @InlineData("TakeEnum(Repo(Ob.Strings()[0]))")
    @InlineData("TakeEnum(ChildRepo(Ob.Strings()[0]))")
    @InlineData("TakeEnum(BaseRepo(Ob.Strings()[0]))")
    @InlineData("TakeObjects(Ob.Strings())")
    @InlineData("TakeObjects(Ob.Lines())")
    @InlineData("TakeObjects(AsEnumerable(Ob.Strings()))")
    @InlineData("TakeOut(OutRepo(Ob.Strings()[0]))")
    @InlineData("TakeEnum(ViewOfFirst(Ob.Strings()))")
    @InlineData("TakeObjects(Ob.Seq())")
    @InlineData("TakeInPlatformOf(Ob.Strings(), ObjectSink())")
    @InlineData("TakeNested(Ob.Composite())")
    @InlineData("TakeParent(ChildOfFirst(Ob.Strings()))")
    func An_Upcast_To_A_NonNull_Element_Supertype_Is_Rejected(call string) {
        using let library = CSharpFixture(LibrarySource)
        let diagnostics = CompileErrors(library, "Console.WriteLine(" + call + ")")
        Assert.True(
            diagnostics.Any(
                (d string) -> d.StartsWith("GS0154", StringComparison.Ordinal) || d.StartsWith(
                    "GS0155",
                    StringComparison.Ordinal
                )
            ),
            string.Join(" / ", diagnostics)
        )
    }

    /// The legal directions still convert: a nilable element and a
    /// non-generic supertype. A checked element-wise copy is the bridge to a
    /// non-null view; it fails at the nil element with the attributed message,
    /// not later inside the callee.
    @Fact
    func The_Legal_Directions_Still_Convert() {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal(`2
1
2
0
0
`, Run(library, `Console.WriteLine(TakeNilable(Ob.Strings()))
Console.WriteLine(TakeUntyped(Ob.Strings()))
Console.WriteLine(TakeNilableObjects(Ob.Strings()))
Console.WriteLine(TakeObjects(Ob.Composite()))
Console.WriteLine(TakeFactories(Ob.CompositeDelegates()))`))
        const bridge = `let checked = List[string]()
for s in Ob.Strings() {
    checked.Add(Keep(s))
}
Console.WriteLine(TakeRo(checked))`
        let thrown = Assert.Throws[NullReferenceException](
            func () object? {
                return Run(library, bridge)
            }
        )
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal)
    }

    /// ADR-0186 open question 13 deliberately leaves delegate conversion as a
    /// conformance boundary: CLR covariance converts the imported
    /// `Func[string!]` to `Func[object]`, with no nested check point.
    @Fact
    func Imported_Delegate_Variance_Remains_A_Conformance_Boundary() {
        using let library = CSharpFixture(LibrarySource)
        Assert.Equal("1\n", Run(library, "Console.WriteLine(TakeFactory(Ob.Factory()))"))
    }

    shared {
        private const LibrarySource string = `namespace Issue4420.Library
{
    using System;
    using System.Collections.Generic;

    public static class Ob
    {
        public static List<string> Strings() { return new List<string> { "a", null }; }

        public static string[] Lines() { return new[] { "a", "b" }; }

        public static IEnumerable<string> Seq() { return new List<string> { "a", null }; }

        public static Func<string> Factory() { return () => null; }

        public static ICompositeChild<string> Composite() { return new CompositeChild<string>(); }

        public static ICompositeDelegateChild<string> CompositeDelegates() { return new CompositeDelegateChild<string>(); }
    }

    public interface IChild<T> : IEnumerable<T>
    {
    }

    public class Base<T> : List<T>
    {
    }

    public interface ICompositeChild<T> : IEnumerable<List<T>>
    {
    }

    public class CompositeChild<T> : List<List<T>>, ICompositeChild<T>
    {
    }

    public interface ICompositeDelegateChild<T> : IEnumerable<Func<T>>
    {
    }

    public class CompositeDelegateChild<T> : List<Func<T>>, ICompositeDelegateChild<T>
    {
    }

}`

        private const Prelude string = (`import Issue4420.Library
import System
import System.Collections
import System.Collections.Generic
import System.Linq

func TakeEnum(xs IEnumerable[string]) int32 { return xs.Count() }

func TakeRo(xs IReadOnlyList[string]) int32 { return xs[1].Length }

func TakeNilable(xs IEnumerable[string?]) int32 { return xs.Count() }

func TakeUntyped(xs IEnumerable) int32 { return 1 }

func TakeObjects(xs IEnumerable[object]) int32 { return xs.Count() }

func TakeNested(xs IEnumerable[List[string]]) int32 { return xs.Count() }

func TakeFactories(xs IEnumerable[Func[string]]) int32 { return xs.Count() }

func TakeNilableObjects(xs IEnumerable[object?]) int32 { return xs.Count() }

func TakeFactory(f Func[object]) int32 { return 1 }

// An ` + "`" + `IEnumerable[string!]` + "`" + ` itself: the same generic definition as the
// target, reaching ` + "`" + `IEnumerable[object]` + "`" + ` through covariance.
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

// A sink of ` + "`" + `string!` + "`" + ` elements: inferred from the list's nested
// element, so the parameter type is ` + "`" + `IIn[string!]` + "`" + `.
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

// Inferred from the list's NESTED element, which keeps ` + "`" + `string!` + "`" + ` (a
// top-level ` + "`" + `T!` + "`" + ` argument would infer ` + "`" + `string` + "`" + `, #4443), so this is an
// ` + "`" + `IView[string!]` + "`" + `.
func ViewOfFirst[T](xs List[T]) IView[T] { return ViewRepo[T](xs[0]) }

func Keep(s string) string { return s }

open class Parent[T] {
}

class Child[T] : Parent[T] {
}

func ChildOfFirst[T](xs List[T]) Child[T] { return Child[T]() }

func TakeParent(x Parent[string]) int32 { return 1 }

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
`)

        private func CompileErrors(library CSharpFixture, program string)[]string {
            using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + program))){
                Nullability = NullabilityMode.PlatformTypes
            }
            return compilation
                .GlobalScope
                .Diagnostics
                .Concat(compilation.BoundProgram.Diagnostics)
                .Where((d Diagnostic) -> d.IsError)
                .Select((d Diagnostic) -> (d.Id + ": " + d.Message))
                .ToArray()
        }

        private func Run(library CSharpFixture, program string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + program))){
                AssemblyName = "Issue4420",
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
                "Issue4420PlatformUpcastTests" + Guid.NewGuid().ToString("N"),
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
