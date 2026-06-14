// <copyright file="SlotDictionaryAliasingAssertionTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// Issue #420 (P3-3): pre-allocated slot dictionaries
/// (<c>structLiteralSlots</c>, <c>receiverSpillSlots</c>,
/// <c>defaultExpressionSlots</c>, <c>mapIndexSlots</c>) in
/// <c>ReflectionMetadataEmitter</c> are keyed by bound-node identity. If a
/// future lowering pass started sharing the same bound-node instance across
/// two emit positions, the slot dictionaries would silently alias.
///
/// These tests guard the defensive <c>Debug.Assert</c> calls that were
/// added at the allocation sites, and verify that the normal (non-aliased)
/// compile paths exercising every slot kind still emit and execute
/// correctly.
/// </summary>
public class SlotDictionaryAliasingAssertionTests
{
    [Fact]
    public void StructLiteral_DefaultExpression_And_MapIndex_AllExercised_DoesNotTripAssertion()
    {
        // Combined program exercises:
        //  * struct literal slots (Point{X:1, Y:2}),
        //  * default-expression slots (default(Point)),
        //  * map index read slots (m[k]).
        // A successful compile + execute proves the Debug.Assert calls in
        // CollectSlots do not fire on the normal binder/lowering path.
        var source = @"
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
m[""hello""] = 7
var v = m[""hello""]
var miss = m[""nope""]
Console.WriteLine(p.X + p.Y + z.X + z.Y + v + miss)
";
        var output = CompileLoadInvokeCaptureStdout(
            source,
            nameof(StructLiteral_DefaultExpression_And_MapIndex_AllExercised_DoesNotTripAssertion));
        Assert.Contains("37", output);
    }

    [Fact]
    public void EmitterSource_ContainsAliasingAssertions_ForAllFourSlotDictionaries()
    {
        // Documentation test: scan the emitter sources for the four
        // assertion sites added for issue #420 (P3-3). If a future refactor
        // removes one, this test fails loudly so the defensive guarantee
        // cannot be silently dropped.
        //
        // PR-0 generalization: as the Binder/Emitter decomposition plan
        // moves these allocation sites out of ReflectionMetadataEmitter.cs
        // into sibling files (SlotPlanner, MetadataTokenCache, …), this
        // test now reads every C# file under src/Core/CodeAnalysis/Emit/
        // and asserts each expected substring is present in *any* of them.
        var emitterSources = LocateEmitterSources();
        Assert.NotEmpty(emitterSources);

        var combinedText = string.Join(
            "\n// ---- next file ----\n",
            emitterSources.Select(File.ReadAllText));

        Assert.Contains("!structLiteralSlots.ContainsKey(literal)", combinedText);
        Assert.Contains("!mapIndexSlots.ContainsKey(idx)", combinedText);
        Assert.Contains("!defaultExpressionSlots.ContainsKey(def)", combinedText);

        // receiverSpillSlots intentionally deduplicates via a `ContainsKey`
        // guard at the allocation site — aliased receivers across spill
        // positions share a slot by design. Make sure that explicit guard
        // is still present so that aliasing remains safe.
        Assert.Contains("if (receiverSpillSlots.ContainsKey(receiver))", combinedText);
        Assert.Contains("if (receiverSpillSlots.ContainsKey(assn))", combinedText);
    }

    private static string[] LocateEmitterSources()
    {
        // Tests run with CWD = <bin>/<tfm>/. Walk up to repo root and
        // glob the entire Emit directory so that the Binder/Emitter
        // decomposition can split ReflectionMetadataEmitter.cs without
        // tripping this test on the first move.
        var dir = AppContext.BaseDirectory;
        for (int i = 0; i < 10 && dir is not null; i++)
        {
            var candidateDir = Path.Combine(dir, "src", "Core", "CodeAnalysis", "Emit");
            if (Directory.Exists(candidateDir))
            {
                return Directory.GetFiles(candidateDir, "*.cs", SearchOption.TopDirectoryOnly);
            }

            dir = Path.GetDirectoryName(dir);
        }

        throw new DirectoryNotFoundException(
            "Could not locate src/Core/CodeAnalysis/Emit by walking up from " + AppContext.BaseDirectory);
    }

    private static EmitResult Compile(string source, Stream peStream)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new Compilation(tree);
        return compilation.Emit(peStream);
    }

    private static string CompileLoadInvokeCaptureStdout(string source, string contextName)
    {
        using var peStream = new MemoryStream();
        var result = Compile(source, peStream);
        Assert.True(
            result.Success,
            "compilation should succeed: " + string.Join("; ", result.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        var loadContext = new AssemblyLoadContext(contextName, isCollectible: true);
        try
        {
            var asm = loadContext.LoadFromStream(peStream);
            var programType = asm.GetTypes().FirstOrDefault(t => t.Name == "<Program>");
            Assert.NotNull(programType);
            var entry = programType!.GetMethod(
                "<Main>$",
                BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            Assert.NotNull(entry);

            var stdout = Console.Out;
            var captured = new StringWriter();
            Console.SetOut(captured);
            try
            {
                entry!.Invoke(null, entry.GetParameters().Length == 0 ? null : new object[] { System.Array.Empty<string>() });
            }
            finally
            {
                Console.SetOut(stdout);
            }

            return captured.ToString();
        }
        finally
        {
            loadContext.Unload();
        }
    }
}
