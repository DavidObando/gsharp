// <copyright file="SlotDictionaryAliasingAssertionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #420 (P3-3): pre-allocated slot dictionaries
/// (`structLiteralSlots`, `receiverSpillSlots`,
/// `defaultExpressionSlots`, `mapIndexSlots`) in
/// `ReflectionMetadataEmitter` are keyed by bound-node identity. If a
/// future lowering pass started sharing the same bound-node instance across
/// two emit positions, the slot dictionaries would silently alias.
///
/// These tests guard the defensive `Debug.Assert` calls that were
/// added at the allocation sites, and verify that the normal (non-aliased)
/// compile paths exercising every slot kind still emit and execute
/// correctly.
open class SlotDictionaryAliasingAssertionTests {
    @Fact
    func StructLiteral_DefaultExpression_And_MapIndex_AllExercised_DoesNotTripAssertion() {
        // Combined program exercises:
        //  * struct literal slots (Point{X:1, Y:2}),
        //  * default-expression slots (default(Point)),
        //  * map index read slots (m[k]).
        // A successful compile + execute proves the Debug.Assert calls in
        // CollectSlots do not fire on the normal binder/lowering path.
        let source = `
package SlotComboTest
import System

struct Point {
    var X int32
    var Y int32
}

func makePoint() Point {
    return Point{X: 10, Y: 20}
}

var p = makePoint()
var z Point
var m = map[string,int32]{}
m["hello"] = 7
var v = m["hello"]
var miss = m["nope"]
Console.WriteLine(p.X + p.Y + z.X + z.Y + v + miss)
`
        let output = CompileLoadInvokeCaptureStdout(
            source,
            "StructLiteral_DefaultExpression_And_MapIndex_AllExercised_DoesNotTripAssertion"
        )
        Assert.Contains("37", output)
    }

    @Fact
    func EmitterSource_ContainsAliasingAssertions_ForAllFourSlotDictionaries() {
        // Documentation test: scan the emitter sources for the four
        // assertion sites added for issue #420 (P3-3). If a future refactor
        // removes one, this test fails loudly so the defensive guarantee
        // cannot be silently dropped.
        //
        // PR-0 generalization: as the Binder/Emitter decomposition plan
        // moves these allocation sites out of ReflectionMetadataEmitter.cs
        // into sibling files (SlotPlanner, MetadataTokenCache, …), this
        // test now reads every source file under src/Core/CodeAnalysis/Emit/
        // and asserts each expected substring is present in *any* of them.
        let emitterSources = LocateEmitterSources()
        Assert.NotEmpty(emitterSources)
        let combinedText = string.Join(`
// ---- next file ----
`, emitterSources.Select(File.ReadAllText))
        Assert.Contains("!structLiteralSlots.ContainsKey(literal)", combinedText)
        Assert.Contains("!mapIndexSlots.ContainsKey(idx)", combinedText)
        Assert.Contains("!defaultExpressionSlots.ContainsKey(def)", combinedText)
        // receiverSpillSlots intentionally deduplicates via a `ContainsKey`
        // guard at the allocation site — aliased receivers across spill
        // positions share a slot by design. Make sure that explicit guard
        // is still present so that aliasing remains safe.
        // Issue #4656: `if (x)` in C#, `if x {` in G#. The guard must be the
        // WHOLE condition: closed by `)` in C# or followed by the arm's `{`.
        Assert.Matches(IfGuard("receiver"), combinedText)
        Assert.Matches(IfGuard("assn"), combinedText)
    }

    shared {
        private func IfGuard(
            key string
        ) string -> "\\bif\\s*(?:\\(\\s*receiverSpillSlots\\.ContainsKey\\(\\s*$key\\s*\\)\\s*\\)|receiverSpillSlots\\.ContainsKey\\(\\s*$key\\s*\\)\\s*\\{)"

        // Issue #4656: the tree's own language, and an empty scan throws.
        private func LocateEmitterSources() IReadOnlyList[string] -> TestSource.SourceFiles(
            SearchOption.TopDirectoryOnly,
            "src/Core/CodeAnalysis/Emit"
        )

        private func Compile(source string, peStream Stream) EmitResult {
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(tree)
            return compilation.Emit(peStream)
        }

        private func CompileLoadInvokeCaptureStdout(source string, contextName string) string {
            using let peStream = MemoryStream()
            let result = Compile(source, peStream)
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
