// <copyright file="Issue1812ClrCallResolveTests.cs" company="GSharp">
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

/// Issue #1812 (follow-up to #1638 / PR #1811): the STATIC and EXTENSION
/// CLR-call construction paths in `ExpressionBinder.Calls.cs` must pass
/// `interpolatedStringArgs` to their `ClrOverloadResolution.Resolve`
/// call — the same flag the ctor, instance, and inherited-instance paths
/// already forward — so an interpolated-string argument bound to an
/// `IFormattable`/`FormattableString` parameter resolves and
/// rebinds consistently no matter which of the five call shapes dispatches
/// it. These tests mirror
/// `Issue1638ClrCallPipelineDriftTests.InheritedInstance_InterpolatedString_ToFormattableStringParameter_Rebinds`
/// for the static and extension shapes.
open class Issue1812ClrCallResolveTests {
    @Fact
    func StaticCall_InterpolatedString_ToFormattableStringParameter_Rebinds() {
        const Source = `package Issue1812Static
import System
import GSharp.Core.Tests.Fixtures

let n = 42
let s = Issue1812StaticFormattableFixture.Render("n=${n:D3}")
Console.WriteLine(s)
`
        let output = CompileAndRun(Source, "Issue1812Static")
        Assert.Equal("n=042${Environment.NewLine}", output.ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func ExtensionCall_InterpolatedString_ToFormattableStringParameter_Rebinds() {
        const Source = `package Issue1812Extension
import System
import GSharp.Core.Tests.Fixtures

let n = 42
let prefix = "val:"
let s = prefix.Render("n=${n:D3}")
Console.WriteLine(s)
`
        let output = CompileAndRun(Source, "Issue1812Extension")
        Assert.Equal("val:n=042${Environment.NewLine}", output.ReplaceLineEndings(Environment.NewLine))
    }

    @Fact
    func BaseCtorCall_InterpolatedString_ToFormattableStringParameter_Rebinds() {
        // Issue #1812 companion gap: `: base(...)` against an imported CLR base
        // constructor is a sixth CLR-call construction shape found during the
        // audit (beyond the five #1638 named). It must accept an
        // interpolated-string argument against a FormattableString parameter
        // exactly like the other five.
        const Source = `package Issue1812BaseCtor
import System
import GSharp.Core.Tests.Fixtures

class MyThing : Issue1812BaseCtorFormattableFixture {
    init(n int32) : base("n=${n:D3}") {
    }
}

let t = MyThing(42)
Console.WriteLine(t.Rendered)
`
        let output = CompileAndRun(Source, "Issue1812BaseCtor")
        Assert.Equal("n=042${Environment.NewLine}", output.ReplaceLineEndings(Environment.NewLine))
    }

    shared {
        private func CompileAndRun(source string, contextName string) string {
            // Issue #4656: the C# text survives the fixtures' translation to G#.
            using let fixture = CSharpFixture(TestSource.CSharpFixtureSource("InterpolatedStringHandlerFixtures.cs"))
            using let references = ReferenceResolver.WithReferences([]string{fixture.AssemblyPath})
            Assert.True(
                references.TryResolveType(
                    "GSharp.Core.Tests.Fixtures.Issue1812BaseCtorFormattableFixture",
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
