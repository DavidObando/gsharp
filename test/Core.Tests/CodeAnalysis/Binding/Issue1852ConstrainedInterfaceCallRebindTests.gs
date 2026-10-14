// <copyright file="Issue1852ConstrainedInterfaceCallRebindTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #1852 (follow-up N1 from #1812 / PR #1848): the CONSTRAINED CLR
/// INTERFACE-CALL path (`ExpressionBinder.TryBindConstrainedClrInterfaceCall`)
/// is the sixth CLR-call construction shape — a generic method dispatching a
/// call on a type-parameter receiver constrained to an imported CLR
/// interface (e.g. `func Render[T IIssue1852Renderer](x T) string`).
/// #1812 deliberately left this path's `interpolatedStringArgs` flag
/// unset because the path skips the whole CLR parameter-conversion pipeline
/// (the emitted MemberRef parameter is the interface type-variable
/// `!0`, passed unconverted). This fix passes the flag to
/// `ClrOverloadResolution.Resolve` and, after the interface method is
/// selected, re-lowers any interpolated-string argument whose resolved
/// parameter is IFormattable/FormattableString-shaped via
/// `RebindFormattableInterpolationArguments` — mirroring the
/// instance/extension/base-ctor rebind step — WITHOUT running the rest of
/// the conversion pipeline that path exists to avoid.
open class Issue1852ConstrainedInterfaceCallRebindTests {
    @Fact
    func ConstrainedInterfaceCall_InterpolatedString_ToFormattableStringParameter_Rebinds() {
        const Source = `package Issue1852Constrained
import System
import GSharp.Core.Tests.Fixtures

func Render[T IIssue1852Renderer](x T) string {
    let n = 42
    return x.Render("n=${n:D3}")
}

let s = Render(Issue1852RendererFixture())
Console.WriteLine(s)
`
        let output = CompileAndRun(Source, "Issue1852Constrained")
        Assert.Equal("n=042${Environment.NewLine}", output.ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func ConstrainedInterfaceCall_MixedInterpolatedAndPlainArgs_RebindsOnlyHandlerArg() {
        // Generalization: a non-handler positional argument (`tag`, a plain
        // `string` parameter) precedes the handler-shaped one. Only the
        // interpolated-string argument bound to the FormattableString
        // parameter should rebind; the plain-string argument and its
        // parameter index must be unaffected.
        const Source = `package Issue1852ConstrainedMixed
import System
import GSharp.Core.Tests.Fixtures

func RenderTwo[T IIssue1852Renderer](x T) string {
    let n = 42
    return x.RenderTwo("tag", "n=${n:D3}")
}

let s = RenderTwo(Issue1852RendererFixture())
Console.WriteLine(s)
`
        let output = CompileAndRun(Source, "Issue1852ConstrainedMixed")
        Assert.Equal("tag:n=042${Environment.NewLine}", output.ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func ConstrainedInterfaceCall_OrdinaryNonHandlerCall_OverloadChoiceUnchanged() {
        // Regression guard (per #1812 N1's concern): an ordinary constrained
        // interface call with no interpolated-string argument at all — the
        // #1336 `T IComparable[T]` shape — must still resolve/bind/evaluate
        // identically now that `interpolatedStringArgs` is threaded through.
        const source = `
package p
import System
class C {
    func Cmp[T IComparable[T]](a T, b T) int32 {
        return a.CompareTo(b)
    }
    func Ok() int32 { return Cmp[int32](1, 2) }
}
`
        let tree = SyntaxTree.Parse(SourceText.From(source))
        let compilation = Compilation(tree){IsLibrary = true}
        Assert.Empty(compilation.GlobalScope.Diagnostics)
    }

    shared {
        private func CompileAndRun(source string, contextName string) string {
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            try {
                let asm = loadContext.LoadFromStream(peStream)
                let programType Type? = asm.GetTypes().FirstOrDefault((t Type) -> t.Name == "<Program>")
                Assert.NotNull(programType)
                let entry MethodInfo? = programType!!.GetMethod(
                    "<Main>$$",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic
                )
                Assert.NotNull(entry)
                let stdout = Console.Out
                let captured = StringWriter()
                Console.SetOut(captured)
                try {
                    entry!!.Invoke(
                        nil,
                        if entry!!.GetParameters().Length == 0 {
                            default([]?object)
                        } else {
                            []object{Array.Empty[string]()}
                        }
                    )
                } finally {
                    Console.SetOut(stdout)
                }
                return captured.ToString()
            } finally {
                loadContext.Unload()
            }
        }
    }
}
