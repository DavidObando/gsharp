// <copyright file="Issue3015ImportedBaseIdentityTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Interpreter.Tests

import GSharp.Compiler
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Repl
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import Xunit

/// Issue #3015: imported-base backing objects must retain the derived G# type
/// identity without breaking inherited CLR member dispatch.
open class Issue3015ImportedBaseIdentityTests {
    @Fact
    func OrdinaryConstruction_PreservesDerivedTypeIdentity() {
        const Source = `package Issue3015.Identity
import System

class OrdinarySentinel : EventArgs {
}

var value = OrdinarySentinel()
Console.WriteLine(value.ToString())
Console.WriteLine(value.GetType().FullName)`
        Assert.Equal(
            "Issue3015.Identity.OrdinarySentinel${Environment.NewLine}Issue3015.Identity.OrdinarySentinel${Environment.NewLine}",
            Evaluate(Source)
        )
    }

    @Fact
    func LiteralConstruction_PreservesDerivedTypeIdentity() {
        const Source = `package Issue3015.Identity
import System

class LiteralSentinel : EventArgs {
}

var value = LiteralSentinel{}
Console.WriteLine(value.ToString())
Console.WriteLine(value.GetType().FullName)`
        Assert.Equal(
            "Issue3015.Identity.LiteralSentinel${Environment.NewLine}Issue3015.Identity.LiteralSentinel${Environment.NewLine}",
            Evaluate(Source)
        )
    }

    @Fact
    func OrdinaryConstruction_PreservesImportedBaseMemberDispatch() {
        const Source = `package Issue3015.Bridge
import System
import System.IO

class OrdinaryBuffer : MemoryStream {
}

Console.WriteLine(OrdinaryBuffer().CanRead)`
        Assert.Equal("True${Environment.NewLine}", Evaluate(Source))
    }

    @Fact
    func LiteralConstruction_PreservesImportedBaseMemberDispatch() {
        const Source = `package Issue3015.Bridge
import System
import System.IO

class LiteralBuffer : MemoryStream {
}

Console.WriteLine(LiteralBuffer{}.CanRead)`
        Assert.Equal("True${Environment.NewLine}", Evaluate(Source))
    }

    @Fact
    func ExplicitImportedBaseConstructor_PreservesStateAndIdentity() {
        const Source = `package Issue3015.Constructor
import System

class MessageSentinel(message string) : Exception(message) {
}

var value = MessageSentinel("explicit-state-3015")
Console.WriteLine(value.Message)
Console.WriteLine(value.GetType().FullName)`
        Assert.Equal(
            "explicit-state-3015${Environment.NewLine}Issue3015.Constructor.MessageSentinel${Environment.NewLine}",
            Evaluate(Source)
        )
    }

    @Fact
    func OverloadedBaseConstructors_ShareOneDerivedRuntimeType() {
        const Source = `package Issue3015.Constructor
import System
import GSharp.Interpreter.Tests

class OverloadedSentinel : Issue3015OverloadedBase {
    init() : base() {
    }

    init(label string) : base(label) {
    }
}

var first = OverloadedSentinel()
var second = OverloadedSentinel("explicit-3015")
Console.WriteLine(first.Label)
Console.WriteLine(second.Label)
Console.WriteLine(first.GetType().FullName)
Console.WriteLine(Object.ReferenceEquals(first.GetType(), second.GetType()))`
        Assert.Equal(
            "default-3015${Environment.NewLine}explicit-3015${Environment.NewLine}Issue3015.Constructor.OverloadedSentinel${Environment.NewLine}True${Environment.NewLine}",
            Evaluate(Source)
        )
    }

    @Fact
    func GenericConstruction_PreservesConstructedTypeIdentity() {
        const Source = `package Issue3015.Generic
import System

class OrdinaryGenericSentinel[T] : EventArgs {
}

class LiteralGenericSentinel[T] : EventArgs {
}

Console.WriteLine(OrdinaryGenericSentinel[int32]().ToString())
Console.WriteLine(LiteralGenericSentinel[string]{}.ToString())`
        Assert.Equal(
            "Issue3015.Generic.OrdinaryGenericSentinel`1[System.Int32]${Environment.NewLine}" +
                "Issue3015.Generic.LiteralGenericSentinel`1[System.String]${Environment.NewLine}",
            Evaluate(Source)
        )
    }

    @Fact
    func NullableGenericConstruction_PreservesNullableTypeArgument() {
        const Source = `package Issue3015.NullableGeneric
import System

class Box[T] : EventArgs {
}

var value = Box[int32?]()
Console.WriteLine(value.GetType().FullName)`
        let output = Evaluate(Source)
        Assert.Contains("Issue3015.NullableGeneric.Box`1", output)
        Assert.Contains("System.Nullable`1", output)
    }

