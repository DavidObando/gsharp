// <copyright file="Issue1638ClrCallPipelineDriftTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #1638: the five CLR call-construction pipeline copies (ctor, static,
/// instance, inherited-instance, imported extension) had drifted — some
/// skipped a step the others ran. Two of those drifts were genuine latent
/// bugs, now fixed by routing every site through the shared
/// `BuildResolvedClrCallArguments` helper:
/// - The CTOR path never ran `RebindFunctionLiteralDelegateArguments`, so a value-returning
/// arrow-lambda argument could not target a delegate-typed constructor parameter (issue #889's fix
/// never reached ctors).
/// - The INHERITED-INSTANCE path never ran `RebindFormattableInterpolationArguments`, so an
/// interpolated string argument could not target an `IFormattable`/`FormattableString` parameter of a
/// method inherited (unoverridden) from an imported CLR base class.
/// The (intentionally unchanged) imported-extension path still narrows its
/// delegate-rebind step to numeric-return-widening only (issues #1150/#1334);
/// that divergence is preserved via the helper's
/// `ClrCallDelegateRebindMode` parameter, not treated as drift.
open class Issue1638ClrCallPipelineDriftTests {
    @Fact
    func Ctor_ArrowLambda_ValueReturning_ToActionParameter_VoidizesAndRuns() {
        const Source = `package Issue1638Ctor
import System
import GSharp.Core.Tests.Fixtures

var called = 0
let x = Issue1638ActionCtorFixture(() -> called = called + 1)
Console.WriteLine(called)
Console.WriteLine(x.Invoked)
`
        let output = CompileAndRun(Source, "Issue1638Ctor")
        Assert.Equal(
            "1${Environment.NewLine}True${Environment.NewLine}",
            output.ReplaceLineEndings(Environment.NewLine)
        )
    }

    @Fact
    func InheritedInstance_InterpolatedString_ToFormattableStringParameter_Rebinds() {
        const Source = `package Issue1638Inherited
import System
import GSharp.Core.Tests.Fixtures

class MyRenderer : Issue1638FormattableBaseFixture {
}

let r = MyRenderer()
let n = 42
let s = r.Render("n=${n:D3}")
Console.WriteLine(s)
`
        let output = CompileAndRun(Source, "Issue1638Inherited")
        Assert.Equal("n=042${Environment.NewLine}", output.ReplaceLineEndings(Environment.NewLine))
    }

    shared {
        private func CompileAndRun(source string, contextName string) string {
            // Issue #4656: the C# text survives the fixtures' translation to G#.
            using let fixture = CSharpFixture(TestSource.CSharpFixtureSource("InterpolatedStringHandlerFixtures.cs"))
            using let references = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
            Assert.True(
                references.TryResolveType(
                    "GSharp.Core.Tests.Fixtures.Issue1638FormattableBaseFixture",
                    out var baseType
                )
            )
            Assert.False(baseType.IsSealed)
            using let peStream = MemoryStream()
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(references, tree)
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
                using let dependency = File.OpenRead(fixture.AssemblyPath)
                loadContext.LoadFromStream(dependency)
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
