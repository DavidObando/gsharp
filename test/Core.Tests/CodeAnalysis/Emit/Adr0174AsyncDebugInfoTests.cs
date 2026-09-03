// <copyright file="Adr0174AsyncDebugInfoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using GSharp.Tests;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Emit;

/// <summary>
/// ADR-0174 P3-8, the debugging gate for inferred suspension: a suspending or
/// async kickoff carries <c>[AsyncStateMachine(typeof(SM))]</c> (so the
/// runtime's <c>StackTrace</c> and a debugger name the logical function, not
/// <c>&lt;f&gt;d__1.MoveNext</c>) and <c>[DebuggerStepThrough]</c>; the
/// Portable PDB carries an async-method-stepping blob for every
/// <c>MoveNext</c> with one yield/resume offset pair per await and the
/// outermost catch handler, which is what a debugger's step-over uses to
/// land on the next source line across a parked channel receive.
/// </summary>
/// <remarks>
/// Discrimination witnesses (ADR-0154): a mutant that serializes the state
/// machine's name without its enclosing type breaks
/// <see cref="Kickoff_CarriesAsyncStateMachineAttribute_ResolvingToItsStateMachine"/>
/// (the attribute's <c>StateMachineType</c> fails to resolve) and
/// <see cref="StackTrace_InsideASuspendingFunction_NamesTheLogicalFunction"/>;
/// a mutant that records only yield offsets breaks
/// <see cref="Pdb_MoveNext_CarriesOneYieldResumePairPerAwait"/>.
/// </remarks>
public class Adr0174AsyncDebugInfoTests
{
    private static readonly Guid AsyncMethodSteppingInformationKind = new Guid("54FD2AC5-E925-401A-9C2A-F94F171072F8");

    [Fact]
    public void Kickoff_CarriesAsyncStateMachineAttribute_ResolvingToItsStateMachine()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Dbg
            suspend func take(ch in chan[int32]) int32 {
                return <-ch
            }
            async func twice(n int32) int32 {
                return n * 2
            }
            let ch = chan[int32](1)
            ch <- 4
            take(ch)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(4, result.Value);