    @Fact
    func ExplicitEmitAndOracle_AgreeOnDerivedRuntimeType() {
        const Source = `package Issue3015.CompilerDriver
import System

class Sentinel : EventArgs {
}

var value = Sentinel()
Console.WriteLine(value.GetType().FullName)`
        let oracleTypeName = Evaluate(Source).Trim()
        let artifactDirectory = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            "issue3015-${Guid.NewGuid():N}"
        )
        Directory.CreateDirectory(artifactDirectory)
        let sourcePath = Path.Combine(artifactDirectory, "Issue3015.gs")
        let assemblyPath = Path.Combine(artifactDirectory, "Issue3015.dll")
        try {
            File.WriteAllText(sourcePath, Source)
            let exit = GSharp
                .Compiler
                .Program
                .Main([]string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", sourcePath})
            Assert.Equal(0, exit)
            let emittedTypeName = CollectibleAssembly.Inspect(
                assemblyPath,
                (assembly Assembly) -> Assert.Single(
                    assembly.GetTypes(),
                    (type Type) -> type.FullName == "Issue3015.CompilerDriver.Sentinel"
                )
                    .FullName
            )
            Assert.Equal(emittedTypeName, oracleTypeName)
        } finally {
            Directory.Delete(artifactDirectory, recursive: true)
        }
    }

    @Fact
    func NestedConstruction_PreservesContainingTypeIdentity() {
        const Source = `package Issue3015.Nested
import System

class Outer {
    class OrdinaryNestedSentinel : EventArgs {
    }

    class LiteralNestedSentinel : EventArgs {
    }
}

Console.WriteLine(Outer.OrdinaryNestedSentinel().ToString())
Console.WriteLine(Outer.LiteralNestedSentinel{}.ToString())`
        Assert.Equal(
            "Issue3015.Nested.Outer+OrdinaryNestedSentinel${Environment.NewLine}" +
                "Issue3015.Nested.Outer+LiteralNestedSentinel${Environment.NewLine}",
            Evaluate(Source)
        )
    }

    @Fact
    func GenericTypeArguments_AgreeAcrossEmittedDrivers() {
        const Source = `package Issue3015.GenericDrivers
import System

class Payload {
}

class Box[T] : EventArgs {
}

Console.WriteLine(Box[Payload]().GetType().FullName)
Console.WriteLine(Box[string]().GetType().FullName)
Console.WriteLine(Box[Box[Payload]]().GetType().FullName)`
        const Expected = (`Issue3015.GenericDrivers.Box` + "`" + `1[[Issue3015.GenericDrivers.Payload]]
Issue3015.GenericDrivers.Box` + "`" + `1[[System.String]]
Issue3015.GenericDrivers.Box` + "`" + `1[[Issue3015.GenericDrivers.Box` + "`" + `1[[Issue3015.GenericDrivers.Payload]]]]
`)
        let root = Path.Combine(
            GetRepositoryRoot(),
            "out",
            "test-artifacts",
            "issue3015-generic-drivers-${Guid.NewGuid():N}"
        )
        try {
            var gscScript = RunSourceDriver(Path.Combine(root, "gsc-script"), Source, GSharp.Compiler.Program.Main)
            Assert.EndsWith("Success.${Environment.NewLine}", gscScript)
            gscScript = gscScript[.. ^"Success.${Environment.NewLine}".Length]
            let gsiScript = RunSourceDriver(Path.Combine(root, "gsi"), Source, GSharp.Repl.Program.Main)
            let emitDirectory = Path.Combine(root, "gsc-emit")
            Directory.CreateDirectory(emitDirectory)
            let emitSourcePath = Path.Combine(emitDirectory, "GenericDrivers.gs")
            let assemblyPath = Path.Combine(emitDirectory, "GenericDrivers-${Guid.NewGuid():N}.dll")
            File.WriteAllText(emitSourcePath, Source)
            let _ = CaptureDriver(
                () -> GSharp
                    .Compiler
                    .Program
                    .Main([]string{"/out:" + assemblyPath, "/target:exe", "/targetframework:net10.0", emitSourcePath})
            )
            let explicitEmit = CollectibleAssembly.Inspect(
                assemblyPath,
                (assembly Assembly) -> {
                    Assert.NotEmpty(assembly.GetTypes())
                    let entryPoint = assembly.EntryPoint ??
                        throw InvalidOperationException("Emitted assembly has no entry point.")
                    return CaptureDriver(
                        () -> {
                            entryPoint.Invoke(
                                nil,
                                if entryPoint.GetParameters().Length == 0 {
                                    default([]?object)
                                } else {
                                    []object{Array.Empty[string]()}
                                }
                            )
                            return 0
                        }
                    )
                }
            )
            Assert.Equal(Expected, NormalizeGenericTypeNames(gscScript))
            Assert.Equal(Expected, NormalizeGenericTypeNames(explicitEmit))
            Assert.Equal(Expected, NormalizeGenericTypeNames(gsiScript))
        } finally {
            if Directory.Exists(root) {
                Directory.Delete(root, recursive: true)
            }
        }
    }

    @Fact
    func ProtectedParameterizedBaseConstructor_PreservesStateAndIdentity() {
        const Source = `package Issue3015.ProtectedConstructor
import System
import GSharp.Interpreter.Tests

class ProtectedSentinel(value int32) : Issue3015ProtectedParameterizedBase(value) {
}

var instance = ProtectedSentinel(37)
Console.WriteLine(instance.Value)
Console.WriteLine(instance.GetType().FullName)`
        Assert.Equal(
            "37${Environment.NewLine}Issue3015.ProtectedConstructor.ProtectedSentinel${Environment.NewLine}",
            Evaluate(Source)
        )
    }

