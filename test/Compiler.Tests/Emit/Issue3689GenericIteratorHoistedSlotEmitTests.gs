// <copyright file="Issue3689GenericIteratorHoistedSlotEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #3689: a generic iterator with nested `for` loops emitted
/// unverifiable IL. Every lowered `for` introduces an enumerator temp
/// named `$enum`, and the iterator state-machine builder derived the
/// hoisted slot name directly from the local name — so two slots of different
/// types both landed on `<>5__$enum`. A generic state machine
/// resolves its field MemberRefs by NAME
/// (`UserTokenResolver.GetUserStructFieldRef`), so both references
/// collapsed onto the first slot's signature and ilverify reported
/// `StackUnexpected` (found `IEnumerator<Node>`, expected
/// `IEnumerator<T>`).
///
/// This is the reduction of `SemanticLookup.FindNodes<T>` from the
/// migrated `src/LanguageServer`: a constrained generic iterator that
/// type-tests against its own type parameter, walks children with a
/// `for` loop, and recurses.
@Collection("Issue3689Console")
open class Issue3689GenericIteratorHoistedSlotEmitTests {
    @Fact
    func PatternVariableUsedAfterYield_IsHoisted() {
        const source = `package Issue3724.IteratorPattern
import System

class Box {
    var Value int32 = 7
}

func Values(value object) sequence[int32] {
    switch value {
        case box is Box {
            yield box.Value
            yield box.Value + 1
        }
    }
}

for value in Values(Box()) {
    Console.WriteLine(value)
}`
        let directory = CreateDirectory("pattern-variable")
        try {
            let assemblyPath = Compile(source, directory)
            IlVerifier.Verify(assemblyPath)
            Assert.Equal("7" + Environment.NewLine + "8" + Environment.NewLine, Run(assemblyPath, directory))
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Fact
    func GenericIteratorWithNestedLoops_EmitsVerifiableIlAndYieldsMatchingNodes() {
        let directory = CreateDirectory("find-nodes")
        try {
            let assemblyPath = Compile(FindNodesSource, directory)
            // Before the fix this reported StackUnexpected inside
            // `Finder+<FindNodes>d__N`1::MoveNext()`.
            IlVerifier.Verify(assemblyPath)
            // A verifiable-but-wrong lowering would be worse than the bug, so
            // assert the iterator actually walks the tree in document order.
            Assert.Equal("a" + Environment.NewLine + "b" + Environment.NewLine, Run(assemblyPath, directory))
        } finally {
            DeleteDirectory(directory)
        }
    }

    @Fact
    func GenericIteratorStateMachine_HoistsEachLocalIntoADistinctSlot() {
        let directory = CreateDirectory("slot-names")
        try {
            let assemblyPath = Compile(FindNodesSource, directory)
            using let stream = File.OpenRead(assemblyPath)
            using let peReader = PEReader(stream)
            let metadata = peReader.GetMetadataReader()
            var stateMachineCount = 0
            for handle in metadata.TypeDefinitions {
                let typeDefinition = metadata.GetTypeDefinition(handle)
                if !metadata.GetString(typeDefinition.Name).StartsWith("<FindNodes>d__", StringComparison.Ordinal) {
                    continue
                }
                stateMachineCount++
                let names = typeDefinition
                    .GetFields()
                    .Select(
                    (field FieldDefinitionHandle) -> metadata.GetString(metadata.GetFieldDefinition(field).Name)
                )
                    .ToArray()
                Assert.Equal(names.Length, names.Distinct(StringComparer.Ordinal).Count())
            }
            Assert.NotEqual(0, stateMachineCount)
        } finally {
            DeleteDirectory(directory)
        }
    }

    shared {
        private const FindNodesSource string = `package Issue3689.GenericIterator
import System
import System.Collections.Generic

open class Node {
    var Children List[Node] = List[Node]()

    func GetChildren() sequence[Node] {
        for child in Children {
            yield child
        }
    }
}

class Leaf : Node {
    var Name string = "leaf"
}

class Finder {
    shared {
        func FindNodes[T Node](root Node) sequence[T] {
            if root is T matched {
                yield matched
            }

            for child in root.GetChildren() {
                for descendant in FindNodes[T](child) {
                    yield descendant
                }
            }
        }
    }
}

let leafA = Leaf()
leafA.Name = "a"
let leafB = Leaf()
leafB.Name = "b"
let mid = Node()
mid.Children.Add(leafB)
let root = Node()
root.Children.Add(leafA)
root.Children.Add(mid)

for leaf in Finder.FindNodes[Leaf](root) {
    Console.WriteLine(leaf.Name)
}`

        private func Compile(source string, directory string) string {
            let sourcePath = Path.Combine(directory, "probe.gs")
            let assemblyPath = Path.Combine(directory, "probe.dll")
            File.WriteAllText(sourcePath, source)
            Assert.Equal(
                0,
                Program.Main([]string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath})
            )
            return assemblyPath
        }

        private func Run(assemblyPath string, directory string) string {
            using let process = Process.Start(
                ProcessStartInfo("dotnet"){
                    ArgumentList = {
                        "exec",
                        "--runtimeconfig",
                        Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                        assemblyPath
                    },
                    WorkingDirectory = directory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
            ) ??
                throw InvalidOperationException("Failed to start dotnet child process.")
            let stdoutTask = process.StandardOutput.ReadToEndAsync()
            let stderrTask = process.StandardError.ReadToEndAsync()
            if !process.WaitForExit(30_000) {
                process.Kill(entireProcessTree: true)
                process.WaitForExit()
                throw TimeoutException("dotnet child process timed out.")
            }
            let stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine)
            let stderr = stderrTask.GetAwaiter().GetResult()
            Assert.True(process.ExitCode == 0, (`dotnet exited ` + "${process.ExitCode}" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout
        }

        private func CreateDirectory(name string) string -> Directory.CreateDirectory(
            Path.Combine(AppContext.BaseDirectory, "issue3689", name + "-" + Guid.NewGuid().ToString("N"))
        )
            .FullName

        private func DeleteDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch { }
        }
    }
}

@CollectionDefinition("Issue3689Console", DisableParallelization = true)
class Issue3689ConsoleCollection { }
