// <copyright file="Issue4593ImportedBaseInterfaceReimplementationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using GSharp.Tests;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #4593: a class deriving from an imported base may re-list an
/// interface that base already implements (C# interface re-implementation).
/// The base's interface mapping satisfies every slot the derived class does
/// not re-map, including slots inherited from a base interface, so gsc must
/// not report GS0187 for them. A re-listed interface the base does NOT
/// implement still requires every abstract member.
/// </summary>
public sealed class Issue4593ImportedBaseInterfaceReimplementationTests
{
    private const string AcceptedSource = """
        package Issue4593
        import System
        import System.IO
        import System.Collections.Generic
        import System.Collections.ObjectModel

        public class Bag4593 : Collection[int32], IList[int32] {
        }

        public class Stream4593 : MemoryStream, IDisposable {
        }

        public func Probe4593() int32 {
            let bag = Bag4593()
            bag.Add(3)
            bag.Add(4)
            var list IList[int32] = bag
            var collection ICollection[int32] = bag
            var disposable IDisposable = Stream4593()
            disposable.Dispose()
            return collection.Count * 100 + list[1] * 10 + list.IndexOf(4)
        }
        """;

    private const string FieldRemapSource = """
        package Issue4593Field
        import System.Collections.Generic
        import System.Collections.ObjectModel

        public class FieldBag4593 : Collection[int32], ICollection[int32] {
            public var IsReadOnly bool = true
        }

        // IList[int32] inherits IsReadOnly from ICollection[int32]: the
        // inherited-property-slot path.
        public class FieldListBag4593 : Collection[int32], IList[int32] {
            public var IsReadOnly bool = true
        }

        public func ReadOnlyViaInterface4593() bool {
            var collection ICollection[int32] = FieldBag4593()
            return collection.IsReadOnly
        }

        """;

    private const string RejectedSource = """
        package Issue4593Control
        import System
        import System.IO

        public class Comparable4593 : MemoryStream, IComparable {
        }
        """;

    [Fact]
    public void ReListedInterface_ImplementedByImportedBase_CompilesAndDispatchesToBase()
    {
        var (exitCode, output, assemblyPath) = CompileLibrary(AcceptedSource, "Issue4593");
        try
        {
            Assert.True(exitCode == 0, $"gsc failed (exit {exitCode}):\n{output}");
            Assert.DoesNotContain("GS0187", output, StringComparison.Ordinal);
            IlVerifier.Verify(assemblyPath);

            var assembly = EmittedFixture.Load(assemblyPath);
            var bag = assembly.GetTypes().Single(type => type.Name == "Bag4593");
            Assert.Contains(typeof(System.Collections.Generic.IList<int>), bag.GetInterfaces());

            var probe = assembly.GetTypes()
                .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
                .Single(method => method.Name == "Probe4593");

            // Count (inherited ICollection[int32] property slot) = 2,
            // list[1] = 4, IndexOf(4) = 1: every slot binds to Collection<int>.
            Assert.Equal(241, probe.Invoke(null, null));
        }
        finally
        {
            DeleteDirectory(assemblyPath);
        }
    }

    [Fact]
    public void ReListedInterface_ImplementedByImportedBase_StillRemapsFieldBackedProperty()
    {
        // #573/#606: a public field satisfies a CLR property contract through a
        // synthesized property. The imported base satisfying the slot only
        // waives GS0187; the declared field must still re-map the slot.
        var (exitCode, output, assemblyPath) = CompileLibrary(FieldRemapSource, "Issue4593Field");
        try
        {
            Assert.True(exitCode == 0, $"gsc failed (exit {exitCode}):\n{output}");
            IlVerifier.Verify(assemblyPath);

            var assembly = EmittedFixture.Load(assemblyPath);
            var probes = assembly.GetTypes()
                .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static))
                .ToArray();

            // Collection<int>'s own IsReadOnly is false; the field says true.
            // Direct slot (ICollection[int32] declares IsReadOnly):
            Assert.Equal(true, probes.Single(method => method.Name == "ReadOnlyViaInterface4593").Invoke(null, null));

            // Inherited slot (IList[int32] inherits IsReadOnly from
            // ICollection[int32]): only the inherited-slot walk synthesizes
            // this property, so assert the synthesized PropertyDef and its
            // virtual getter. Runtime dispatch through ICollection[int32] is
            // not observable here: gsc emits no InterfaceImpl row for the
            // inherited interface, so the CLR keeps the base mapping (#4601).
            var fieldListBag = assembly.GetTypes().Single(type => type.Name == "FieldListBag4593");
            var synthesized = fieldListBag.GetProperty(
                "IsReadOnly",
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly);
            Assert.NotNull(synthesized);
            Assert.True(synthesized.GetMethod?.IsVirtual, "synthesized IsReadOnly getter must be virtual");
        }
        finally
        {
            DeleteDirectory(assemblyPath);
        }
    }

    [Fact]
    public void ReListedInterface_NotImplementedByImportedBase_StillReportsGs0187()
    {
        var (exitCode, output, assemblyPath) = CompileLibrary(RejectedSource, "Issue4593Control");
        try
        {
            Assert.NotEqual(0, exitCode);
            Assert.Contains(
                "(5,14,5,28): error GS0187: Class 'Comparable4593' does not implement interface method 'System.IComparable.CompareTo(object)'.",
                output,
                StringComparison.Ordinal);
        }
        finally
        {
            DeleteDirectory(assemblyPath);
        }
    }

    private static (int ExitCode, string Output, string AssemblyPath) CompileLibrary(string source, string assemblyName)
    {
        var outputDirectory = Path.Combine(
            AppContext.BaseDirectory,
            nameof(Issue4593ImportedBaseInterfaceReimplementationTests),
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outputDirectory);
        var sourcePath = Path.Combine(outputDirectory, "Program.gs");
        var assemblyPath = Path.Combine(outputDirectory, assemblyName + ".dll");
        File.WriteAllText(sourcePath, source);

        using var standardOut = new StringWriter();
        using var standardError = new StringWriter();
        var previousOut = Console.Out;
        var previousError = Console.Error;
        Console.SetOut(standardOut);
        Console.SetError(standardError);
        int exitCode;
        try
        {
            exitCode = Program.Main(new[]
            {
                "/out:" + assemblyPath,
                "/target:library",
                "/targetframework:net10.0",
                sourcePath,
            });
        }
        finally
        {
            Console.SetOut(previousOut);
            Console.SetError(previousError);
        }

        return (exitCode, standardOut + Environment.NewLine + standardError, assemblyPath);
    }

    private static void DeleteDirectory(string assemblyPath)
    {
        try
        {
            if (Path.GetDirectoryName(assemblyPath) is { } directory)
            {
                Directory.Delete(directory, recursive: true);
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