    shared {
        private func Evaluate(source string) string {
            let result = EmittedOracle.Evaluate(source)
            let errors = result.Diagnostics.Where((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.IsError).ToArray()
            Assert.True(
                errors.Length == 0,
                "evaluation failed:\n" + string.Join(
                    "\n",
                    errors.Select((d GSharp.Core.CodeAnalysis.Diagnostic) -> d.ToString())
                )
            )
            return result.Output.ReplaceLineEndings(Environment.NewLine)
        }

        private func RunSourceDriver(directory string, source string, driver([]string) -> int32) string {
            Directory.CreateDirectory(directory)
            let sourcePath = Path.Combine(directory, "Probe.gs")
            File.WriteAllText(sourcePath, source)
            return CaptureDriver(() -> driver([]string{sourcePath}))
        }

        private func CaptureDriver(driver() -> int32) string {
            using let stdout = StringWriter()
            using let stderr = StringWriter()
            let previousOut = Console.Out
            let previousError = Console.Error
            Console.SetOut(stdout)
            Console.SetError(stderr)
            var exit int32
            try {
                exit = driver()
            } finally {
                Console.SetOut(previousOut)
                Console.SetError(previousError)
            }
            Assert.True(exit == 0, (`driver failed with exit ` + "$exit" + `
stdout:
` + "$stdout" + `
stderr:
` + "$stderr"))
            return stdout.ToString().ReplaceLineEndings(Environment.NewLine)
        }

        private func NormalizeGenericTypeNames(output string) string {
            return Regex.Replace(
                output,
                ", [^,\\[\\]]+, Version=[^,\\[\\]]+, Culture=[^,\\[\\]]+, PublicKeyToken=[^,\\[\\]]+",
                string.Empty,
                RegexOptions.CultureInvariant
            )
        }

        private func GetRepositoryRoot() string {
            var directory DirectoryInfo? = DirectoryInfo(AppContext.BaseDirectory)
            while directory != nil && !RepositoryRootMarker.IsRoot(directory.FullName) {
                directory = directory.Parent
            }
            return directory?.FullName ?? throw InvalidOperationException("Could not locate repository root.")
        }
    }
}

/// Imported constructor-overload probe for issue #3015.
open class Issue3015OverloadedBase {
    /// Initializes a new instance of the (cref:Issue3015OverloadedBase) class.
    init() {
        Label = "default-3015"
    }

    /// Initializes a new instance of the (cref:Issue3015OverloadedBase) class.
    /// @param label Probe label.
    init(label string) {
        Label = label
    }

    /// Gets constructor probe label.
    prop Label string {
        get;
    }
}

/// Issue #4130: a real (never-instantiated) C# subclass of
/// (cref:Issue3015OverloadedBase). (cref:OverloadedBaseConstructors_ShareOneDerivedRuntimeType)'s
/// actual subclass (`OverloadedSentinel`) exists only inside the G#
/// source string that `EmittedOracle.Evaluate` compiles at test time
/// — invisible to Roslyn, and therefore invisible to cs2gs's
/// `subclassedBases` heuristic (`CSharpToGSharpTranslator.
/// Declarations.cs`) for deciding whether a translated class needs G#'s
/// `open` modifier. (cref:Issue3015ProtectedParameterizedBase)
/// escapes this gap by accident — its constructor is `protected`,
/// a second, independent signal the same heuristic honors — but
/// (cref:Issue3015OverloadedBase) has only `public` members,
/// so without a real subclass the migrated build compiles it as a plain
/// (ADR-0017 default CLR-`sealed`) class. The G# fixture's
/// `class OverloadedSentinel : Issue3015OverloadedBase` then fails to
/// resolve its base: `DeclarationBinder.Structs.cs`'s imported-base-type
/// branch only accepts `clrType.IsClass && !clrType.IsSealed`, and a
/// sealed imported class falls through every explicit case to the generic
/// `GS0157` diagnostic — "Cannot find type Issue3015OverloadedBase. Are
/// you missing an import?" — exactly the failure #4130 reported, cascading
/// into "requires an explicit base class" and "Cannot find member Label".
/// This type's only job is to give cs2gs the same signal
/// (cref:Issue3015ProtectedParameterizedBase) gets for free, so the
/// migrated `Issue3015OverloadedBase` is translated `open class`
/// and stays subclassable at runtime, matching the fixture it actually has
/// to support.
internal class Issue3015OverloadedBaseOpenSignal : Issue3015OverloadedBase { }

/// Imported protected-constructor probe for issue #3015.
open class Issue3015ProtectedParameterizedBase {
    /// Initializes a new instance of the (cref:Issue3015ProtectedParameterizedBase) class.
    /// @param value Probe value.
    protected init(value int32) {
        Value = value
    }

    /// Gets constructor probe value.
    prop Value int32 {
        get;
    }
}
