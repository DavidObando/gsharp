// <copyright file="Issue4451ObliviousGenericSlotTests.cs" company="GSharp">
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

/// Issue #4451, ADR-0186 §4: a platform-typed argument passed to an imported
/// method's non-null reference parameter is a coercion point, so it is
/// checked at the call. Both sides of such a pair erase to one CLR type
/// (`string!` at `string`), and the imported-call argument binder
/// only converted an argument whose CLR shape differed, so the check was never
/// inserted for any imported callee.
///
/// The reported shape, an oblivious `List<T> WrapList<T>(T value)`
/// closed as `WrapList[string]`, used to read its parameter as
/// `string` and its return as `List[string]`, so a nil entered a
/// non-null list and surfaced later as an unattributed
/// (cref:NullReferenceException). Under the ADR-0193 amendment
/// (owner decision, 2026-09-26) that call now binds `T = string!`: it
/// takes the nil unchecked, returns `List[string!]`, and the nil is
/// checked where an element is read
/// ((cref:An_Explicit_Argument_At_An_Oblivious_Slot_Reads_As_Platform)).
///
/// A parameter the callee leaves oblivious (`T!`) or declares nullable
/// (`T?`) accepts the nil unchecked, as before.
open class Issue4451ObliviousGenericSlotTests {
    /// The issue's repro and its siblings: each nil argument fails at the call
    /// with §4's attributed message. Before the fix none of them was checked.
    /// @param program The G# statements.
    @Theory
    @InlineData("Console.WriteLine(En.EchoEnabled[string](Ob.Nil()))")
    @InlineData("Console.WriteLine(Mixed.Pair[string](Ob.Name(), Ob.Nil()))")
    @InlineData("Console.WriteLine(En.TakeEnabled(Ob.Nil()))")
    @InlineData("let b = Box(Ob.Name())\nConsole.WriteLine(b.Measure(Ob.Nil()))")
    @InlineData("let b = Box(Ob.Nil())\nConsole.WriteLine(b.Value.Length)")
    @InlineData(`class Taker : ITaker {
    func Take(value string) int32 { return 7 }
}
func Via[T ITaker](x T) int32 { return x.Take(Ob.Nil()) }
Console.WriteLine(Via(Taker()))`)
    func A_Nil_Platform_Argument_To_A_NonNull_Imported_Parameter_Fails_At_The_Call(program string) {
        using let library = CSharpFixture(LibrarySource)
        let thrown = Assert.Throws[NullReferenceException](
            func () object? {
                return Run(library, program)
            }
        )
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal)
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal)
    }

    /// The check is inserted only where the parameter is non-null. An
    /// oblivious parameter and a `string?` parameter both receive the nil
    /// unchecked, including a slot that is `string?` only through the
    /// receiver's type argument (`List[string?].Add`, and a constrained
    /// `IBox[string?]`, both of which reflect as a CLR `string`), and
    /// a `[NotNullWhen]` guard still narrows the bare platform variable it
    /// is handed.
    @Fact
    func A_Nil_Reaches_An_Oblivious_Or_Nilable_Parameter_Unchecked() {
        using let library = CSharpFixture(LibrarySource)
        const program = `let s = Ob.Nil()
Console.WriteLine(ObMore.TakeOblivious(s))
Console.WriteLine(En.TakeNilable(s))
if !String.IsNullOrEmpty(s) {
    Console.WriteLine(s.Length)
} else {
    Console.WriteLine("empty")
}
let named = Ob.Name()
Console.WriteLine(Ob.WrapList[string](named)[0])
let nilables = List[string?]()
nilables.Add(Ob.Nil())
Console.WriteLine(nilables.Count)
Console.WriteLine(ViaBox(NilBox()))`
        const declarations = `class NilBox : IBox[string?] {
    func Put(value string?) int32 { return value == nil ? -1 : 1 }
}

func ViaBox[T IBox[string?]](x T) int32 { return x.Put(Ob.Nil()) }
`
        Assert.Equal(`-1
-1
empty
n
1
-1
`, Run(library, declarations + program))
    }

    /// ADR-0193 amendment (owner decision, 2026-09-26): an explicit type
    /// argument that closes an open slot an oblivious declaration leaves
    /// unstated reads as `T!`, at the parameter and at the return.
    /// `Ob.WrapList[string]` returns a `List[string!]` and
    /// `Ob.Echo[string]` a `string!`. No check is inserted at the
    /// call, so `IsNil[string](nil)` keeps the C# answer, `true`, and
    /// a nil element read through the list is checked where it is used.
    @Fact
    func An_Explicit_Argument_At_An_Oblivious_Slot_Reads_As_Platform() {
        using let library = CSharpFixture(LibrarySource)
        Assert.StartsWith(
            "System.Collections.Generic.List[string!]",
            ProbeType(library, "let probe = Ob.WrapList[string](Ob.Name())"),
            StringComparison.Ordinal
        )
        Assert.Equal("string!", ProbeType(library, "let probe = Ob.Echo[string](Ob.Name())"))
        Assert.Equal(`1
True
`, Run(library, `let xs = Ob.WrapList[string](Ob.Nil())
Console.WriteLine(xs.Count)
Console.WriteLine(Ob.IsNil[string](Ob.Nil()))`))
        let thrown = Assert.Throws[NullReferenceException](
            func () object? {
                return Run(library, `let xs = Ob.WrapList[string](Ob.Nil())
Console.WriteLine(xs.Count)
Console.WriteLine(xs[0].Length)`)
            }
        )
        Assert.Contains("nullability-oblivious", thrown.Message, StringComparison.Ordinal)
        Assert.Contains("coerced at", thrown.Message, StringComparison.Ordinal)
    }

    shared {
        private const LibrarySource string = (`namespace Issue4451.Library
{
    using System.Collections.Generic;

    public static class Ob
    {
        public static string Nil() { return null; }

        public static string Name() { return "n"; }

        public static List<T> WrapList<T>(T value) { return new List<T> { value }; }

        public static T Echo<T>(T value) { return value; }

        public static bool IsNil<T>(T value) where T : class { return value == null; }
    }

    public static class Mixed
    {
        // ` + "`" + `T` + "`" + ` fills an oblivious slot and a non-null one.
#nullable disable
        public static int Pair<T>(T oblivious,
#nullable enable
            T stated) where T : class { return 1; }
#nullable restore
    }

    public static class ObMore
    {
        public static int TakeOblivious(string value) { return value == null ? -1 : value.Length; }
    }

#nullable enable
    public static class En
    {
        public static int TakeEnabled(string value) { return 7; }

        public static T EchoEnabled<T>(T value) { return value; }

        public static int TakeNilable(string? value) { return value == null ? -1 : value.Length; }
    }

    public sealed class Box
    {
        public Box(string value) { this.Value = value; }

        public string Value { get; }

        public int Measure(string other) { return other.Length; }
    }

    public interface ITaker
    {
        int Take(string value);
    }

    public interface IBox<T>
    {
        int Put(T value);
    }
#nullable restore
}`)

        private const Prelude string = `import Issue4451.Library
import System
import System.Collections.Generic
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
            return SymbolDisplay.ToTypeDisplayString(type)
        }

        private func Run(library CSharpFixture, program string) string {
            using let resolver = ReferenceResolver.WithReferences([]string{library.AssemblyPath})
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(Prelude + program))){
                AssemblyName = "Issue4451",
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
                "Issue4451ObliviousGenericSlotTests" + Guid.NewGuid().ToString("N"),
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
