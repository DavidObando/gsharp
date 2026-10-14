// <copyright file="Issue4444PlatformUserTypeResolutionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #4444: a platform type over a G#-declared type (`Node!`, from an
/// `@Oblivious` scope) must resolve exactly as `Node` does. ADR-0186
/// §1 says `T!` has `T`'s signature, and §5a says lookup on a
/// `T!` runs against `T`.
///
/// The one root cause: overload resolution ranks imported candidates on each
/// argument's effective CLR type. That projection had an arm for every
/// G#-declared type, but none for one under a platform wrapper, so an imported
/// call that received such an argument never ranked a candidate. That gave
/// GS0159 for `List[Node].Add(n)`, for a method group whose signature is
/// `(Node!) -> string!` passed to `Select`, and for an extension
/// call over such a value. The same calls over a BCL type (`string!`)
/// bound, because `string` has a CLR type.
///
/// Each program keeps its container element types out of the oblivious scope
/// (lists come from enabled functions or from inferred locals), so the tests
/// hold whichever way that scope reads a nested position.
open class Issue4444PlatformUserTypeResolutionTests {
    /// A `Node!` argument to `List[Node].Add(T)` binds. At run time
    /// the argument is checked at the `T! → T` coercion (§4), so a nil
    /// throws (cref:NullReferenceException) at the call instead of
    /// entering the list.
    @Fact
    func A_Platform_User_Type_Argument_Binds_To_A_Generic_Instance_Method() {
        const source = `@Oblivious
func AddTwo(first Node, second Node) int32 {
    let xs = NewList()
    xs.Add(first)
    xs.Add(second)
    return xs.Count
}

func Probe() string {
    let two = AddTwo(Node{}, Node{})
    try {
        AddTwo(Node{}, nil)
        return "no throw"
    } catch (e NullReferenceException) {
        return "${two} then NRE"
    }
}

Console.WriteLine(Probe())`
        Assert.Equal("2 then NRE\n", Run(source))
    }

    /// The same argument binds as a collection-initializer element.
    @Fact
    func A_Platform_User_Type_Element_Binds_In_A_Collection_Initializer() {
        const source = `@Oblivious
func Wrap(first Node, second Node) int32 {
    let xs = List[Node]{first, second}
    return xs.Count
}

Console.WriteLine(Wrap(Node{}, Node{}))`
        Assert.Equal("2\n", Run(source))
    }

    /// A method group whose signature is `(Node!) -> string!` infers
    /// `Select`'s type arguments, from an oblivious caller and from an
    /// enabled one.
    @Fact
    func A_Platform_User_Type_Method_Group_Infers_A_Generic_Call() {
        const source = `@Oblivious
func Render(n Node) string { return n.Name }

@Oblivious
func FromOblivious() string {
    return String.Join(",", Nodes().Select(Render))
}

func FromEnabled() string {
    return String.Join(",", Nodes().Select(Render))
}

Console.WriteLine(FromOblivious() + "|" + FromEnabled())`
        Assert.Equal("n,n|n,n\n", Run(source))
    }

    /// A `Node!` passed to an imported generic static method binds as a
    /// `Node` would: `Enumerable.Repeat(first, 2)`. The erased
    /// projection that gates the static call is what this pins
    /// (`MemberLookup.TryProjectErasedClrType`); `Where` on a list
    /// built in the scope is kept as a control that binds either way.
    @Fact
    func A_Platform_User_Type_Argument_Binds_An_Imported_Generic_Static_Call() {
        const source = `@Oblivious
func CountNamed(first Node) int32 {
    let xs = NewList()
    xs.Add(first)
    return xs.Where((n Node) -> n.Name != nil).Count()
        + Enumerable.Repeat(first, 2).Count()
}

Console.WriteLine(CountNamed(Node{}))`
        Assert.Equal("3\n", Run(source))
    }

    shared {
        private const Prelude string = `package Probe
import System
import System.Linq
import System.Collections.Generic

class Node {
    var Name string = "n"
}

func NewList() List[Node] { return List[Node]() }

func Nodes() List[Node] { return List[Node]{Node{}, Node{}} }
`

        private func Run(declarations string) string {
            let compilation = GsCompilation(SyntaxTree.Parse(SourceText.From(Prelude + declarations))){
                Nullability = NullabilityMode.PlatformTypes
            }
            compilation.AssemblyName = "Issue4444"
            using let pe = MemoryStream()
            let emit = compilation.Emit(pe, pdbStream: nil, refStream: nil, assemblyName: compilation.AssemblyName)
            Assert.True(
                emit.Success,
                string.Join(Environment.NewLine, emit.Diagnostics.Select((d Diagnostic) -> "${d.Id}: ${d.Message}"))
            )
            let context = AssemblyLoadContext(
                "Issue4444PlatformUserTypeResolutionTests" + Guid.NewGuid().ToString("N"),
                isCollectible: true
            )
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
                    throw invocation.InnerException
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
