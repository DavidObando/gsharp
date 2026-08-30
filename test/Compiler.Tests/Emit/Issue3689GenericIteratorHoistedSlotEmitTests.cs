// <copyright file="Issue3689GenericIteratorHoistedSlotEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using GSharp.Compiler;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #3689: a generic iterator with nested <c>for</c> loops emitted
/// unverifiable IL. Every lowered <c>for</c> introduces an enumerator temp
/// named <c>$enum</c>, and the iterator state-machine builder derived the
/// hoisted slot name directly from the local name — so two slots of different
/// types both landed on <c>&lt;&gt;5__$enum</c>. A generic state machine
/// resolves its field MemberRefs by NAME
/// (<c>UserTokenResolver.GetUserStructFieldRef</c>), so both references
/// collapsed onto the first slot's signature and ilverify reported
/// <c>StackUnexpected</c> (found <c>IEnumerator&lt;Node&gt;</c>, expected
/// <c>IEnumerator&lt;T&gt;</c>).
///
/// This is the reduction of <c>SemanticLookup.FindNodes&lt;T&gt;</c> from the
/// migrated <c>src/LanguageServer</c>: a constrained generic iterator that
/// type-tests against its own type parameter, walks children with a
/// <c>for</c> loop, and recurses.
/// </summary>
[Collection("Issue3689Console")]
public class Issue3689GenericIteratorHoistedSlotEmitTests
{
    private const string FindNodesSource = """
        package Issue3689.GenericIterator
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
        }
        """;

    [Fact]
    public void GenericIteratorWithNestedLoops_EmitsVerifiableIlAndYieldsMatchingNodes()
    {
        var directory = CreateDirectory("find-nodes");
        try
        {
            var assemblyPath = Compile(FindNodesSource, directory);

            // Before the fix this reported StackUnexpected inside
            // `Finder+<FindNodes>d__N`1::MoveNext()`.
            IlVerifier.Verify(assemblyPath);

            // A verifiable-but-wrong lowering would be worse than the bug, so
            // assert the iterator actually walks the tree in document order.
            Assert.Equal(
                "a" + Environment.NewLine + "b" + Environment.NewLine,
                Run(assemblyPath, directory));
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    [Fact]
    public void GenericIteratorStateMachine_HoistsEachLocalIntoADistinctSlot()
    {
        var directory = CreateDirectory("slot-names");
        try
        {
            var assemblyPath = Compile(FindNodesSource, directory);

            using var stream = File.OpenRead(assemblyPath);
            using var peReader = new PEReader(stream);
            var metadata = peReader.GetMetadataReader();

            var stateMachineCount = 0;
            foreach (var handle in metadata.TypeDefinitions)
            {
                var typeDefinition = metadata.GetTypeDefinition(handle);
                if (!metadata.GetString(typeDefinition.Name)
                        .StartsWith("<FindNodes>d__", StringComparison.Ordinal))
                {
                    continue;
                }

                stateMachineCount++;
                var names = typeDefinition
                    .GetFields()
                    .Select(field => metadata.GetString(metadata.GetFieldDefinition(field).Name))
                    .ToArray();
                Assert.Equal(names.Length, names.Distinct(StringComparer.Ordinal).Count());
            }

            Assert.NotEqual(0, stateMachineCount);
        }
        finally
        {
            DeleteDirectory(directory);
        }
    }

    private static string Compile(string source, string directory)
    {
        var sourcePath = Path.Combine(directory, "probe.gs");
        var assemblyPath = Path.Combine(directory, "probe.dll");
        File.WriteAllText(sourcePath, source);

        Assert.Equal(
            0,
            Program.Main(
            [
                "/out:" + assemblyPath,
                "/target:exe",
                "/targetframework:net10.0",
                sourcePath,
            ]));
        return assemblyPath;
    }

    private static string Run(string assemblyPath, string directory)
    {
        using var process = Process.Start(new ProcessStartInfo("dotnet")
        {
            ArgumentList =
            {
                "exec",
                "--runtimeconfig",
                Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"),
                assemblyPath,
            },
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        }) ?? throw new InvalidOperationException("Failed to start dotnet child process.");

        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            throw new TimeoutException("dotnet child process timed out.");
        }

        var stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine);
        var stderr = stderrTask.GetAwaiter().GetResult();
        Assert.True(
            process.ExitCode == 0,
            $"dotnet exited {process.ExitCode}\nstdout:\n{stdout}\nstderr:\n{stderr}");
        return stdout;
    }

    private static string CreateDirectory(string name) =>
        Directory.CreateDirectory(
            Path.Combine(
                AppContext.BaseDirectory,
                "issue3689",
                name + "-" + Guid.NewGuid().ToString("N"))).FullName;

    private static void DeleteDirectory(string directory)
    {
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch
        {
        }
    }
}

[CollectionDefinition("Issue3689Console", DisableParallelization = true)]
public sealed class Issue3689ConsoleCollection
{
}