        var program = Assert.IsAssignableFrom<Type>(result.Assembly.GetType("P0174Dbg.<Program>"));
        foreach (var name in new[] { "take", "twice" })
        {
            var kickoff = program.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            Assert.NotNull(kickoff);
            var stateMachine = kickoff!.GetCustomAttribute<AsyncStateMachineAttribute>();
            Assert.NotNull(stateMachine);
            Assert.StartsWith("<" + name + ">d__", stateMachine!.StateMachineType.Name);
            Assert.Same(program, stateMachine.StateMachineType.DeclaringType);
            Assert.NotNull(kickoff.GetCustomAttribute<DebuggerStepThroughAttribute>());
        }
    }

    [Fact]
    public void Kickoff_Attribute_ResolvesForMethods_Generics_AndLambdas()
    {
        // The serialized state-machine name must follow the struct's nesting:
        // a user class for a method, `<Program>` with the arity suffix for a
        // generic function, and the display class for an async lambda.
        var result = EmittedOracle.Evaluate("""
            package P0174DbgNest
            import System
            import System.Threading.Tasks
            class Reader {
                suspend func Take(ch in chan[int32]) int32 {
                    return <-ch
                }
            }
            suspend func first[T](ch in chan[T]) T {
                return <-ch
            }
            func viaLambda(n int32) int32 {
                let f = async func(x int32) int32 {
                    await Task.Yield()
                    return x + n
                }
                return f(1).Result
            }
            let ch = chan[int32](2)
            ch <- 5
            ch <- 6
            let r = Reader()
            r.Take(ch) + first[int32](ch) + viaLambda(2)
            """);

        Assert.Empty(result.Diagnostics);
        Assert.Equal(14, result.Value);

        var resolved = new List<string>();
        foreach (var type in result.Assembly.GetTypes())
        {
            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                var attribute = method.GetCustomAttribute<AsyncStateMachineAttribute>();
                if (attribute != null)
                {
                    Assert.NotNull(attribute.StateMachineType);
                    Assert.Same(type, attribute.StateMachineType.DeclaringType);
                    resolved.Add(attribute.StateMachineType.Name);
                }
            }
        }

        Assert.Contains(resolved, name => name.StartsWith("<Take>d__", StringComparison.Ordinal));
        Assert.Contains(resolved, name => name.StartsWith("<first>d__", StringComparison.Ordinal) && name.EndsWith("`1", StringComparison.Ordinal));
        Assert.Equal(3, resolved.Count);
    }

    [Fact]
    public void StackTrace_InsideASuspendingFunction_NamesTheLogicalFunction()
    {
        var result = EmittedOracle.Evaluate("""
            package P0174Trace
            import System
            suspend func inner(ch in chan[int32]) string {
                let v = <-ch
                return Environment.StackTrace
            }
            let ch = chan[int32](1)
            ch <- 1
            inner(ch)
            """);

        Assert.Empty(result.Diagnostics);
        var trace = Assert.IsType<string>(result.Value);
        Assert.Contains("P0174Trace.<Program>.inner(", trace, StringComparison.Ordinal);
        Assert.DoesNotContain("d__", trace, StringComparison.Ordinal);
    }

    [Fact]
    public void Pdb_MoveNext_MapsEverySourceLineOfTheSuspendingBody()
    {
        // Without this, a debugger cannot bind a file:line breakpoint inside a
        // suspending function at all: the rewriters that build MoveNext used to
        // drop every statement's syntax anchor, so the PDB held only hidden
        // sequence points and netcoredbg answered "no executable code is
        // associated with this line".
        const string Source = """
            package P0174Lines
            func Pipe() int32 {
                let ch = chan[int32](1)
                ch <- 20
                let v = <-ch
                var sum = v + 1
                return sum
            }
            Pipe()
            """;

        var visibleLines = VisibleSequencePointLines(Source, method => method.StartsWith("<Pipe>d__", StringComparison.Ordinal));

        Assert.Equal(new[] { 3, 4, 5, 6, 7 }, visibleLines);
    }

    [Fact]
    public void Pdb_MoveNext_CarriesOneYieldResumePairPerAwait()
    {
        const string source = """
            package P0174Pdb
            suspend func sum2(ch in chan[int32]) int32 {
                let a = <-ch
                let b = <-ch
                return a + b
            }
            let ch = chan[int32](2)
            ch <- 1
            ch <- 2
            sum2(ch)
            """;

        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var emitted = compilation.Emit(peStream, pdbStream, null);
        Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        pdbStream.Position = 0;
        using var peReader = new PEReader(peStream);
        var pe = peReader.GetMetadataReader();
        using var pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var pdb = pdbProvider.GetMetadataReader();

        var blobs = new Dictionary<string, (int Rid, int CatchHandlerPlusOne, List<(int Yield, int Resume, int ResumeRid)> Awaits)>();
        foreach (var handle in pdb.CustomDebugInformation)
        {
            var row = pdb.GetCustomDebugInformation(handle);
            if (pdb.GetGuid(row.Kind) != AsyncMethodSteppingInformationKind)
            {
                continue;
            }

            Assert.Equal(HandleKind.MethodDefinition, row.Parent.Kind);
            var methodHandle = (MethodDefinitionHandle)row.Parent;
            var method = pe.GetMethodDefinition(methodHandle);
            var declaringType = pe.GetTypeDefinition(method.GetDeclaringType());
            var owner = pe.GetString(declaringType.Name);
            Assert.Equal("MoveNext", pe.GetString(method.Name));

            var reader = pdb.GetBlobReader(row.Value);
            var catchPlusOne = (int)reader.ReadUInt32();
            var awaits = new List<(int Yield, int Resume, int ResumeRid)>();
            while (reader.RemainingBytes > 0)
            {
                awaits.Add(((int)reader.ReadUInt32(), (int)reader.ReadUInt32(), reader.ReadCompressedInteger()));
            }

            blobs[owner] = (MetadataTokens.GetRowNumber(methodHandle), catchPlusOne, awaits);
        }

        var sum2 = Assert.Single(blobs, kv => kv.Key.StartsWith("<sum2>d__", StringComparison.Ordinal)).Value;
        Assert.Equal(2, sum2.Awaits.Count);
        Assert.True(sum2.CatchHandlerPlusOne > 0, "the MoveNext catch handler that routes to SetException is recorded");
        foreach (var (yieldOffset, resumeOffset, resumeRid) in sum2.Awaits)
        {
            Assert.True(yieldOffset < resumeOffset, $"yield {yieldOffset} precedes resume {resumeOffset}");
            Assert.True(resumeOffset < sum2.CatchHandlerPlusOne - 1, "the awaits sit inside the protected body, before its catch handler");
            Assert.Equal(sum2.Rid, resumeRid);
        }

        Assert.True(sum2.Awaits[0].Resume <= sum2.Awaits[1].Yield, "awaits are recorded in state order");
    }

    // The distinct, ordered source lines a type's methods report as visible
    // (non-hidden) sequence points in the emitted Portable PDB.
    private static int[] VisibleSequencePointLines(string source, Func<string, bool> declaringTypeFilter)
    {
        using var peStream = new MemoryStream();
        using var pdbStream = new MemoryStream();
        var compilation = new Compilation(SyntaxTree.Parse(SourceText.From(source, "main.gs")))
        {
            DebugInformation = new DebugInformationOptions { Format = DebugInformationFormat.Portable },
        };
        var emitted = compilation.Emit(peStream, pdbStream, null);
        Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics.Select(d => d.Message)));

        peStream.Position = 0;
        pdbStream.Position = 0;
        using var peReader = new PEReader(peStream);
        var pe = peReader.GetMetadataReader();
        using var pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream);
        var pdb = pdbProvider.GetMetadataReader();

        var lines = new SortedSet<int>();
        foreach (var handle in pdb.MethodDebugInformation)
        {
            var info = pdb.GetMethodDebugInformation(handle);
            if (info.SequencePointsBlob.IsNil)
            {
                continue;
            }

            var methodHandle = handle.ToDefinitionHandle();
            if (MetadataTokens.GetRowNumber(methodHandle) > pe.GetTableRowCount(TableIndex.MethodDef))
            {
                continue;
            }

            var declaringType = pe.GetTypeDefinition(pe.GetMethodDefinition(methodHandle).GetDeclaringType());
            if (!declaringTypeFilter(pe.GetString(declaringType.Name)))
            {
                continue;
            }

            foreach (var point in info.GetSequencePoints())
            {
                if (!point.IsHidden)
                {
                    lines.Add(point.StartLine);
                }
            }
        }

        return lines.ToArray();
    }
}
