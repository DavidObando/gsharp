// <copyright file="Issue4593ImportedBaseInterfaceReimplementationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import System.Linq
import System.Reflection
import GSharp.Tests
import Xunit
import GSharp.Compiler
import GSharp.Compiler.Tests
import System.Collections.Generic

/// Issue #4593: a class deriving from an imported base may re-list an
/// interface that base already implements (C# interface re-implementation).
/// The base's interface mapping satisfies every slot the derived class does
/// not re-map, including slots inherited from a base interface, so gsc must
/// not report GS0187 for them. A re-listed interface the base does NOT
/// implement still requires every abstract member.
class Issue4593ImportedBaseInterfaceReimplementationTests {
    @Fact
    func ReListedInterface_ImplementedByImportedBase_CompilesAndDispatchesToBase() {
        let (exitCode, output, assemblyPath) = CompileLibrary(AcceptedSource, "Issue4593")
        try {
            Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
` + "$output"))
            Assert.DoesNotContain("GS0187", output, StringComparison.Ordinal)
            IlVerifier.Verify(assemblyPath)
            let assembly = EmittedFixture.Load(assemblyPath)
            let bag = assembly.GetTypes().Single((type Type) -> type.Name == "Bag4593")
            Assert.Contains(typeof(IList[int32]), bag.GetInterfaces())
            let probe = assembly
                .GetTypes()
                .SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                }
            )
                .Single((method MethodInfo) -> method.Name == "Probe4593")
            // Count (inherited ICollection[int32] property slot) = 2,
            // list[1] = 4, IndexOf(4) = 1: every slot binds to Collection<int>.
            Assert.Equal(241, probe.Invoke(nil, nil))
        } finally {
            DeleteDirectory(assemblyPath)
        }
    }

    @Fact
    func ReListedInterface_ImplementedByImportedBase_StillRemapsFieldBackedProperty() {
        // #573/#606: a public field satisfies a CLR property contract through a
        // synthesized property. The imported base satisfying the slot only
        // waives GS0187; the declared field must still re-map the slot.
        let (exitCode, output, assemblyPath) = CompileLibrary(FieldRemapSource, "Issue4593Field")
        try {
            Assert.True(exitCode == 0, (`gsc failed (exit ` + "$exitCode" + `):
` + "$output"))
            IlVerifier.Verify(assemblyPath)
            let assembly = EmittedFixture.Load(assemblyPath)
            let probes = assembly
                .GetTypes()
                .SelectMany(
                func (type Type) IEnumerable[MethodInfo] {
                    return type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                }
            )
                .ToArray()
            // Collection<int>'s own IsReadOnly is false; the field says true.
            // Direct slot (ICollection[int32] declares IsReadOnly):
            Assert.Equal(
                true,
                probes.Single((method MethodInfo) -> method.Name == "ReadOnlyViaInterface4593").Invoke(nil, nil)
            )
            // Inherited slot (IList[int32] inherits IsReadOnly from
            // ICollection[int32]): only the inherited-slot walk synthesizes
            // this property, so assert the synthesized PropertyDef and its
            // virtual getter. Runtime dispatch through ICollection[int32] is
            // not observable here: gsc emits no InterfaceImpl row for the
            // inherited interface, so the CLR keeps the base mapping (#4601).
            let fieldListBag = assembly.GetTypes().Single((type Type) -> type.Name == "FieldListBag4593")
            let synthesized PropertyInfo? = fieldListBag.GetProperty(
                "IsReadOnly",
                BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
            )
            Assert.NotNull(synthesized)
            Assert.True(synthesized!!.GetMethod?.IsVirtual, "synthesized IsReadOnly getter must be virtual")
        } finally {
            DeleteDirectory(assemblyPath)
        }
    }

    @Fact
    func ReListedInterface_NotImplementedByImportedBase_StillReportsGs0187() {
        let (exitCode, output, assemblyPath) = CompileLibrary(RejectedSource, "Issue4593Control")
        try {
            Assert.NotEqual(0, exitCode)
            Assert.Contains(
                "(5,14,5,28): error GS0187: Class 'Comparable4593' does not implement interface method 'System.IComparable.CompareTo(object)'.",
                output,
                StringComparison.Ordinal
            )
        } finally {
            DeleteDirectory(assemblyPath)
        }
    }

    shared {
        private const AcceptedSource string = `package Issue4593
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
}`

        private const FieldRemapSource string = `package Issue4593Field
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
`

        private const RejectedSource string = `package Issue4593Control
import System
import System.IO

public class Comparable4593 : MemoryStream, IComparable {
}`

        private func CompileLibrary(source string, assemblyName string)(
            ExitCode int32,
            Output string,
            AssemblyPath string
        ) {
            let outputDirectory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue4593ImportedBaseInterfaceReimplementationTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(outputDirectory)
            let sourcePath = Path.Combine(outputDirectory, "Program.gs")
            let assemblyPath = Path.Combine(outputDirectory, assemblyName + ".dll")
            File.WriteAllText(sourcePath, source)
            using let standardOut = StringWriter()
            using let standardError = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(standardOut)
            Console.SetError(standardError)
            var exitCode int32
            try {
                exitCode = Program.Main(
                    []string{"/out:" + assemblyPath, "/target:library", "/targetframework:net10.0", sourcePath}
                )
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            return (exitCode, standardOut.ToString() + Environment.NewLine + standardError.ToString(), assemblyPath)
        }

        private func DeleteDirectory(assemblyPath string) {
            try {
                if Path.GetDirectoryName(assemblyPath) is {} directory {
                    Directory.Delete(directory, recursive: true)
                }
            } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
