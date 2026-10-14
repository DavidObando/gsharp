// <copyright file="Adr0174AsyncDebugInfoTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Runtime.CompilerServices
import Xunit

/// ADR-0174 P3-8, the debugging gate for inferred suspension: a suspending or
/// async kickoff carries `[AsyncStateMachine(typeof(SM))]` (so the
/// runtime's `StackTrace` and a debugger name the logical function, not
/// `<f>d__1.MoveNext`) and `[DebuggerStepThrough]`; the
/// Portable PDB carries an async-method-stepping blob for every
/// `MoveNext` with one yield/resume offset pair per await and the
/// outermost catch handler, which is what a debugger's step-over uses to
/// land on the next source line across a parked channel receive.
/// @remarks Discrimination witnesses (ADR-0154): a mutant that serializes the state
/// machine's name without its enclosing type breaks
/// (cref:Kickoff_CarriesAsyncStateMachineAttribute_ResolvingToItsStateMachine)
/// (the attribute's `StateMachineType` fails to resolve) and
/// (cref:StackTrace_InsideASuspendingFunction_NamesTheLogicalFunction);
/// a mutant that records only yield offsets breaks
/// (cref:Pdb_MoveNext_CarriesOneYieldResumePairPerAwait).
open class Adr0174AsyncDebugInfoTests {
    @Fact
    func Kickoff_CarriesAsyncStateMachineAttribute_ResolvingToItsStateMachine() {
        let result = EmittedOracle.Evaluate(`package P0174Dbg
suspend func take(ch in chan[int32]) int32 {
    return <-ch
}
async func twice(n int32) int32 {
    return n * 2
}
let ch = chan[int32](1)
ch <- 4
take(ch)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(4, result.Value)
        let program = Assert.IsAssignableFrom[Type](result.Assembly!!.GetType("P0174Dbg.<Program>"))
        for name in[]string{"take", "twice"} {
            let kickoff MethodInfo? = program.GetMethod(
                name,
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            )
            Assert.NotNull(kickoff)
            let stateMachine AsyncStateMachineAttribute? = kickoff!!.GetCustomAttribute[AsyncStateMachineAttribute]()
            Assert.NotNull(stateMachine)
            Assert.StartsWith("<" + name + ">d__", stateMachine!!.StateMachineType.Name)
            Assert.Same(program, stateMachine!!.StateMachineType.DeclaringType)
            Assert.NotNull(kickoff!!.GetCustomAttribute[DebuggerStepThroughAttribute]())
        }
    }

    @Fact
    func Kickoff_Attribute_ResolvesForMethods_Generics_AndLambdas() {
        // The serialized state-machine name must follow the struct's nesting:
        // a user class for a method, `<Program>` with the arity suffix for a
        // generic function, and the display class for an async lambda.
        let result = EmittedOracle.Evaluate(`package P0174DbgNest
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
r.Take(ch) + first[int32](ch) + viaLambda(2)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(14, result.Value)
        let resolved = List[string]()
        for type in result.Assembly!!.GetTypes() {
            for method in type.GetMethods(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly
            ) {
                let attribute AsyncStateMachineAttribute? = method.GetCustomAttribute[AsyncStateMachineAttribute]()
                if attribute != nil {
                    Assert.NotNull(attribute.StateMachineType)
                    Assert.Same(type, attribute.StateMachineType.DeclaringType)
                    resolved.Add(attribute.StateMachineType.Name)
                }
            }
        }
        Assert.Contains(resolved, (name string) -> name.StartsWith("<Take>d__", StringComparison.Ordinal))
        Assert.Contains(
            resolved,
            (name string) -> name.StartsWith("<first>d__", StringComparison.Ordinal) && name.EndsWith(
                "`1",
                StringComparison.Ordinal
            )
        )
        Assert.Equal(3, resolved.Count)
    }

    @Fact
    func StackTrace_InsideASuspendingFunction_NamesTheLogicalFunction() {
        let result = EmittedOracle.Evaluate(`package P0174Trace
import System
suspend func inner(ch in chan[int32]) string {
    let v = <-ch
    return Environment.StackTrace
}
let ch = chan[int32](1)
ch <- 1
inner(ch)`)
        Assert.Empty(result.Diagnostics)
        let trace = Assert.IsType[string](result.Value)
        Assert.Contains("P0174Trace.<Program>.inner(", trace, StringComparison.Ordinal)
        Assert.DoesNotContain("d__", trace, StringComparison.Ordinal)
    }

    @Fact
    func Pdb_MoveNext_MapsEverySourceLineOfTheSuspendingBody() {
        // Without this, a debugger cannot bind a file:line breakpoint inside a
        // suspending function at all: the rewriters that build MoveNext used to
        // drop every statement's syntax anchor, so the PDB held only hidden
        // sequence points and netcoredbg answered "no executable code is
        // associated with this line".
        const Source = `package P0174Lines
func Pipe() int32 {
    let ch = chan[int32](1)
    ch <- 20
    let v = <-ch
    var sum = v + 1
    return sum
}
Pipe()`
        let visibleLines = VisibleSequencePointLines(
            Source,
            (method string) -> method.StartsWith("<Pipe>d__", StringComparison.Ordinal)
        )
        Assert.Equal([]int32{3, 4, 5, 6, 7}, visibleLines)
    }

    @Fact
    func Pdb_MoveNext_CarriesOneYieldResumePairPerAwait() {
        const source = `package P0174Pdb
suspend func sum2(ch in chan[int32]) int32 {
    let a = <-ch
    let b = <-ch
    return a + b
}
let ch = chan[int32](2)
ch <- 1
ch <- 2
sum2(ch)`
        using let peStream = MemoryStream()
        using let pdbStream = MemoryStream()
        let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source, "main.gs"))){
            DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
        }
        let emitted = compilation.Emit(peStream, pdbStream, nil)
        Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics.Select((d Diagnostic) -> d.Message)))
        peStream.Position = 0
        pdbStream.Position = 0
        using let peReader = PEReader(peStream)
        let pe = peReader.GetMetadataReader()
        using let pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
        let pdb = pdbProvider.GetMetadataReader()
        let blobs = Dictionary[
            string,
            (Rid int32, CatchHandlerPlusOne int32, Awaits List[(Yield int32, Resume int32, ResumeRid int32)])
        ]()
        for handle in pdb.CustomDebugInformation {
            let row = pdb.GetCustomDebugInformation(handle)
            if pdb.GetGuid(row.Kind) != AsyncMethodSteppingInformationKind {
                continue
            }
            Assert.Equal(HandleKind.MethodDefinition, row.Parent.Kind)
            let methodHandle = MethodDefinitionHandle(row.Parent)
            let method = pe.GetMethodDefinition(methodHandle)
            let declaringType = pe.GetTypeDefinition(method.GetDeclaringType())
            let owner = pe.GetString(declaringType.Name)
            Assert.Equal("MoveNext", pe.GetString(method.Name))
            var reader = pdb.GetBlobReader(row.Value)
            let catchPlusOne = int32(reader.ReadUInt32())
            let awaits = List[(Yield int32, Resume int32, ResumeRid int32)]()
            while reader.RemainingBytes > 0 {
                awaits.Add((int32(reader.ReadUInt32()), int32(reader.ReadUInt32()), reader.ReadCompressedInteger()))
            }
            blobs[owner] = (MetadataTokens.GetRowNumber(methodHandle), catchPlusOne, awaits)
        }
        let sum2 = Assert.Single(
            blobs,
            (
                kv KeyValuePair[
                    string,
                    (Rid int32, CatchHandlerPlusOne int32, Awaits List[(Yield int32, Resume int32, ResumeRid int32)])
                ]
            ) -> kv
                .Key
                .StartsWith("<sum2>d__", StringComparison.Ordinal)
        )
            .Value
        Assert.Equal(2, sum2.Awaits.Count)
        Assert.True(sum2.CatchHandlerPlusOne > 0, "the MoveNext catch handler that routes to SetException is recorded")
        for (yieldOffset, resumeOffset, resumeRid) in sum2.Awaits {
            Assert.True(yieldOffset < resumeOffset, "yield $yieldOffset precedes resume $resumeOffset")
            Assert.True(
                resumeOffset < sum2.CatchHandlerPlusOne - 1,
                "the awaits sit inside the protected body, before its catch handler"
            )
            Assert.Equal(sum2.Rid, resumeRid)
        }
        Assert.True(sum2.Awaits[0].Resume <= sum2.Awaits[1].Yield, "awaits are recorded in state order")
    }

    shared {
        private let AsyncMethodSteppingInformationKind Guid = Guid("54FD2AC5-E925-401A-9C2A-F94F171072F8")

        // The distinct, ordered source lines a type's methods report as visible
        // (non-hidden) sequence points in the emitted Portable PDB.
        private func VisibleSequencePointLines(source string, declaringTypeFilter(string) -> bool)[]int32 {
            using let peStream = MemoryStream()
            using let pdbStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source, "main.gs"))){
                DebugInformation = DebugInformationOptions{Format: DebugInformationFormat.Portable}
            }
            let emitted = compilation.Emit(peStream, pdbStream, nil)
            Assert.True(emitted.Success, string.Join("\n", emitted.Diagnostics.Select((d Diagnostic) -> d.Message)))
            peStream.Position = 0
            pdbStream.Position = 0
            using let peReader = PEReader(peStream)
            let pe = peReader.GetMetadataReader()
            using let pdbProvider = MetadataReaderProvider.FromPortablePdbStream(pdbStream)
            let pdb = pdbProvider.GetMetadataReader()
            let lines = SortedSet[int32]()
            for handle in pdb.MethodDebugInformation {
                let info = pdb.GetMethodDebugInformation(handle)
                if info.SequencePointsBlob.IsNil {
                    continue
                }
                let methodHandle = handle.ToDefinitionHandle()
                if MetadataTokens.GetRowNumber(methodHandle) > pe.GetTableRowCount(TableIndex.MethodDef) {
                    continue
                }
                let declaringType = pe.GetTypeDefinition(pe.GetMethodDefinition(methodHandle).GetDeclaringType())
                if !declaringTypeFilter(pe.GetString(declaringType.Name)) {
                    continue
                }
                for point in info.GetSequencePoints() {
                    if !point.IsHidden {
                        lines.Add(point.StartLine)
                    }
                }
            }
            return lines.ToArray()
        }
    }
}
